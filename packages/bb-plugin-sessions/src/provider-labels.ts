/**
 * Pure provider labels shared by the browser UI.
 *
 * Keep this separate from sources.ts: the source registry probes local files
 * and SQLite and therefore must not be pulled into the app bundle.
 */
const PROVIDER_LABELS: Record<string, string> = {
  pi: "Pi",
  prime: "Prime Agent",
  "acp-prime-agent": "Prime Agent",
  omp: "Oh My Pi",
  "acp-omp": "Oh My Pi",
  hermes: "Hermes",
  "acp-hermes-agent": "Hermes",
  codex: "Codex",
  claude: "Claude Code",
  "claude-code": "Claude Code",
  opencode: "opencode (legacy)",
  "acp-opencode": "opencode (legacy)",
  other: "Other harnesses",
};

export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}
