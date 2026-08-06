// bb-plugin-sessions — auto-discover the coding-agent session stores on this
// machine (Codex, Claude Code, Pi / prime-agent, opencode, omp, …), index
// them, search them, and rehydrate one into a BB thread.

import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import {
  createIndexer,
  migrateDb,
  type IndexProgress,
  type SessionRow,
} from "./src/indexer";
import { rehydrateSession } from "./src/rehydrate";
import {
  isCoveredBySource,
  isKnownProviderId,
  PROVIDER_LABELS,
  PROVIDER_SOURCES,
  type ProviderId,
} from "./src/sources";
import { defaultIndexSettings, type IndexSettings } from "./src/types";

// ---------------------------------------------------------------------------
// Schemas (provider ids are dynamic — validated against the source registry)
// ---------------------------------------------------------------------------

const providerId = z.string().refine(isKnownProviderId, {
  message: "Unknown session source provider",
});
const searchResultSchema = z.object({
  id: z.string(),
  provider: z.string(),
  title: z.string(),
  cwd: z.string().nullable(),
  startedAt: z.number().nullable(),
  updatedAt: z.number().nullable(),
  model: z.string().nullable(),
  messageCount: z.number(),
  firstUserMessage: z.string().nullable(),
  summary: z.string().nullable(),
  origin: z.string().nullable(),
});

const sessionDetailSchema = searchResultSchema.extend({
  providerSessionId: z.string(),
  filePath: z.string().nullable(),
  gitRepoRoot: z.string().nullable(),
  transcript: z.string(),
  transcriptTruncated: z.boolean(),
  transcriptLength: z.number(),
  truncated: z.boolean(),
});

const statusDtoSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      enabled: z.boolean(),
      detected: z.boolean(),
      supported: z.boolean(),
      root: z.string().nullable(),
      count: z.number(),
      lastIndexedAt: z.number().nullable(),
    }),
  ),
  /** BB providers that exist but have no session source adapter yet. */
  uncovered: z.array(
    z.object({ id: z.string(), displayName: z.string() }),
  ),
  totalSessions: z.number(),
  indexing: z.object({
    active: z.boolean(),
    phase: z.string(),
    provider: z.string().nullable(),
    done: z.number(),
    total: z.number(),
  }),
  lastIndexAt: z.number().nullable(),
  error: z.string().nullable(),
});

const rehydrateResultSchema = z.object({
  threadId: z.string(),
  threadTitle: z.string(),
  project: z.object({ id: z.string(), name: z.string() }),
  environment: z.object({
    kind: z.enum(["unmanaged", "project-default"]),
    path: z.string().optional(),
    hostId: z.string().optional(),
  }),
  provider: z.string().nullable(),
  inputChars: z.number(),
  notes: z.array(z.string()),
});

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusDtoSchema,
  },
  reindex: {
    input: z
      .object({ providers: z.array(z.string()).optional() })
      .strict(),
    output: z.object({ started: z.boolean() }),
  },
  search: {
    input: z
      .object({
        query: z.string().max(500),
        providers: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    output: z.object({
      results: z.array(searchResultSchema),
      total: z.number().int().nonnegative(),
    }),
  },
  getSession: {
    input: z.object({ id: z.string().min(1) }).strict(),
    output: z.object({ session: sessionDetailSchema }),
  },
  rehydrate: {
    input: z
      .object({
        id: z.string().min(1),
        projectId: z.string().optional(),
        providerId: z.string().optional(),
        mode: z.enum(["full", "condensed"]).optional(),
      })
      .strict(),
    output: rehydrateResultSchema,
  },
  listProviders: {
    input: z.null(),
    output: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          available: z.boolean(),
        }),
      ),
      sourceDefault: z.record(z.string(), z.string().nullable()),
    }),
  },
});

