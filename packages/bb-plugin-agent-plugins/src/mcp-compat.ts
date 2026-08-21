/**
 * MCP list capabilities are optional. Some servers advertise resources but
 * still omit one of the optional list methods; preserve the rest of the
 * connection when a peer answers with JSON-RPC METHOD_NOT_FOUND.
 */
export function isMcpMethodNotFound(error: unknown): boolean {
  if (error !== null && typeof error === "object") {
    const candidate = error as { code?: unknown; data?: { code?: unknown } };
    if (candidate.code === -32601 || candidate.data?.code === -32601) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\bmethod not found\b/i.test(message);
}

export async function optionalMcpCall<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isMcpMethodNotFound(error)) return fallback;
    throw error;
  }
}
