import { describe, expect, test } from "bun:test";
import { buildContextEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildSourceUnits, expandInitialSourceUnits, refineSourceUnit } from "../src/source";
import type { SourceUnit } from "../src/types";

describe("checkpoint source ledger", () => {
  test("re-expands a prior curator checkpoint into independent source blocks", () => {
    const entry = {
      type: "compaction",
      id: "compact-1",
      parentId: "message-9",
      timestamp: "2026-08-18T00:00:00.000Z",
      summary: "monolithic checkpoint text",
      firstKeptEntryId: "message-8",
      tokensBefore: 100_000,
      details: {
        kind: "pi-context-curator",
        version: 1,
        snapshot: {
          focus: "implement the next phase",
          curationInstruction: "keep only validated work",
          sourceHash: "0123456789abcdef",
        },
        activeBlocks: [
          {
            id: "n1",
            title: "Constraints",
            mode: "summary",
            text: "## Constraints\n\nKeep this rule.",
            sourceUnitIds: ["old-u1"],
            estimatedTokens: 12,
          },
          {
            id: "n2",
            title: "Evidence",
            mode: "exact",
            text: "## Evidence (verbatim)\n\nexact output",
            sourceUnitIds: ["old-u2"],
            estimatedTokens: 15,
          },
        ],
      },
    } as unknown as SessionEntry;

    const units = buildSourceUnits([entry]);

    expect(units).toHaveLength(3);
    expect(units[0]?.text).toContain("Previous focus: implement the next phase");
    expect(units[0]?.text).toContain("Previous curation instruction: keep only validated work");
    expect(units[1]?.text).toContain("Keep this rule.");
    expect(units[2]?.text).toContain("exact output");
    expect(units.map((unit) => unit.id)).toEqual(["u0001", "u0002", "u0003"]);
    expect(units.every((unit) => unit.entryIds[0] === "compact-1")).toBe(true);
  });

  test("falls back to the visible checkpoint when no block ledger exists", () => {
    const entry = {
      type: "compaction",
      id: "compact-old",
      parentId: "message-2",
      timestamp: "2026-08-18T00:00:00.000Z",
      summary: "legacy summary",
      firstKeptEntryId: "message-1",
      tokensBefore: 10_000,
    } as SessionEntry;

    const units = buildSourceUnits([entry]);

    expect(units).toHaveLength(1);
    expect(units[0]?.text).toContain("legacy summary");
  });

  test("a later curate sees only the latest checkpoint, kept raw tail, and newer messages", () => {
    const timestamp = "2026-08-18T00:00:00.000Z";
    const message = (id: string, parentId: string | null, text: string): SessionEntry => ({
      type: "message",
      id,
      parentId,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.parse(timestamp),
      },
    });
    const entries: SessionEntry[] = [
      message("old-a", null, "OLD_A_SECRET"),
      message("old-b", "old-a", "OLD_B_SECRET"),
      message("raw-tail", "old-b", "RAW_TAIL_MUST_SURVIVE"),
      {
        type: "compaction",
        id: "compact-1",
        parentId: "raw-tail",
        timestamp,
        summary: "checkpoint visible text",
        firstKeptEntryId: "raw-tail",
        tokensBefore: 100_000,
        details: {
          kind: "pi-context-curator",
          version: 1,
          snapshot: { focus: "continue C", sourceHash: "0123456789abcdef" },
          activeBlocks: [
            {
              id: "keep-c",
              title: "C",
              mode: "summary",
              text: "ONLY_C_SUMMARY",
              sourceUnitIds: ["old-c"],
              estimatedTokens: 10,
            },
          ],
          archivedBlocks: [
            {
              id: "drop-a-b",
              title: "A and B",
              summary: "ARCHIVED_A_B_SECRET",
              sourceUnitIds: ["old-a", "old-b"],
            },
          ],
        },
      } as SessionEntry,
      message("new-work", "compact-1", "NEW_WORK_AFTER_CURATE"),
    ];

    const activeEntries = buildContextEntries(entries, "new-work");
    const text = buildSourceUnits(activeEntries).map((unit) => unit.text).join("\n");

    expect(activeEntries.map((entry) => entry.id)).toEqual(["compact-1", "raw-tail", "new-work"]);
    expect(text).toContain("ONLY_C_SUMMARY");
    expect(text).toContain("RAW_TAIL_MUST_SURVIVE");
    expect(text).toContain("NEW_WORK_AFTER_CURATE");
    expect(text).not.toContain("OLD_A_SECRET");
    expect(text).not.toContain("OLD_B_SECRET");
    expect(text).not.toContain("ARCHIVED_A_B_SECRET");
  });
});

describe("source refinement", () => {
  test("losslessly splits a single long unit into 2–3 stable fragments", () => {
    const text = `${"first paragraph content ".repeat(30)}\n\n${"second paragraph content ".repeat(30)}\n\n${"third paragraph content ".repeat(30)}`;
    const source: SourceUnit = {
      id: "u0001",
      entryIds: ["message-1"],
      text,
      tokens: 500,
      hash: "original",
    };

    const parts = refineSourceUnit(source, 3);

    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.text).join("")).toBe(text);
    expect(parts.map((part) => part.id)).toEqual(["u0001.1", "u0001.2", "u0001.3"]);
    expect(parts.every((part) => part.entryIds[0] === "message-1")).toBe(true);
  });

  test("pre-splits one large initial turn before the analyzer builds the first decision", () => {
    const text = `${"requirements and decisions ".repeat(35)}\n\n${"implementation and evidence ".repeat(35)}`;
    const source: SourceUnit = {
      id: "u0001",
      entryIds: ["message-1", "message-2"],
      text,
      tokens: 600,
      hash: "original",
    };

    const units = expandInitialSourceUnits([source], 3);

    expect(units.length).toBeGreaterThanOrEqual(2);
    expect(units.length).toBeLessThanOrEqual(3);
    expect(units.map((unit) => unit.text).join("")).toBe(text);
    expect(units.every((unit) => unit.entryIds.join(",") === "message-1,message-2")).toBe(true);
  });
});
