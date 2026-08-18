import { describe, expect, test } from "bun:test";
import { validateCoverage } from "../src/validation";
import {
  cloneNodes,
  compileCheckpoint,
  dependencyWarnings,
  leafNodes,
} from "../src/compiler";
import type { CuratorNode, CuratorSnapshot, SourceUnit } from "../src/types";

const units: SourceUnit[] = [
  { id: "u0001", entryIds: ["e1"], text: "User requires exact.apk", tokens: 20, hash: "a" },
  { id: "u0002", entryIds: ["e2"], text: "Build passed", tokens: 10, hash: "b" },
  { id: "u0003", entryIds: ["e3"], text: "Repeated logs", tokens: 30, hash: "c" },
];

const snapshot: CuratorSnapshot = {
  version: 1,
  sessionId: "session",
  leafId: "leaf",
  createdAt: "2026-08-18T00:00:00.000Z",
  focus: "Finish validation",
  activeTokens: 100,
  rawTailTokens: 20,
  rawTailStartEntryId: "tail",
  prefixEntryIds: ["e1", "e2", "e3"],
  sourceHash: "0123456789abcdef",
};

function node(partial: Partial<CuratorNode> & Pick<CuratorNode, "id" | "title" | "sourceUnitIds">): CuratorNode {
  return {
    summary: "summary",
    recommendedMode: "summary",
    mode: "summary",
    risk: "medium",
    rationale: "reason",
    dependencies: [],
    verbatimEvidence: [],
    ...partial,
  };
}

describe("coverage", () => {
  test("requires a disjoint complete partition", () => {
    const nodes = [
      node({ id: "n1", title: "A", sourceUnitIds: ["u0001", "u0002"] }),
      node({ id: "n2", title: "B", sourceUnitIds: ["u0003"] }),
    ];
    expect(validateCoverage(nodes, units.map((unit) => unit.id)).ok).toBe(true);
  });

  test("reports missing, duplicate and unknown ids", () => {
    const nodes = [
      node({ id: "n1", title: "A", sourceUnitIds: ["u0001", "u0001", "other"] }),
    ];
    const report = validateCoverage(nodes, units.map((unit) => unit.id));
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(["u0002", "u0003"]);
    expect(report.duplicates).toEqual(["u0001"]);
    expect(report.unknown).toEqual(["other"]);
  });
});

describe("checkpoint compiler", () => {
  test("uses only leaf selections and archives dropped blocks", () => {
    const children = [
      node({
        id: "n1a",
        title: "Constraint",
        sourceUnitIds: ["u0001"],
        mode: "exact",
      }),
      node({
        id: "n1b",
        title: "Validation",
        sourceUnitIds: ["u0002"],
        summary: "Build passed",
      }),
    ];
    const nodes = [
      node({ id: "n1", title: "Parent", sourceUnitIds: ["u0001", "u0002"], children }),
      node({ id: "n2", title: "Noise", sourceUnitIds: ["u0003"], mode: "drop" }),
    ];
    const compiled = compileCheckpoint(
      snapshot,
      nodes,
      new Map(units.map((unit) => [unit.id, unit])),
      true,
      "en",
    );
    expect(compiled.text).toContain("User requires exact.apk");
    expect(compiled.text).toContain("Build passed");
    expect(compiled.text).toContain("Archived Context Available");
    expect(compiled.archivedBlocks).toHaveLength(1);
    expect(leafNodes(nodes)).toHaveLength(3);
  });

  test("keeps dropped summaries out of the active checkpoint by default", () => {
    const nodes = [
      node({ id: "n1", title: "Keep", sourceUnitIds: ["u0001"] }),
      node({
        id: "n2",
        title: "Excluded topic",
        summary: "SENSITIVE_DROPPED_SUMMARY",
        sourceUnitIds: ["u0002", "u0003"],
        mode: "drop",
      }),
    ];
    const compiled = compileCheckpoint(snapshot, nodes, new Map(units.map((unit) => [unit.id, unit])), false);
    expect(compiled.text).not.toContain("SENSITIVE_DROPPED_SUMMARY");
    expect(compiled.text).not.toContain("Excluded topic");
    expect(compiled.archivedBlocks[0]?.summary).toBe("SENSITIVE_DROPPED_SUMMARY");
  });

  test("clone is independent", () => {
    const original = [node({ id: "n1", title: "A", sourceUnitIds: ["u0001"] })];
    const cloned = cloneNodes(original);
    cloned[0].sourceUnitIds.push("u0002");
    expect(original[0].sourceUnitIds).toEqual(["u0001"]);
  });

  test("warns when a kept node depends on a dropped node", () => {
    const nodes = [
      node({ id: "n1", title: "Decision", sourceUnitIds: ["u0001"], dependencies: ["Identity"] }),
      node({ id: "n2", title: "Identity", sourceUnitIds: ["u0002"], mode: "drop" }),
    ];
    expect(dependencyWarnings(nodes)).toEqual(["Decision 依赖已排除块：Identity"]);
    expect(dependencyWarnings(nodes, "en")).toEqual([
      "Decision depends on excluded block: Identity",
    ]);
  });

  test("compiles checkpoint chrome in the selected language", () => {
    const nodes = [node({ id: "n1", title: "Decision", sourceUnitIds: ["u0001"] })];
    const unitById = new Map(units.map((unit) => [unit.id, unit]));

    expect(compileCheckpoint(snapshot, nodes, unitById, false, "zh").text).toContain(
      "# 交互式上下文检查点",
    );
    expect(compileCheckpoint(snapshot, nodes, unitById, false, "en").text).toContain(
      "# Interactive Context Checkpoint",
    );
  });

  test("uses short display titles and records the reviewed curation instruction", () => {
    const curatedSnapshot = {
      ...snapshot,
      curationInstruction: "Keep only validation evidence",
    };
    const nodes = [
      node({
        id: "n1",
        title: "Very long parent path › Validation",
        displayTitle: "Validation",
        sourceUnitIds: ["u0002"],
      }),
    ];
    const compiled = compileCheckpoint(
      curatedSnapshot,
      nodes,
      new Map(units.map((unit) => [unit.id, unit])),
      false,
      "en",
    );

    expect(compiled.text).toContain("## Curation Instruction\n\nKeep only validation evidence");
    expect(compiled.text).toContain("## Validation");
    expect(compiled.text).not.toContain("Very long parent path");
  });
});
