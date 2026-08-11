// Provider source registry + auto-discovery.
//
// A provider family is not the same thing as a physical store. In particular:
// - Pi and Prime Agent both write the historical Pi-format JSONL shape, but
//   their normal installations use different roots: ~/.pi and ~/.prime.
//   If a user explicitly points both adapters at one directory, the files do
//   not carry reliable harness provenance and the shared path is Pi-owned.
// - Hermes has its own SQLite store and is never folded into Pi.
// - opencode is retained only as a legacy compatibility adapter.

import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CANONICAL_PROVIDER_IDS,
  type IndexSettings,
  type ProviderId,
} from "./types";
import { MAX_JSONL_WALK_ENTRIES } from "./scan-limits";

export type { ProviderId } from "./types";

export type SourceKind =
  | "codex"
  | "claude"
  | "pi"
  | "prime"
  | "omp"
  | "hermes"
  | "opencode";
export type StoreType = "jsonl" | "db";

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
  /** Whether this is one of the six canonical provider families. */
  canonical?: boolean;
  /** Another provider owns the default path when both paths are identical. */
  sharedWith?: ProviderId;
  /** UI badge classes. */
  badge: string;
  /** Candidate store locations to probe, in order. */
  defaultRoots: string[];
  /** Additional roots that belong to the same provider (for example Codex archives). */
  archiveRoots?: string[];
  /** Extra store the source also reads (e.g. prime's hermes db). */
  defaultDbPath?: string;
  storeType: StoreType;
}

export const PROVIDER_SOURCES: ProviderSource[] = [
  {
    id: "pi",
    label: "Pi",
    kind: "pi",
    bbProviderId: "pi",
    covers: ["pi"],
    canonical: true,
    badge: "bg-violet-500/15 text-violet-500 border-violet-500/30",
    defaultRoots: ["~/.pi/agent/sessions"],
    storeType: "jsonl",
  },
  {
    id: "prime",
    label: "Prime Agent",
    kind: "prime",
    bbProviderId: "acp-prime-agent",
    covers: ["acp-prime-agent"],
    canonical: true,
    sharedWith: "pi",
    badge: "bg-fuchsia-500/15 text-fuchsia-500 border-fuchsia-500/30",
    defaultRoots: ["~/.prime/agent/sessions"],
    storeType: "jsonl",
  },
  {
    id: "omp",
    label: "Oh My Pi",
    kind: "omp",
    bbProviderId: "acp-omp",
    covers: ["acp-omp"],
    canonical: true,
    badge: "bg-rose-500/15 text-rose-500 border-rose-500/30",
    defaultRoots: ["~/.omp/agent/sessions"],
    storeType: "jsonl",
  },
  {
    id: "hermes",
    label: "Hermes",
    kind: "hermes",
    bbProviderId: "acp-hermes-agent",
    covers: ["acp-hermes-agent"],
    canonical: true,
    badge: "bg-cyan-500/15 text-cyan-500 border-cyan-500/30",
    defaultRoots: ["~/.hermes/state.db"],
    storeType: "db",
  },
  {
    id: "codex",
    label: "Codex",
    kind: "codex",
    bbProviderId: "codex",
    covers: ["codex"],
    canonical: true,
    badge: "bg-emerald-500/15 text-emerald-500 border-emerald-500/30",
    defaultRoots: ["~/.codex/sessions"],
    archiveRoots: ["~/.codex/archived_sessions"],
    storeType: "jsonl",
  },
  {
    id: "claude",
    label: "Claude Code",
    kind: "claude",
    bbProviderId: "claude-code",
    covers: ["claude-code"],
    canonical: true,
    badge: "bg-amber-500/15 text-amber-500 border-amber-500/30",
    defaultRoots: ["~/.claude/projects"],
    storeType: "jsonl",
  },
  {
    id: "opencode",
    label: "opencode (legacy)",
    kind: "opencode",
    bbProviderId: "acp-opencode",
    covers: ["acp-opencode"],
    badge: "bg-sky-500/15 text-sky-500 border-sky-500/30",
    defaultRoots: ["~/.local/share/opencode/opencode.db"],
    storeType: "db",
  },
];

export const PROVIDER_IDS: ProviderId[] = PROVIDER_SOURCES.map((s) => s.id);
export const CANONICAL_SOURCE_IDS: ProviderId[] = [...CANONICAL_PROVIDER_IDS];

/**
 * Files that are valid provider output but are not useful conversations.
 * CodexBar's Claude probe creates thousands of synthetic sessions beneath
 * Claude Code's normal project store; keep those files on disk but leave them
 * out of the local Sessions index.
 */
const IGNORED_PATH_FRAGMENTS: Partial<Record<ProviderId, readonly string[]>> = {
  claude: ["CodexBar-ClaudeProbe"],
};

