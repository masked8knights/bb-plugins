// bb-plugin-omp — registers oh-my-pi (`omp`) as a bb ACP provider.
//
// bb has no provider-registration plugin API, so this plugin provisions the
// supported data-dir mechanism instead (same as bb-plugin-prime-agent):
//   1. writes the ACP shim to <dataDir>/bin/omp-acp.sh
//   2. writes the provider logo to <dataDir>/logos/oh-my-pi.svg
//   3. merges a `customAcpAgents` entry into <dataDir>/config.json
//      (idempotent — never clobbers other entries or config keys)
//   4. POSTs /api/v1/system/config/reload so the running server picks it up
//
// The shim exists to adapt omp's model catalog to bb's model-list contract:
// `omp acp` already speaks ACP over stdio and `--model <provider>/<model>`
// resolves natively, so launch args pass straight through. The shim only
// reformats `omp models --json` into bb's `id - name` lines.
import { type BbPluginApi } from "@bb/plugin-sdk";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const PLUGIN_ID = "omp";
const PROVIDER_ID = "acp-omp";

/** Absolute path to the omp binary when resolvable, else bare `omp`. */
function resolveOmpBinary(): string {
	try {
		return execFileSync("bash", ["-lc", "command -v omp"], { encoding: "utf8" }).trim() || "omp";
	} catch {
		return "omp";
	}
}

const SHIM = (ompBin: string) => `#!/bin/sh
# bb custom ACP agent shim for oh-my-pi (managed by bb-plugin-omp).
#   omp-acp.sh model-list            -> reformat \`omp models --json\` for bb's parser
#   omp-acp.sh <bb launch args...>   -> exec omp (native ACP server over stdio)
OMP="${ompBin}"
if [ "$1" = "model-list" ]; then
	if command -v python3 >/dev/null 2>&1; then
		"$OMP" models --json 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
for m in data.get("models", []):
    sel = m.get("selector") or m.get("id")
    name = m.get("name") or sel
    if sel:
        print(f"{sel} - {name}")
'
		exit 0
	fi
	# Fallback (no python3): parse the human-readable provider-grouped table.
	"$OMP" models 2>/dev/null | awk -F'│' '
		/^[A-Za-z0-9][A-Za-z0-9_.-]* \\([0-9]+\\)$/ {
			provider = $1; gsub(/ /, "", provider); sub(/\\([0-9]+\\)$/, "", provider); next
		}
		/^│/ {
			cell = $2; gsub(/^[ \\t]+|[ \\t]+$/, "", cell)
			if (cell != "" && cell != "model" && provider != "") print provider "/" cell " - " cell
		}
	'
	exit 0
fi
exec "$OMP" "$@"
`;

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" fill="none">
  <rect x="4" y="4" width="248" height="248" rx="60" fill="#0b0f14"/>
  <circle cx="128" cy="124" r="84" fill="#14b8a6" opacity="0.14"/>
  <text x="128" y="150" font-family="Georgia, 'Times New Roman', serif" font-size="112" font-weight="bold" fill="#ffffff" text-anchor="middle">π</text>
  <text x="128" y="214" font-family="ui-monospace, 'SF Mono', Menlo, monospace" font-size="28" letter-spacing="10" fill="#7dd3fc" text-anchor="middle">OMP</text>
