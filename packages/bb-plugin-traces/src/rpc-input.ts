export function listSessionsInput(query: string, source: string): {
  query?: string;
  source?: string;
  limit: number;
  offset: number;
} {
  const normalizedQuery = query.trim();
  const normalizedSource = source.trim();
  return {
    ...(normalizedQuery ? { query: normalizedQuery } : {}),
    ...(normalizedSource ? { source: normalizedSource } : {}),
    limit: 100,
    offset: 0,
  };
}

export function listArtifactsInput(query: string): {
  query?: string;
  limit: number;
  offset: number;
} {
  const normalizedQuery = query.trim();
  return {
    ...(normalizedQuery ? { query: normalizedQuery } : {}),
    limit: 100,
    offset: 0,
  };
}
