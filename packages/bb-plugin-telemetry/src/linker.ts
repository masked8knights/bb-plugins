import type { LinkRecord, ProviderSessionRecord } from "./types";

const MIN_METADATA_MATCH_SCORE = 0.55;

export function explicitProviderLinkKey(
  provider: ProviderSessionRecord["provider"],
  hostId: string,
  providerSessionId: string,
): string {
  return [provider, hostId, providerSessionId].join("\u0000");
}

function closeEnough(left: number | null, right: number | null, windowMs: number): boolean {
  return left !== null && right !== null && Math.abs(left - right) <= windowMs;
}

function evidenceFor(session: ProviderSessionRecord, sequence: number | null, eventType: string) {
  return {
    source: "bb" as const,
    sourceRecordId: `bb:${session.bbThreadId ?? session.id}`,
    sourceSequence: sequence,
    eventType,
    at: session.updatedAt,
  };
}

export function linkProviderSessions(
  providerSessions: ProviderSessionRecord[],
  bbSessions: ProviderSessionRecord[],
  explicitProviderIds: Map<string, { bbThreadId: string; sourceSequence: number | null }>,
  now = Date.now(),
): LinkRecord[] {
  const links: LinkRecord[] = [];
  const usedBb = new Set<string>();
  const bbById = new Map(bbSessions.map((session) => [session.id, session]));

  for (const provider of providerSessions) {
    const explicit = provider.providerSessionId
      ? explicitProviderIds.get(explicitProviderLinkKey(provider.provider, provider.hostId, provider.providerSessionId))
      : undefined;
    if (explicit) {
      const bb = bbById.get(`bb:${explicit.bbThreadId}`) ?? bbSessions.find((candidate) => candidate.bbThreadId === explicit.bbThreadId);
      if (bb && !usedBb.has(bb.id)) {
        links.push({
          providerSessionId: provider.id,
          bbThreadId: bb.bbThreadId ?? explicit.bbThreadId,
          strategy: "explicit-session-id",
          confidence: 1,
          policy: "accepted",
          evidence: [evidenceFor(bb, explicit.sourceSequence, "provider-session-link")],
          matchedAt: now,
        });
        usedBb.add(bb.id);
      }
    }
  }

  for (const provider of providerSessions) {
    if (links.some((link) => link.providerSessionId === provider.id)) continue;
    const candidates = bbSessions
      .filter((bb) => !usedBb.has(bb.id) && bb.provider === provider.provider)
      .map((bb) => {
        let score = 0;
        if (provider.hostId === bb.hostId) score += 0.25;
        if (provider.cwd && bb.cwd && provider.cwd === bb.cwd) score += 0.4;
        if (provider.model && bb.model && provider.model === bb.model) score += 0.15;
        if (closeEnough(provider.startedAt, bb.startedAt, 5 * 60 * 1000)) score += 0.2;
        if (closeEnough(provider.updatedAt, bb.updatedAt, 10 * 60 * 1000)) score += 0.1;
        return { bb, score };
      })
      .filter((candidate) => candidate.score >= MIN_METADATA_MATCH_SCORE)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) continue;
    links.push({
      providerSessionId: provider.id,
      bbThreadId: best.bb.bbThreadId ?? best.bb.id.replace(/^bb:/, ""),
      strategy: "metadata-window",
      confidence: Math.min(0.89, best.score),
      policy: "suggested",
      evidence: [evidenceFor(best.bb, null, "metadata-window-match")],
      matchedAt: now,
    });
    usedBb.add(best.bb.id);
  }
  return links;
}
