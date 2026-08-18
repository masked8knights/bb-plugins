const PAGE_SIZE = 100;

export function listSessionsInput(
  query: string,
  source: string,
  sort: "updated" | "started" | "events" | "duration" = "updated",
  offset = 0,
  limit = PAGE_SIZE,
): {
  query?: string;
  source?: string;
  sort?: "updated" | "started" | "events" | "duration";
  limit: number;
  offset: number;
} {
  const normalizedQuery = query.trim();
  const normalizedSource = source.trim();
  return {
    ...(normalizedQuery ? { query: normalizedQuery } : {}),
    ...(normalizedSource ? { source: normalizedSource } : {}),
    ...(sort !== "updated" ? { sort } : {}),
    limit,
    offset,
  };
}

export function listArtifactsInput(query: string, kind?: "decision" | "context", offset = 0, limit = PAGE_SIZE): {
  query?: string;
  kind?: "decision" | "context";
  limit: number;
  offset: number;
} {
  const normalizedQuery = query.trim();
  return {
    ...(normalizedQuery ? { query: normalizedQuery } : {}),
    ...(kind ? { kind } : {}),
    limit,
    offset,
  };
}
