import { describe, expect, test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CuratorOverlay } from "../src/overlay";
import { CuratorLoadingOverlay } from "../src/loading";
import { DEFAULT_CONFIG } from "../src/config";
import type { CuratorNode, CuratorSnapshot, SourceUnit } from "../src/types";

describe("overlay input", () => {
  test("Enter still resolves the selected node when TUI assigns a focused property", async () => {
    const source: SourceUnit = {
      id: "u0001",
      entryIds: ["e1"],
      text: "source",
      tokens: 10,
      hash: "hash",
    };
    const node: CuratorNode = {
      id: "n1",
      title: "Block",
      summary: "summary",
      sourceUnitIds: [source.id],
      recommendedMode: "summary",
      mode: "summary",
      risk: "medium",
      rationale: "reason",
      dependencies: [],
      verbatimEvidence: [],
    };
    const snapshot: CuratorSnapshot = {
      version: 1,
      sessionId: "session",
      leafId: "leaf",
      createdAt: "2026-08-18T00:00:00.000Z",
      focus: "next task",
      activeTokens: 100,
      rawTailTokens: 20,
      rawTailStartEntryId: "tail",
      prefixEntryIds: ["e1"],
      sourceHash: "0123456789abcdef",
    };
    let splitCalls = 0;
    const tui = {
      terminal: { rows: 40 },
      requestRender() {},
    } as unknown as TUI;
    const overlay = new CuratorOverlay(
      tui,
      {} as Theme,
      snapshot,
      [node],
      new Map([[source.id, source]]),
      DEFAULT_CONFIG,
      "boundary",
      false,
      false,
      async () => {
        splitCalls++;
        return [];
      },
      () => {},
    );

    // Pi TUI sets this runtime field on focusable components.
    (overlay as unknown as { focused: boolean }).focused = true;
    overlay.handleInput("\r");
    await Promise.resolve();
    await Promise.resolve();

    expect(splitCalls).toBe(1);
  });

  test("loading overlay animates and Esc aborts the analyzer signal", async () => {
    let renders = 0;
    const tui = {
      terminal: { rows: 40 },
      requestRender() {
        renders++;
      },
    } as unknown as TUI;
    const theme = {
      fg: (_color: string, text: string) => text,
    } as unknown as Theme;
    const loader = new CuratorLoadingOverlay(tui, theme, "Analyzing", "Focus: test", "en");

    const rendered = loader.render(80).join("\n");
    expect(rendered).toContain("Elapsed 0s");
    expect(rendered).toContain("Cancel analysis");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(renders).toBeGreaterThan(0);
    loader.handleInput("\u001b");
    expect(loader.signal.aborted).toBe(true);
    loader.dispose();
  });

  test("Q cancels an in-flight split", async () => {
    const source: SourceUnit = {
      id: "u0001",
      entryIds: ["e1"],
      text: "source",
      tokens: 10,
      hash: "hash",
    };
    const node: CuratorNode = {
      id: "n1",
      title: "Block",
      summary: "summary",
      sourceUnitIds: [source.id],
      recommendedMode: "summary",
      mode: "summary",
      risk: "medium",
      rationale: "reason",
      dependencies: [],
      verbatimEvidence: [],
    };
    const snapshot: CuratorSnapshot = {
      version: 1,
      sessionId: "session",
      leafId: "leaf",
      createdAt: "2026-08-18T00:00:00.000Z",
      focus: "next task",
      activeTokens: 100,
      rawTailTokens: 20,
      rawTailStartEntryId: "tail",
      prefixEntryIds: ["e1"],
      sourceHash: "0123456789abcdef",
    };
    let splitSignal: AbortSignal | undefined;
    const tui = {
      terminal: { rows: 40 },
      requestRender() {},
    } as unknown as TUI;
    const overlay = new CuratorOverlay(
      tui,
      {} as Theme,
      snapshot,
      [node],
      new Map([[source.id, source]]),
      DEFAULT_CONFIG,
      "boundary",
      false,
      false,
      async (_node, signal) => {
        splitSignal = signal;
        return await new Promise<CuratorNode[]>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
      () => {},
    );

    overlay.handleInput("\r");
    await Promise.resolve();
    overlay.handleInput("Q");
    expect(splitSignal?.aborted).toBe(true);
    await Promise.resolve();
    overlay.dispose();
  });

  test("automatic emergency overlay offers skip-to-chat and Pi fallback", () => {
    const source: SourceUnit = {
      id: "u0001",
      entryIds: ["e1"],
      text: "source",
      tokens: 10,
      hash: "hash",
    };
    const node: CuratorNode = {
      id: "n1",
      title: "Block",
      summary: "summary",
      sourceUnitIds: [source.id],
      recommendedMode: "summary",
      mode: "summary",
      risk: "medium",
      rationale: "reason",
      dependencies: [],
      verbatimEvidence: [],
    };
    const snapshot: CuratorSnapshot = {
      version: 1,
      sessionId: "session",
      leafId: "leaf",
      createdAt: "2026-08-18T00:00:00.000Z",
      focus: "next task",
      activeTokens: 95,
      rawTailTokens: 20,
      rawTailStartEntryId: "tail",
      prefixEntryIds: ["e1"],
      sourceHash: "0123456789abcdef",
    };
    let result: import("../src/types").OverlayResult | undefined;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const overlay = new CuratorOverlay(
      { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      theme,
      snapshot,
      [node],
      new Map([[source.id, source]]),
      { ...DEFAULT_CONFIG, language: "en" },
      "boundary",
      true,
      true,
      async () => [],
      (value) => {
        result = value;
      },
    );

    overlay.handleInput("b");
    expect(result?.type).toBe("fallback");
  });

  test("automatic loading explains that Esc returns to chat", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
    } as unknown as Theme;
    const loader = new CuratorLoadingOverlay(
      { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      theme,
      "Analyzing",
      "Focus: test",
      "en",
      true,
    );

    expect(loader.render(100).join("\n")).toContain(
      "Skip this auto-curation and return to chat",
    );
    loader.dispose();
  });

  test("shows short hierarchical labels and opens the curation-instruction input", () => {
    const source: SourceUnit = {
      id: "u0001",
      entryIds: ["e1"],
      text: "source",
      tokens: 10,
      hash: "hash",
    };
    const node: CuratorNode = {
      id: "n1",
      title: "A very long parent title › Another parent title › Keep C",
      displayTitle: "Keep C",
      summary: "summary",
      sourceUnitIds: [source.id],
      recommendedMode: "summary",
      mode: "summary",
      risk: "medium",
      rationale: "reason",
      dependencies: [],
      verbatimEvidence: [],
    };
    const snapshot: CuratorSnapshot = {
      version: 1,
      sessionId: "session",
      leafId: "leaf",
      createdAt: "2026-08-18T00:00:00.000Z",
      focus: "next task with a long description that should adapt to the popup width",
      activeTokens: 100,
      rawTailTokens: 20,
      rawTailStartEntryId: "tail",
      prefixEntryIds: ["e1"],
      sourceHash: "0123456789abcdef",
    };
    let result: import("../src/types").OverlayResult | undefined;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const overlay = new CuratorOverlay(
      { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      theme,
      snapshot,
      [node],
      new Map([[source.id, source]]),
      { ...DEFAULT_CONFIG, language: "en" },
      "boundary",
      false,
      false,
      async () => [],
      (value) => {
        result = value;
      },
    );
    (overlay as unknown as {
      selectTheme: { selectedPrefix: (text: string) => string; selectedText: (text: string) => string };
    }).selectTheme = {
      selectedPrefix: (text) => text,
      selectedText: (text) => text,
    };

    const rendered = overlay.render(58).join("\n");
    expect(rendered).toContain("Keep C");
    expect(rendered).not.toContain("A very long parent title");
    expect(rendered).toContain("F Instruction");

    overlay.handleInput("f");
    expect(result).toEqual({ type: "instruction", applyMode: "boundary" });
  });
});
