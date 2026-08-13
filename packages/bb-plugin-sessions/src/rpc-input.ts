import type { DashboardInput } from "./telemetry";

export function compactReindexInput(input: Pick<DashboardInput, "providers">): { providers?: string[] } {
  return input.providers === undefined ? {} : { providers: input.providers };
}