export function isIgnoredSessionPath(provider: ProviderId, filePath: string): boolean {
  return (IGNORED_PATH_FRAGMENTS[provider] ?? []).some((fragment) => filePath.includes(fragment));
}

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

/** Resolve a runtime BB provider id to the session source that indexes it. */
export function getSourceForBbProviderId(bbProviderId: string): ProviderSource | undefined {
  return PROVIDER_SOURCES.find((s) => s.covers.includes(bbProviderId));
}

/** True when a BB provider id is covered by one of our session sources. */
export function isCoveredBySource(bbProviderId: string): boolean {
  return getSourceForBbProviderId(bbProviderId) !== undefined;
}

export function resolveHome(p: string): string {
  if (!p) return p;
  return resolve(p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
}

/**
 * Canonical identity used only for ownership comparisons. Scanning still uses
 * the configured path so the no-follow walker can reject symlink roots rather
 * than silently following them.
 */
export function canonicalStorePath(p: string): string {
  const absolute = resolveHome(p);
  if (!absolute) return absolute;
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
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

function isWithinRoot(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && remainder !== "" && !remainder.startsWith(`..${sep}`));
}

/** Recursive *.jsonl file count with the same no-symlink boundary as indexing. */
function countJsonl(root: string): number {
  let rootStat;
  let canonicalRoot: string;
  try {
    rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return 0;
    canonicalRoot = realpathSync(root);
  } catch {
    return 0;
  }
  let n = 0;
  let visitedEntries = 0;
  const stack: Array<{ path: string; dev: number; ino: number }> = [{
    path: root,
    dev: rootStat.dev,
    ino: rootStat.ino,
  }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const dir = current.path;
    let entries;
    try {
      const before = lstatSync(dir);
      if (
        before.isSymbolicLink() ||
        !before.isDirectory() ||
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        !isWithinRoot(canonicalRoot, realpathSync(dir))
      ) continue;
      entries = readdirSync(dir, { withFileTypes: true });
      if (entries.length > MAX_JSONL_WALK_ENTRIES) return n;
      const after = lstatSync(dir);
      if (
        after.isSymbolicLink() ||
        after.dev !== current.dev ||
        after.ino !== current.ino ||
        !isWithinRoot(canonicalRoot, realpathSync(dir))
      ) continue;
    } catch {
      continue;
    }
    for (const e of entries) {
      if (visitedEntries >= MAX_JSONL_WALK_ENTRIES) return n;
      visitedEntries += 1;
      const p = join(dir, e.name);
      try {
        const stat = lstatSync(p);
        if (stat.isSymbolicLink()) continue;
        const canonical = realpathSync(p);
        if (!isWithinRoot(canonicalRoot, canonical)) continue;
        if (stat.isDirectory()) stack.push({ path: p, dev: stat.dev, ino: stat.ino });
        else if (stat.isFile() && extname(e.name) === ".jsonl") n++;
      } catch {
        // A disappearing or unreadable entry is not a positive detection.
      }
    }
  }
  return n;
}

function isNonSymlinkStore(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
  } catch {
    return false;
  }
}

function countSqliteSessions(dbPath: string): number {
  try {
    const stat = lstatSync(dbPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return 0;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const table of ["sessions", "session"]) {
        try {
          const r = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as
            | { c: number }
            | undefined;
          if (r) return r.c ?? 0;
        } catch {
          // Try the next known provider schema.
        }
      }
      return 0;
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

/** Resolve the same primary + archive roots for probing and indexing. */
export function resolveSourceRoots(
  source: ProviderSource,
  settings: IndexSettings,
): string[] {
  const { override } = settingsFor(source, settings);
  const primary = override ? [override] : source.defaultRoots;
  const usesDefaultPrimary = !override || canonicalStorePath(override) === canonicalStorePath(source.defaultRoots[0] ?? "");
  const archives = usesDefaultPrimary ? source.archiveRoots ?? [] : [];
  return [...primary, ...archives]
    .map(resolveHome)
    .filter((root, index, roots) => root.length > 0 && roots.indexOf(root) === index);
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
    const allRoots = resolveSourceRoots(source, settings);
    const configuredRoot = canonicalStorePath(override || source.defaultRoots[0]);
    const ownerRoot = source.sharedWith
      ? canonicalStorePath(settings[`${source.sharedWith}Path`] as string)
      : null;
    const sharesOwnerStore = Boolean(ownerRoot && configuredRoot && ownerRoot === configuredRoot);
    const existing = sharesOwnerStore
      ? undefined
      : allRoots.find((r) => isNonSymlinkStore(resolveHome(r)));
    let detected = false;
    let count = 0;
    let root: string | null = null;

    if (existing) {
      const abs = existing;
      if (source.kind === "opencode" || source.kind === "hermes") {
        // Single SQLite file store.
        count = countSqliteSessions(abs);
        detected = count > 0;
      } else {
        count = allRoots.reduce((total, candidate) => total + countJsonl(resolveHome(candidate)), 0);
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
