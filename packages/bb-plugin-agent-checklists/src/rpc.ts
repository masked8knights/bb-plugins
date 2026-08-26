// Minimal typed fetch client for this plugin's RPC surface.
//
// Composer plus-menu callbacks are plain functions rather than React
// components, so they cannot use the SDK's useRpc hook.
import type { StandardSchemaV1InferInput, StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk";
import type { rpcContract } from "../server";

type Contract = typeof rpcContract;
type MethodName = keyof Contract;
type InputOf<M extends MethodName> = StandardSchemaV1InferInput<Contract[M]["input"]>;
type ResultOf<M extends MethodName> = StandardSchemaV1InferOutput<Contract[M]["output"]>;

export async function callRpc<M extends MethodName>(
  method: M,
  input: InputOf<M>,
): Promise<ResultOf<M>> {
  const response = await fetch(`/api/v1/plugins/agent-checklists/rpc/${String(method)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: input === null ? "null" : JSON.stringify(input),
  });
  const envelope = (await response.json()) as {
    ok: boolean;
    result?: unknown;
    error?: { message?: string };
  };

  if (!envelope.ok || envelope.result === undefined) {
    throw new Error(envelope.error?.message ?? `rpc ${String(method)} failed`);
  }

  return envelope.result as ResultOf<M>;
}
