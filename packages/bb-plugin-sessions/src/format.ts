// Transcript formatting and rehydration prompt construction.

import { PROVIDER_LABELS } from "./sources";
import type { SessionMeta } from "./types";
import { formatMessages } from "./parsers";

export type RehydrateMode = "full" | "condensed";

/** Cap on the transcript embedded in the rehydrate prompt (full mode). */
const MAX_REHYDRATE_CHARS = 120_000;
/** Condensed mode: first user message + this many trailing messages. */
const CONDENSED_TRAIL = 4;

function iso(ts: number | null): string {
  if (ts == null) return "unknown";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toISOString();
}

function metadataLines(s: SessionMeta): string[] {
  const lines: string[] = [];
  lines.push(`Provider: ${PROVIDER_LABELS[s.provider]} (${s.provider})`);
  lines.push(`Source session: ${s.providerSessionId}`);
  lines.push(`Started: ${iso(s.startedAt)}`);
  if (s.model) lines.push(`Model: ${s.model}`);
  if (s.cwd) lines.push(`Cwd: ${s.cwd}`);
  if (s.gitRepoRoot) lines.push(`Repo: ${s.gitRepoRoot}`);
  if (s.origin) lines.push(`Origin: ${s.origin}`);
  lines.push(`Messages: ${s.messageCount}`);
  return lines;
}

function header(s: SessionMeta): string {
  return [
    `Rehydrated ${PROVIDER_LABELS[s.provider]} session — continue this conversation in BB.`,
    "",
    "Session details:",
    ...metadataLines(s).map((l) => `- ${l}`),
  ].join("\n");
}

/** Build the initial prompt text for a rehydrated thread. */
export function buildRehydratePrompt(
  s: SessionMeta,
  mode: RehydrateMode,
): string {
  const hdr = header(s);
  if (mode === "condensed") {
    // Rebuild a condensed transcript from the stored one is lossy, so the
    // parser stores the full formatted transcript; condense from the first
    // user message + tail markers is done here by re-using stored fields.
    const first = s.firstUserMessage ?? "(no user message captured)";
    const tail = extractTail(s.transcript, CONDENSED_TRAIL);
    const omitted = Math.max(0, s.messageCount - CONDENSED_TRAIL - 1);
    const body = [
      `## First user message\n\n${first}`,
      omitted > 0 ? `… (${omitted} messages omitted) …` : "",
      tail ? `## Recent conversation\n\n${tail}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return `${hdr}\n\nThe conversation so far (condensed):\n\n${body}`;
  }
  const transcript =
    s.transcript.length > MAX_REHYDRATE_CHARS
      ? s.transcript.slice(0, MAX_REHYDRATE_CHARS) +
        "\n\n… (transcript truncated for context)"
      : s.transcript;
  return `${hdr}\n\nThe conversation so far:\n\n${transcript}`;
}

/** Pull the last N "## Role" sections out of a formatted transcript. */
function extractTail(transcript: string, n: number): string {
  const sections = transcript.split(/\n(?=## (?:User|Assistant)\n)/);
  if (sections.length <= 1) return "";
  const tail = sections.slice(-n).join("\n");
  // Strip the leading "## First user message" duplication when the tail
  // happens to start with the same section.
  return tail.trim();
}

export function formatTranscriptForPreview(s: SessionMeta, maxChars = 40_000): string {
  const meta = metadataLines(s).join("\n");
  const body =
    s.transcript.length > maxChars
      ? s.transcript.slice(0, maxChars) + "\n\n… (preview truncated)"
      : s.transcript;
  return `${meta}\n\n${body}`;
}

export { formatMessages };
