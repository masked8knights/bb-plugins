// Provider source registry + auto-discovery.
//
// The *active* provider set is not hard-coded: each source knows where its
// store may live on disk, and `probeSources` discovers which stores actually
// exist (and whether BB has a matching provider for rehydration). The
// registry is the extensible seam — add a source here and it is
// auto-discovered, indexed, searchable, and rehydratable.
//
// Stores:
//  - codex:    ~/.codex/sessions/**/*.jsonl            (rollout event streams)
//  - claude:   ~/.claude/projects/**/*.jsonl           (Claude Code sessions)
//  - prime:    ~/.prime/agent/sessions/**/*.jsonl plus the hermes daemon
//              store ~/.hermes/state.db (SQLite: sessions / messages)
//  - opencode: ~/.local/share/opencode/opencode.db      (SQLite: session/message/part)
//  - omp:      ~/.omp/agent/sessions/<cwd>/*.jsonl      (omp agent event streams)

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexSettings } from "./types";

export type SourceKind = "codex" | "claude" | "prime" | "opencode" | "omp";
export type ProviderId = SourceKind;
export type StoreType = "jsonl" | "db" | "jsonl+db";

export interface ProviderSource {
  /** Canonical source id (used in the sessions table, filters, ids). */
  id: ProviderId;
  /** Human label for UI/CLI. */
  label: string;
  /** Dispatch key for parsers/indexer. */
  kind: SourceKind;
  /** BB provider id suggested for rehydration. */
  bbProviderId: string;
  /** BB provider ids that this source's sessions belong to. */
  covers: string[];
  /** UI badge classes. */
  badge: string;
  /** Candidate store locations to probe, in order. */
  defaultRoots: string[];
  /** Extra store the source also reads (e.g. prime's hermes db). */
  defaultDbPath?: string;
  storeType: StoreType;
}

export const PROVIDER_SOURCES: ProviderSource[] = [
  {
    id: "codex",
    label: "Codex",
    kind: "codex",
    bbProviderId: "codex",
    covers: ["codex"],
    badge: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
    defaultRoots: ["~/.codex/sessions"],
    storeType: "jsonl",
  },
  {
    id: "claude",
    label: "Claude Code",
    kind: "claude",
    bbProviderId: "claude-code",
    covers: ["claude-code"],
    badge: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    defaultRoots: ["~/.claude/projects"],
    storeType: "jsonl",
  },
  {
    id: "prime",
    label: "Pi / Prime Agent",
    kind: "prime",
    bbProviderId: "pi",
    covers: ["pi", "acp-prime-agent", "acp-hermes-agent"],
    badge: "bg-violet-500/15 text-violet-500 border-violet-500/30",
    defaultRoots: ["~/.prime/agent/sessions"],
    defaultDbPath: "~/.hermes/state.db",
    storeType: "jsonl+db",
  },
  {
    id: "opencode",
    label: "opencode",
    kind: "opencode",
    bbProviderId: "acp-opencode",
    covers: ["acp-opencode"],
    badge: "bg-sky-500/15 text-sky-500 border-sky-500/30",
    defaultRoots: ["~/.local/share/opencode/opencode.db"],
    storeType: "db",
  },
  {
    id: "omp",
    label: "omp",
    kind: "omp",
    bbProviderId: "acp-omp",
    covers: ["acp-omp"],
    badge: "bg-rose-500/15 text-rose-500 border-rose-500/30",
    defaultRoots: ["~/.omp/agent/sessions"],
    storeType: "jsonl",
  },
];

export const PROVIDER_IDS: ProviderId[] = PROVIDER_SOURCES.map((s) => s.id);

/** Source id → human label. */
export const PROVIDER_LABELS: Record<ProviderId, string> = Object.fromEntries(
  PROVIDER_SOURCES.map((s) => [s.id, s.label]),
) as Record<ProviderId, string>;

/** Source id → suggested BB provider id for rehydration. */
export const PROVIDER_DEFAULTS: Record<ProviderId, string> = Object.fromEntries(
  PROVIDER_SOURCES.map((s) => [s.id, s.bbProviderId]),
) as Record<ProviderId, string>;

export function isKnownProviderId(v: string): v is ProviderId {
  return PROVIDER_SOURCES.some((s) => s.id === v);
}

export function getSource(id: string): ProviderSource | undefined {
  return PROVIDER_SOURCES.find((s) => s.id === id);
}

/** True when a BB provider id is covered by one of our session sources. */
export function isCoveredBySource(bbProviderId: string): boolean {
  return PROVIDER_SOURCES.some((s) => s.covers.includes(bbProviderId));
}

export function resolveHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

export interface SourceProbe {
  id: ProviderId;
  label: string;
  kind: SourceKind;
  /** User toggle (settings). */
  enabled: boolean;
  /** A store with content was found on disk (or an override path exists). */
  detected: boolean;
  /** Resolved store root (override, or first existing default). */
  root: string | null;
  /** Cheap session/file count found in the store. */
  count: number;
  /** BB has a provider that can run this source's sessions. */
  supported: boolean;
  /** Suggested BB provider id. */
  bbProviderId: string;
}

/** Recursive *.jsonl file count (no stat — cheap enough for status). */
function countJsonl(root: string): number {
  let n = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && extname(e.name) === ".jsonl") n++;
    }
  }
  return n;
}

function countSqliteSessions(dbPath: string): number {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const r = db.prepare("SELECT COUNT(*) AS c FROM session").get() as
        | { c: number }
        | undefined;
      return r?.c ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

function settingsFor(source: ProviderSource, settings: IndexSettings) {
  const enabled = settings[`${source.id}Enabled`];
  const override = (settings[`${source.id}Path`] ?? "").trim();
  return { enabled, override };
}

/**
 * Discover which providers are actually present on this machine.
 * A provider is "active" when its store exists on disk with content; it is
 * additionally "supported" when BB itself has a matching provider (so the
 * sessions can be rehydrated into a BB thread).
 */
export function probeSources(
  settings: IndexSettings,
  bbProviderIds: ReadonlySet<string>,
): SourceProbe[] {
  return PROVIDER_SOURCES.map((source) => {
    const { enabled, override } = settingsFor(source, settings);
    const roots = override ? [override] : source.defaultRoots;
    const existing = roots.find((r) => existsSync(resolveHome(r)));
    let detected = false;
    let count = 0;
    let root: string | null = null;

    if (existing) {
      const abs = resolveHome(existing);
      if (source.kind === "opencode") {
        // Single SQLite file store.
        count = countSqliteSessions(abs);
        detected = count > 0;
      } else if (source.kind === "prime") {
        // JSONL dir + hermes daemon db.
        count = countJsonl(abs);
        const dbPath = (settings.primeDbPath ?? "").trim();
        detected =
          count > 0 || (dbPath !== "" && existsSync(resolveHome(dbPath)));
      } else {
        count = countJsonl(abs);
        detected = count > 0;
      }
      if (detected) root = existing;
    }

    return {
      id: source.id,
      label: source.label,
      kind: source.kind,
      enabled,
      detected,
      root,
      count,
      supported: source.covers.some((id) => bbProviderIds.has(id)),
      bbProviderId: source.bbProviderId,
    };
  });
}