export type RpcContract = typeof rpcContract;
export type StatusDto = z.infer<typeof statusDtoSchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type RehydrateResult = z.infer<typeof rehydrateResultSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToSearchResult(row: SessionRow) {
  return {
    id: row.id,
    provider: row.provider,
    title: row.title,
    cwd: row.cwd,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    model: row.model,
    messageCount: row.messageCount,
    firstUserMessage: row.firstUserMessage,
    summary: row.summary,
    origin: row.origin,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

function parseProviderList(argv: string[]): ProviderId[] | undefined {
  const out: ProviderId[] = [];
  for (const a of argv) {
    if (isKnownProviderId(a)) out.push(a);
  }
  return out.length ? out : undefined;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], ...names: string[]): boolean {
  return names.some((n) => argv.includes(n));
}

// ---------------------------------------------------------------------------
// Plugin factory
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  migrateDb(db);

  // Settings are generated from the source registry: every registered source
  // gets an enable toggle and an optional path override (empty = auto-detect).
  const settingDefs: Record<string, {
    type: "boolean" | "string";
    label: string;
    description?: string;
    default?: string | boolean;
  }> = {};
  for (const s of PROVIDER_SOURCES) {
    settingDefs[`${s.id}Enabled`] = {
      type: "boolean",
      label: `Index ${s.label} sessions`,
      default: true,
    };
    settingDefs[`${s.id}Path`] = {
      type: "string",
      label: `${s.label} store path`,
      description: `Where ${s.label} stores sessions. Leave empty to auto-detect.`,
      default: s.defaultRoots[0],
    };
  }
  settingDefs.primeDbPath = {
    type: "string",
    label: "hermes state.db path",
    description: "Pi daemon session store (SQLite). Empty disables it.",
    default: "~/.hermes/state.db",
  };
  const settings = bb.settings.define(
    settingDefs as Parameters<typeof bb.settings.define>[0],
  );

  const boolVal = (
    v: string | boolean | undefined,
    fallback: boolean,
  ): boolean => (typeof v === "boolean" ? v : fallback);
  const strVal = (
    v: string | boolean | undefined,
    fallback: string,
  ): string => (typeof v === "string" && v.trim() !== "" ? v : fallback);

  const getSettings = async (): Promise<IndexSettings> => {
    const v = await settings.get();
    const d = defaultIndexSettings();
    return {
      codexEnabled: boolVal(v.codexEnabled, d.codexEnabled),
      codexPath: strVal(v.codexPath, d.codexPath),
      claudeEnabled: boolVal(v.claudeEnabled, d.claudeEnabled),
      claudePath: strVal(v.claudePath, d.claudePath),
      primeEnabled: boolVal(v.primeEnabled, d.primeEnabled),
      primePath: strVal(v.primePath, d.primePath),
      primeDbPath: strVal(v.primeDbPath, d.primeDbPath),
      opencodeEnabled: boolVal(v.opencodeEnabled, d.opencodeEnabled),
      opencodePath: strVal(v.opencodePath, d.opencodePath),
      ompEnabled: boolVal(v.ompEnabled, d.ompEnabled),
      ompPath: strVal(v.ompPath, d.ompPath),
    } satisfies IndexSettings;
  };

  const indexer = createIndexer({
    db,
    kv: bb.storage.kv,
    log: (m) => bb.log.info(m),
    publish: (p: IndexProgress) => {
      try {
        bb.realtime.publish("sessions-index", p);
      } catch {
        // ignore
      }
    },
    getSettings,
  });

  const getLastIndexAt = async (): Promise<number | null> =>
    (await bb.storage.kv.get<number>("lastIndexAt")) ?? null;

  const getBbProviders = async (): Promise<
    Array<{ id: string; displayName: string; available: boolean }>
  > => {
    try {
      return (await bb.sdk.providers.list()).map((p) => ({
        id: p.id,
        displayName: p.displayName,
        available: p.available,
      }));
    } catch {
      return [];
    }
  };

  const buildStatus = async (): Promise<z.infer<typeof statusDtoSchema>> => {
    const [settings, bbProviders, lastIndexAt] = await Promise.all([
      getSettings(),
      getBbProviders(),
      getLastIndexAt(),
    ]);
    const bbIds = new Set(bbProviders.map((p) => p.id));
    const full = indexer.status(settings, lastIndexAt, bbIds);
    const uncovered = bbProviders.filter((p) => !isCoveredBySource(p.id));
    return { ...full, uncovered };
  };

  // -------------------------------------------------------------------------
  // RPC
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    async status() {
      return buildStatus();
    },
    async reindex({ providers }) {
      const want = (providers ?? []).filter(isKnownProviderId) as
        | ProviderId[]
        | undefined;
      // Fire-and-forget; progress arrives on the sessions-index channel.
      void indexer
        .ensureIndexed({ force: true, providers: want })
        .catch((err) => bb.log.error(`reindex failed: ${String(err)}`));
      return { started: true };
    },
    async search({ query, providers, limit }) {
      const want = (providers ?? []).filter(isKnownProviderId) as
        | ProviderId[]
        | undefined;
      const { rows, total } = indexer.searchWithTotal(query, want, limit ?? 50);
      return { results: rows.map(rowToSearchResult), total };
    },
    async getSession({ id }) {
      const row = indexer.get(id);
      if (!row) throw new Error(`Session not found: ${id}`);
      const PREVIEW = 40_000;
      return {
        session: {
          ...rowToSearchResult(row),
          providerSessionId: row.providerSessionId,
          filePath: row.filePath,
          gitRepoRoot: row.gitRepoRoot,
          transcript:
            row.transcript.length > PREVIEW
              ? row.transcript.slice(0, PREVIEW) + "\n\n… (preview truncated)"
              : row.transcript,
          transcriptTruncated: row.transcript.length > PREVIEW,
          transcriptLength: row.transcript.length,
          truncated: row.truncated === 1,
        },
      };
    },
    async rehydrate({ id, projectId, providerId, mode }) {
      const row = indexer.get(id);
      if (!row) throw new Error(`Session not found: ${id}`);
      return rehydrateSession(bb, row, { projectId, providerId, mode });
    },
    async listProviders() {
      const providers = await getBbProviders();
      const sourceDefault: Record<string, string | null> = {};
      for (const s of PROVIDER_SOURCES) {
        sourceDefault[s.id] = providers.some((p) => p.id === s.bbProviderId)
          ? s.bbProviderId
          : null;
      }
      return { providers, sourceDefault };
    },
  });

  // -------------------------------------------------------------------------
  // CLI: bb sessions …
  // -------------------------------------------------------------------------

  bb.cli.register({
    name: "sessions",
    summary: "Search and rehydrate locally discovered provider sessions",
    commands: [
      { name: "status", summary: "Show auto-discovered sources and index status", usage: "bb sessions status [--json]" },
      { name: "reindex", summary: "Scan provider stores and refresh the index", usage: "bb sessions reindex [--full] [codex|claude|prime|opencode|omp …]" },
      { name: "search", summary: "Full-text search across indexed sessions", usage: "bb sessions search <query> [--provider <id>] [--limit <n>] [--json]" },
      { name: "get", summary: "Show one indexed session (metadata + transcript)", usage: "bb sessions get <id> [--json]" },
      { name: "rehydrate", summary: "Rehydrate an indexed session into a BB thread", usage: "bb sessions rehydrate <id> [--project <id>] [--provider <id>] [--condensed|--full] [--json]" },
    ],
    async run(argv, ctx) {
      const [cmd, ...rest] = argv;
      const json = hasFlag(rest, "--json");
      const print = (obj: unknown) => {
        const text = json ? JSON.stringify(obj, null, 2) : String(obj);
        return { exitCode: 0, stdout: text + "\n" };
      };
      switch (cmd) {
        case "status": {
          const s = await buildStatus();
          if (json) return print(s);
          const lines = [
            `Sessions indexed: ${s.totalSessions}`,
            `Last index: ${s.lastIndexAt ? new Date(s.lastIndexAt).toISOString() : "never"}`,
            s.indexing.active ? `Indexing: ${s.indexing.phase} (${s.indexing.provider ?? ""}) ${s.indexing.done}/${s.indexing.total}` : "Indexing: idle",
            s.error ? `Error: ${s.error}` : "",
          ];
          for (const p of s.providers) {
            const status = !p.enabled
              ? "disabled"
              : !p.detected
                ? "not detected"
                : !p.supported
                  ? "detected (no bb provider)"
                  : "active";
            const root = p.detected && p.root ? ` @ ${p.root}` : "";
            lines.push(
              `  ${p.label}: ${p.count} indexed · ${status}${root}`,
            );
          }
          if (s.uncovered.length > 0) {
            lines.push(
              `BB providers without a session source: ${s.uncovered
                .map((u) => `${u.displayName} (${u.id})`)
                .join(", ")}`,
            );
          }
          return print(lines.filter(Boolean).join("\n"));
        }
        case "reindex": {
          const providers = parseProviderList(rest);
          const res = await indexer.ensureIndexed({
            force: hasFlag(rest, "--full", "--force"),
            providers,
          });
          const s = await buildStatus();
          if (json) return print({ ...res, totalSessions: s.totalSessions });
          return print(
            `Index refreshed: ${res.indexed} new/updated, ${res.removed} removed. Total: ${s.totalSessions} sessions.`,
          );
        }
        case "search": {
          const query = rest.find((a) => !a.startsWith("-"));
          if (!query) {
            return {
              exitCode: 1,
              stderr: "Usage: bb sessions search <query> [--provider <id>] [--limit <n>]\n",
            };
          }
          const providers = parseProviderList(rest);
          const limit = Number(flagValue(rest, "--limit") ?? "20") || 20;
          const { rows, total } = indexer.searchWithTotal(query, providers, limit);
          if (json) return print({ total, results: rows.map(rowToSearchResult) });
          if (rows.length === 0) return print("No matching sessions.");
          const lines = rows.map((r, i) => {
            const when = r.updatedAt
              ? new Date(r.updatedAt).toISOString().slice(0, 10)
              : "?";
            const cwd = r.cwd ? ` · ${r.cwd}` : "";
            return `${i + 1}. [${r.provider}] ${r.title} (${when}, ${r.messageCount} msgs)${cwd}\n   id: ${r.id}`;
          });
          const summary =
            rows.length < total
              ? `\n${rows.length} of ${total} matching sessions (use --limit to see more).`
              : `\n${total} matching session${total === 1 ? "" : "s"}.`;
          return print(lines.join("\n") + summary);
        }
        case "get": {
          const id = rest.find((a) => !a.startsWith("-"));
          if (!id) {
            return { exitCode: 1, stderr: "Usage: bb sessions get <id>\n" };
          }
          const row = indexer.get(id);
          if (!row) return { exitCode: 1, stderr: `Session not found: ${id}\n` };
          if (json) {
            return print({
              ...rowToSearchResult(row),
              providerSessionId: row.providerSessionId,
              filePath: row.filePath,
              transcript: row.transcript,
            });
          }
          const meta = [
            `Provider: ${PROVIDER_LABELS[row.provider] ?? row.provider} (${row.provider})`,
            `Session: ${row.providerSessionId}`,
            row.model ? `Model: ${row.model}` : "",
            row.startedAt ? `Started: ${new Date(row.startedAt).toISOString()}` : "",
            row.updatedAt ? `Updated: ${new Date(row.updatedAt).toISOString()}` : "",
            row.cwd ? `Cwd: ${row.cwd}` : "",
            row.gitRepoRoot ? `Repo: ${row.gitRepoRoot}` : "",
            `Messages: ${row.messageCount}`,
            row.truncated ? "(transcript truncated for storage)" : "",
          ]
            .filter(Boolean)
            .join("\n");
          const transcript =
            row.transcript.length > 8_000
              ? row.transcript.slice(0, 8_000) + "\n… (transcript truncated; use --json for full)"
              : row.transcript;
          return print(`${meta}\n\n${transcript}`);
        }
        case "rehydrate": {
          const id = rest.find((a) => !a.startsWith("-"));
          if (!id) {
            return {
              exitCode: 1,
              stderr:
                "Usage: bb sessions rehydrate <id> [--project <id>] [--provider <id>] [--condensed|--full]\n",
            };
          }
          const row = indexer.get(id);
          if (!row) return { exitCode: 1, stderr: `Session not found: ${id}\n` };
          const mode = hasFlag(rest, "--condensed")
            ? "condensed"
            : "full";
          const result = await rehydrateSession(bb, row, {
            projectId: flagValue(rest, "--project") ?? ctx.projectId,
            providerId: flagValue(rest, "--provider"),
            mode,
          });
          if (json) return print(result);
          return print(
            [
              `Rehydrated "${result.threadTitle}" into thread ${result.threadId}`,
              `Project: ${result.project.name} (${result.project.id})`,
              `Environment: ${result.environment.kind}${
                result.environment.path ? ` @ ${result.environment.path}` : ""
              }`,
              `Provider: ${result.provider ?? "project default"}`,
              `Prompt: ${result.inputChars} chars (${mode})`,
            ].join("\n"),
          );
        }
        default:
          return {
            exitCode: 1,
            stderr:
              "Unknown command. Try: status | reindex | search <q> | get <id> | rehydrate <id>\n",
          };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Background: keep the index fresh
  // -------------------------------------------------------------------------

  bb.background.service("indexer", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await indexer.ensureIndexed({ force: false });
        } catch (err) {
          bb.log.error(`background index failed: ${String(err)}`);
        }
        await sleep(60_000, signal);
      }
    },
  });

  bb.onDispose(() => {
    indexer.dispose();
  });
}
