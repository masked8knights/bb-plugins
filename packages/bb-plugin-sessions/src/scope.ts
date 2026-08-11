/** SQL scope predicates shared by search, detail reads, and telemetry. */

export interface ScopeFilter {
  sql: string;
  params: Array<string | number>;
}

/**
 * Build a fail-closed path scope.
 *
 * Exact equality and length-bounded prefix checks avoid SQL wildcard
 * semantics. Stored traversal components are rejected so a malformed cwd or
 * provider path cannot escape a project scope through a lexical prefix.
 */
export function buildScopeFilter(roots: readonly string[], alias = ""): ScopeFilter {
  const filteredRoots = [...new Set(roots.filter((root) => root.trim()))];
  if (filteredRoots.length === 0) return { sql: "1 = 0", params: [] };

  const prefix = alias ? `${alias}.` : "";
  const safePath = (column: string) =>
    `(${column} IS NOT NULL AND ${column} != '..' AND ${column} NOT LIKE '../%' AND ${column} NOT LIKE '%/../%' AND ${column} NOT LIKE '%/..')`;
  const childMatch = (column: string) =>
    `(${safePath(column)} AND length(${column}) > ? AND substr(${column}, 1, ?) = ?)`;
  const clauses = filteredRoots.map(() =>
    `(${prefix}cwd = ? OR ${childMatch(`${prefix}cwd`)} OR ` +
    `${prefix}git_repo_root = ? OR ${childMatch(`${prefix}git_repo_root`)} OR ` +
    `${prefix}file_path = ? OR ${childMatch(`${prefix}file_path`)})`,
  );
  const params = filteredRoots.flatMap((root) => {
    const childPrefix = root.endsWith("/") ? root : `${root}/`;
    const length = childPrefix.length;
    return [
      root, length, length, childPrefix,
      root, length, length, childPrefix,
      root, length, length, childPrefix,
    ];
  });
  return { sql: clauses.join(" OR "), params };
}
