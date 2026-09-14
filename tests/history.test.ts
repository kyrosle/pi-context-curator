import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import contextCurator from "../index";
import { collectCuratorHistory, parseCuratorPlanDetails } from "../src/history";
import { CuratorHistoryOverlay } from "../src/history-overlay";
import type {
  CuratorHistoryRecord,
  CuratorNode,
  CuratorPlanDetails,
  HistoryOverlayResult,
} from "../src/types";

function node(id: string, mode: CuratorNode["mode"] = "summary"): CuratorNode {
  return {
    id,
    title: `Block ${id}`,
    summary: `Summary ${id}`,
    sourceUnitIds: [`u-${id}`],
    recommendedMode: mode,
    mode,
    risk: "medium",
    rationale: "reason",
    dependencies: [],
    verbatimEvidence: [],
  };
}

function details(
  createdAt: string,
  focus: string,
  nodes: CuratorNode[],
): CuratorPlanDetails {
  const dropped = nodes.filter((candidate) => candidate.mode === "drop");
  return {
    kind: "pi-context-curator",
    version: 1,
    snapshot: {
      version: 1,
      sessionId: "session-history",
      leafId: `leaf-${createdAt}`,
      createdAt,
      focus,
      activeTokens: 180_000,
      rawTailTokens: 16_000,
      rawTailStartEntryId: "tail",
      prefixEntryIds: ["source"],
      sourceHash: "0123456789abcdef0123456789abcdef",
    },
    analyzerModel: "deepseek/deepseek-v4-flash",
    language: "en",
    nodes,
    coverage: {
      ok: true,
      expected: nodes.flatMap((candidate) => candidate.sourceUnitIds),
      assigned: nodes.flatMap((candidate) => candidate.sourceUnitIds),
      missing: [],
      duplicates: [],
      unknown: [],
    },
    checkpointTokens: 24_000,
    activeBlocks: [],
    archivedBlocks: dropped.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      sourceUnitIds: candidate.sourceUnitIds,
    })),
  };
}

function compaction(
  id: string,
  parentId: string,
  timestamp: string,
  plan: CuratorPlanDetails | unknown,
): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp,
    summary: "checkpoint",
    firstKeptEntryId: "tail",
    tokensBefore: 180_000,
    details: plan,
  } as SessionEntry;
}

describe("curator history model", () => {
  test("collects every valid Curator checkpoint newest-first and ignores malformed/native entries", () => {
    const older = details("2026-08-18T10:00:00.000Z", "older focus", [node("old-drop", "drop")]);
    const newer = details("2026-08-19T10:00:00.000Z", "newer focus", [node("new-keep")]);
    const branch = [
      compaction("old", "before-old", older.snapshot.createdAt, older),
      compaction("native", "old", "2026-08-18T12:00:00.000Z", undefined),
      compaction("broken", "native", "2026-08-18T13:00:00.000Z", { kind: "pi-context-curator", version: 1 }),
      compaction("new", "broken", newer.snapshot.createdAt, newer),
    ];

    const records = collectCuratorHistory(branch);
    expect(records.map((record) => record.entryId)).toEqual(["new", "old"]);
    expect(records[0].projectedTokens).toBe(40_000);
    expect(records[1].details.archivedBlocks[0]?.id).toBe("old-drop");
    expect(parseCuratorPlanDetails({ kind: "pi-context-curator", version: 1 })).toBeUndefined();
  });
});

describe("history overlay", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const tui = {
    terminal: { rows: 40 },
    requestRender() {},
  } as unknown as TUI;

  test("browses metadata without exposing it to chat and restores the selected Drop block", () => {
    const plan = details("2026-08-19T10:00:00.000Z", "keep C", [node("drop-a", "drop"), node("keep-c")]);
    const record: CuratorHistoryRecord = {
      entryId: "checkpoint",
      parentId: "before",
      timestamp: plan.snapshot.createdAt,
      tokensBefore: 180_000,
      projectedTokens: 40_000,
      details: plan,
    };
    let result: HistoryOverlayResult | undefined;
    const overlay = new CuratorHistoryOverlay(tui, theme, [record], "en", (value) => {
      result = value;
    });

    expect(overlay.render(90).join("\n")).toContain("Browsing is read-only");
    overlay.handleInput("\r");
    expect(overlay.render(90).join("\n")).toContain("Block drop-a");
    overlay.handleInput("r");
    expect(result).toEqual({
      type: "restore",
      checkpointEntryId: "checkpoint",
      blockId: "drop-a",
    });
  });

  test("requests a safe fork from the selected checkpoint", () => {
    const plan = details("2026-08-19T10:00:00.000Z", "focus", [node("keep")]);
    let result: HistoryOverlayResult | undefined;
    const overlay = new CuratorHistoryOverlay(
      tui,
      theme,
      [{
        entryId: "checkpoint",
        parentId: "before",
        timestamp: plan.snapshot.createdAt,
        tokensBefore: 180_000,
        projectedTokens: 40_000,
        details: plan,
      }],
      "en",
      (value) => {
        result = value;
      },
    );
    overlay.handleInput("f");
    expect(result).toEqual({ type: "fork", checkpointEntryId: "checkpoint" });
  });
});

