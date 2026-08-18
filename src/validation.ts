import type { CoverageReport, CuratorNode } from "./types";

export function validateCoverage(nodes: CuratorNode[], expectedIds: string[]): CoverageReport {
  const expected = new Set(expectedIds);
  const seen = new Map<string, number>();
  const unknown = new Set<string>();

  for (const node of nodes) {
    for (const id of node.sourceUnitIds) {
      if (!expected.has(id)) unknown.add(id);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }

  const missing = expectedIds.filter((id) => !seen.has(id));
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const assigned = expectedIds.filter((id) => seen.has(id));

  return {
    ok: missing.length === 0 && duplicates.length === 0 && unknown.size === 0,
    expected: [...expectedIds],
    assigned,
    missing,
    duplicates,
    unknown: [...unknown],
  };
}
