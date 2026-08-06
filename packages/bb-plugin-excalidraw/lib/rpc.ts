// Minimal typed fetch client for this plugin's rpc surface.
//
// Used where hooks can't run (composer plus-menu callbacks, which are plain
// functions, not components). The wire envelope is the same one useRpc
// consumes: { ok: true, result } | { ok: false, error }.
import type { rpcContract } from "../server";

type Contract = typeof rpcContract;
type MethodName = keyof Contract;
type InputOf<M extends MethodName> = Parameters<Contract[M]["input"]["parse"]>[0];
type ResultOf<M extends MethodName> = ReturnType<Contract[M]["output"]["parse"]>;

export async function callRpc<M extends MethodName>(
  method: M,
  input: InputOf<M>,
): Promise<ResultOf<M>> {
  const res = await fetch(`/api/v1/plugins/excalidraw/rpc/${String(method)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input === null ? "null" : JSON.stringify(input),
  });
  const envelope = (await res.json()) as {
    ok: boolean;
    result?: unknown;
    error?: { message?: string };
  };
  if (!envelope.ok || envelope.result === undefined) {
    throw new Error(
      envelope.error?.message ?? `rpc ${String(method)} failed`,
    );
  }
  return envelope.result as ResultOf<M>;
}