describe("history command integration", () => {
  test("keeps the TUI-only popup inert in RPC mode", async () => {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    let opened = false;
    const plan = details("2026-08-19T10:00:00.000Z", "focus", [node("drop", "drop")]);
    const branch = [compaction("checkpoint", "before", plan.snapshot.createdAt, plan)];
    const api = {
      registerCommand(name: string, value: unknown) {
        if (name === "curate") command = value as typeof command;
      },
      on() {},
    } as unknown as ExtensionAPI;
    contextCurator(api);
    const ctx = {
      mode: "rpc",
      cwd: "/tmp",
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom: async () => {
          opened = true;
          return undefined;
        },
        notify() {},
      },
    } as unknown as ExtensionCommandContext;

    await command?.handler("history", ctx);
    expect(opened).toBe(false);
  });

  test("browsing and cancelling has no model-context side effect", async () => {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    let sends = 0;
    const plan = details("2026-08-19T10:00:00.000Z", "focus", [node("drop", "drop")]);
    const branch = [compaction("checkpoint", "before", plan.snapshot.createdAt, plan)];
    const api = {
      registerCommand(name: string, value: unknown) {
        if (name === "curate") command = value as typeof command;
      },
      on() {},
      sendMessage() {
        sends++;
      },
    } as unknown as ExtensionAPI;
    contextCurator(api);
    const ctx = {
      mode: "tui",
      cwd: "/tmp",
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom: async () => ({ type: "cancel" }),
        notify() {},
      },
    } as unknown as ExtensionCommandContext;

    await command?.handler("history", ctx);
    expect(sends).toBe(0);
  });

  test("restores an archived summary from an older checkpoint, not only the latest one", async () => {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    let sent: { content?: string; details?: unknown } | undefined;
    const older = details("2026-08-18T10:00:00.000Z", "older", [node("old-drop", "drop")]);
    const newer = details("2026-08-19T10:00:00.000Z", "newer", [node("new-drop", "drop")]);
    const branch = [
      compaction("old-checkpoint", "before-old", older.snapshot.createdAt, older),
      compaction("new-checkpoint", "before-new", newer.snapshot.createdAt, newer),
    ];
    const api = {
      registerCommand(name: string, value: unknown) {
        if (name === "curate") command = value as typeof command;
      },
      on() {},
      sendMessage(message: { content?: string; details?: unknown }) {
        sent = message;
      },
    } as unknown as ExtensionAPI;
    contextCurator(api);
    const ctx = {
      mode: "tui",
      cwd: "/tmp",
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom: async () => ({
          type: "restore",
          checkpointEntryId: "old-checkpoint",
          blockId: "old-drop",
        }),
        notify() {},
      },
    } as unknown as ExtensionCommandContext;

    await command?.handler("history", ctx);

    expect(sent?.content).toContain("Summary old-drop");
    expect(sent?.details).toEqual(expect.objectContaining({
      checkpointEntryId: "old-checkpoint",
    }));
  });

  test("fails closed if the selected checkpoint leaves the active branch", async () => {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    let sends = 0;
    let reads = 0;
    const plan = details("2026-08-19T10:00:00.000Z", "focus", [node("drop", "drop")]);
    const branch = [compaction("checkpoint", "before", plan.snapshot.createdAt, plan)];
    const api = {
      registerCommand(name: string, value: unknown) {
        if (name === "curate") command = value as typeof command;
      },
      on() {},
      sendMessage() {
        sends++;
      },
    } as unknown as ExtensionAPI;
    contextCurator(api);
    const ctx = {
      mode: "tui",
      cwd: "/tmp",
      isProjectTrusted: () => false,
      sessionManager: {
        getBranch: () => reads++ < 2 ? branch : [],
      },
      ui: {
        custom: async () => ({
          type: "restore",
          checkpointEntryId: "checkpoint",
          blockId: "drop",
        }),
        notify() {},
      },
    } as unknown as ExtensionCommandContext;

    await command?.handler("history", ctx);
    expect(sends).toBe(0);
  });

  test("forks a new session from the selected pre-curation parent", async () => {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    let forkedFrom: string | undefined;
    const plan = details("2026-08-19T10:00:00.000Z", "focus", [node("keep")]);
    const branch = [compaction("checkpoint", "before-checkpoint", plan.snapshot.createdAt, plan)];
    const api = {
      registerCommand(name: string, value: unknown) {
        if (name === "curate") command = value as typeof command;
      },
      on() {},
    } as unknown as ExtensionAPI;
    contextCurator(api);
    const ctx = {
      mode: "tui",
      cwd: "/tmp",
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => branch },
      ui: {
        custom: async () => ({ type: "fork", checkpointEntryId: "checkpoint" }),
        confirm: async () => true,
        notify() {},
      },
      async fork(entryId: string, options: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> }) {
        forkedFrom = entryId;
        await options.withSession?.({ ui: { notify() {} } } as unknown as ExtensionCommandContext);
        return { cancelled: false };
      },
    } as unknown as ExtensionCommandContext;

    await command?.handler("history", ctx);
    expect(forkedFrom).toBe("before-checkpoint");
  });
});
