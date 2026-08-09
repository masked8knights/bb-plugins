import type { DashboardInput } from "./types";

export interface ReindexInput {
  full: boolean;
  providers?: string[];
  hostId?: string;
}

/** Remove absent optional fields before sending an input across the RPC wire. */
export function compactDashboardInput(input: DashboardInput): DashboardInput {
  const compact: DashboardInput = { view: input.view, range: input.range };
  if (input.providers !== undefined) compact.providers = input.providers;
  if (input.source !== undefined) compact.source = input.source;
  if (input.hostId !== undefined) compact.hostId = input.hostId;
  if (input.projectId !== undefined) compact.projectId = input.projectId;
  if (input.model !== undefined) compact.model = input.model;
  if (input.archived !== undefined) compact.archived = input.archived;
  return compact;
}

export function reindexInput(input: DashboardInput): ReindexInput {
  const request: ReindexInput = { full: false };
  if (input.providers !== undefined) request.providers = input.providers;
  if (input.hostId !== undefined) request.hostId = input.hostId;
  return request;
}