</svg>
`;

export default async function plugin(bb: BbPluginApi) {
	bb.log.info("loaded");

	async function resolveDataDir(): Promise<string> {
		try {
			const cfg = await bb.sdk.system.config();
			if (typeof cfg.dataDir === "string" && cfg.dataDir.length > 0) return cfg.dataDir;
		} catch (error) {
			bb.log.warn(`sdk.system.config unavailable, falling back to env/home: ${String(error)}`);
		}
		return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
	}

	async function reloadServerConfig(): Promise<boolean> {
		try {
			const url = `${bb.server.loopbackBaseUrl}/api/v1/system/config/reload`;
			const res = await fetch(url, { method: "POST" });
			return res.ok;
		} catch (error) {
			bb.log.warn(`config reload failed: ${String(error)}`);
			return false;
		}
	}

	/** Read <dataDir>/config.json as a plain object; returns null on parse failure. */
	function readConfig(dataDir: string): Record<string, unknown> | null {
		const path = join(dataDir, "config.json");
		if (!existsSync(path)) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: null;
		} catch (error) {
			bb.log.error(`config.json is not valid JSON; refusing to overwrite: ${String(error)}`);
			return null;
		}
	}

	async function provision(): Promise<{ ok: boolean; changed: boolean; messages: string[] }> {
		const messages: string[] = [];
		const dataDir = await resolveDataDir();
		const ompBin = resolveOmpBinary();
		if (ompBin === "omp") messages.push("WARNING: `omp` not found on PATH; shim will rely on it being on PATH at launch");

		// 1. shim
		const shimPath = join(dataDir, "bin", "omp-acp.sh");
		mkdirSync(join(dataDir, "bin"), { recursive: true });
		writeFileSync(shimPath, SHIM(ompBin), "utf8");
		chmodSync(shimPath, 0o755);
		messages.push(`wrote ${shimPath}`);

		// 2. logo
		const logoPath = join(dataDir, "logos", "oh-my-pi.svg");
		mkdirSync(join(dataDir, "logos"), { recursive: true });
		writeFileSync(logoPath, LOGO, "utf8");
		messages.push(`wrote ${logoPath}`);

		// 3. config.json merge
		const config = readConfig(dataDir);
		if (config === null) return { ok: false, changed: false, messages };

		const agents = Array.isArray(config.customAcpAgents)
			? (config.customAcpAgents as Record<string, unknown>[])
			: [];
		const entry = {
			id: PLUGIN_ID,
			displayName: "Oh My Pi",
			command: shimPath,
			args: ["acp"],
			logo: "logos/oh-my-pi.svg",
			modelCli: { listArgs: ["model-list"], selectFlag: "--model" },
		};
		const existing = agents.findIndex((a) => a?.id === PLUGIN_ID);
		let changed = false;
		if (existing >= 0) {
			// Idempotent: only rewrite when the managed fields drift.
			const before = JSON.stringify(agents[existing]);
			agents[existing] = { ...agents[existing], ...entry };
			if (JSON.stringify(agents[existing]) !== before) {
				changed = true;
				messages.push(`updated existing customAcpAgents entry "${PLUGIN_ID}"`);
			} else {
				messages.push(`customAcpAgents entry "${PLUGIN_ID}" already up to date`);
			}
		} else {
			agents.push(entry);
			changed = true;
			messages.push(`added customAcpAgents entry "${PLUGIN_ID}" (provider ${PROVIDER_ID})`);
		}
		config.customAcpAgents = agents;
		writeFileSync(join(dataDir, "config.json"), `${JSON.stringify(config, null, "\t")}\n`, "utf8");

		// 4. reload
		if (changed) {
			const ok = await reloadServerConfig();
			messages.push(ok ? "reloaded running bb server config" : "WARNING: could not reload server config; run `bb-app config refresh`");
		} else {
			messages.push("no config change; no reload needed");
		}
		return { ok: true, changed, messages };
	}

	async function status(): Promise<string[]> {
		const lines: string[] = [];
		const dataDir = await resolveDataDir();
		const config = readConfig(dataDir);
		const entry = Array.isArray(config?.customAcpAgents)
			? (config.customAcpAgents as Record<string, unknown>[]).find((a) => a?.id === PLUGIN_ID)
			: undefined;
		lines.push(`config entry: ${entry ? "present" : "missing"}`);
		lines.push(`shim: ${existsSync(join(dataDir, "bin", "omp-acp.sh")) ? "present" : "missing"}`);
		lines.push(`logo: ${existsSync(join(dataDir, "logos", "oh-my-pi.svg")) ? "present" : "missing"}`);
		try {
			const providers = await bb.sdk.providers.list();
			const registered = providers.some((p: { id?: string }) => p.id === PROVIDER_ID);
			lines.push(`bb provider ${PROVIDER_ID}: ${registered ? "registered" : "NOT registered"}`);
		} catch (error) {
			lines.push(`bb provider ${PROVIDER_ID}: unknown (${String(error)})`);
		}
		return lines;
	}

	bb.cli.register({
		name: "omp",
		summary: "Manage the oh-my-pi (omp) ACP provider integration.",
		commands: [
			{
				name: "setup",
				summary: "Install the shim, logo, and customAcpAgents entry, then reload bb config",
				usage: "omp setup",
			},
			{
				name: "status",
				summary: "Show whether the omp provider is configured and registered",
				usage: "omp status",
			},
		],
		async run(argv) {
			const sub = argv[0];
			if (sub === "status") {
				const lines = await status();
				return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
			}
			if (sub === "setup" || sub === undefined) {
				const result = await provision();
				return { exitCode: result.ok ? 0 : 1, stdout: `${result.messages.join("\n")}\n` };
			}
			return {
				exitCode: 1,
				stderr: `Unknown subcommand "${sub}". Use "bb omp setup" or "bb omp status".\n`,
			};
		},
	});
}
