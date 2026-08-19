import type { TraceEventCategory } from "./indexer";

const PAGE_SIZE = 100;

export type SessionListFilters = {
  errorFilter?: "all" | "only";
  status?: "active" | "completed" | "unknown";
  hasTools?: boolean;
};

export type EventFilters = {
  query?: string;
  categories?: TraceEventCategory[];
  toolTypes?: string[];
  errorFilter?: "all" | "only";
};

export function listSessionsInput(
  query: string,
  source: string,
  sort: "updated" | "started" | "events" | "duration" | "errors" = "updated",
  offset = 0,
  limit = PAGE_SIZE,
  filters: SessionListFilters = {},
): {
  query?: string;
  source?: string;
  errorFilter?: "all" | "only";
  status?: "active" | "completed" | "unknown";
  hasTools?: boolean;
  sort?: "updated" | "started" | "events" | "duration" | "errors";
  limit: number;
  offset: number;
} {
  const normalizedQuery = query.trim();
  const normalizedSource = source.trim();
  return {
    ...(normalizedQuery ? { query: normalizedQuery } : {}),
    ...(normalizedSource ? { source: normalizedSource } : {}),
    ...(filters.errorFilter && filters.errorFilter !== "all" ? { errorFilter: filters.errorFilter } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.hasTools ? { hasTools: true } : {}),
    ...(sort !== "updated" ? { sort } : {}),
    limit,
    offset,
  };
}

export function getSessionInput(id: string, limit: number, offset: number, filters: EventFilters = {}): {
  id: string;
  query?: string;
  categories?: TraceEventCategory[];
  toolTypes?: string[];
  errorFilter?: "all" | "only";
  limit: number;
  offset: number;
} {
  const query = filters.query?.trim() ?? "";
  const categories = [...new Set(filters.categories ?? [])].filter(Boolean);
  const toolTypes = [...new Set(filters.toolTypes?.map((value) => value.trim()).filter(Boolean) ?? [])];
  return {
    id,
    ...(query ? { query } : {}),
    ...(categories.length ? { categories } : {}),
    ...(toolTypes.length ? { toolTypes } : {}),
    ...(filters.errorFilter && filters.errorFilter !== "all" ? { errorFilter: filters.errorFilter } : {}),
    limit,
    offset,
  };
}
