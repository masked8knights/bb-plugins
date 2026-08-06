// Append ds4-server output to a persistent, rotating log file under the BB
// data directory (~/.bb/plugins/<id>/process.log). The ring buffer in
// Ds4Process covers live tailing; this file survives BB restarts.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 50 * 1024 * 1024;

export function persistentLogPath(pluginId: string): string {
  return join(homedir(), ".bb", "plugins", pluginId, "process.log");
}

export function appendPersistentLog(
  pluginId: string,
  lines: { ts: number; stream: string; text: string }[],
): void {
  if (!lines.length) return;
  const path = persistentLogPath(pluginId);
  try {
    mkdirSync(join(homedir(), ".bb", "plugins", pluginId), { recursive: true });
    let out = "";
    for (const l of lines) {
      out += `${new Date(l.ts).toISOString()} [${l.stream}] ${l.text}\n`;
    }
    appendFileSync(path, out, "utf8");
    try {
      if (statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // rotation is best-effort
    }
  } catch {
    // logging must never crash the supervisor
  }
}
