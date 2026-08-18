import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import contextCurator, { applyNativeFallback } from "../index";
import { DEFAULT_CONFIG, SESSION_SETTINGS_ENTRY, settingsDraft } from "../src/config";

describe("extension registration", () => {
  test("registers the curator command and lifecycle hooks", () => {
    const commands = new Map<string, unknown>();
    const events: string[] = [];
    const api = {
      registerCommand(name: string, command: unknown) {
        commands.set(name, command);
      },
      on(name: string) {
        events.push(name);
      },
    } as unknown as ExtensionAPI;

    contextCurator(api);

    expect(commands.has("curate")).toBe(true);
    expect(events).toEqual([
      "input",
      "session_before_compact",
      "session_compact",
      "turn_end",
      "agent_settled",
      "session_start",
    ]);
  });

  test("/curate settings persists a model-visible-free session override entry", async () => {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    let appended: { customType: string; data: unknown } | undefined;
    const api = {
      registerCommand(name: string, value: unknown) {
        if (name === "curate") command = value as typeof command;
      },
      on() {},
      appendEntry(customType: string, data: unknown) {
        appended = { customType, data };
      },
    } as unknown as ExtensionAPI;
    contextCurator(api);

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = `/tmp/pi-context-curator-missing-${process.pid}`;
    try {
      const draft = { ...settingsDraft(DEFAULT_CONFIG), thinkingLevel: "medium" as const };
      const ctx = {
        hasUI: true,
        mode: "tui",
        cwd: "/tmp",
        isProjectTrusted: () => false,
        sessionManager: {
          getBranch: () => [],
        },
        modelRegistry: {
          getAvailable: () => [{ provider: "deepseek", id: "deepseek-v4-flash", reasoning: true }],
          find: () => ({ provider: "deepseek", id: "deepseek-v4-flash", reasoning: true }),
        },
        ui: {
          custom: async () => ({ type: "save", draft }),
          notify() {},
        },
      } as unknown as ExtensionCommandContext;

      await command?.handler("settings", ctx);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }

    expect(appended?.customType).toBe(SESSION_SETTINGS_ENTRY);
    expect(appended?.data).toEqual({
      version: 1,
      overrides: expect.objectContaining({ thinkingLevel: "medium", language: "zh" }),
    });
  });

  test("popup mode schedules curator once per context pressure band", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => void>();
    const sent: string[] = [];
    const api = {
      registerCommand() {},
      on(name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => void) {
        handlers.set(name, handler);
      },
      sendUserMessage(content: string) {
        sent.push(content);
      },
    } as unknown as ExtensionAPI;
    contextCurator(api);

    let percent = 85;
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp",
      isProjectTrusted: () => false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ tokens: 85_000, contextWindow: 100_000, percent }),
      sessionManager: {
        getSessionId: () => "session-auto",
        getBranch: () => [
          {
            type: "custom",
            id: "settings",
            parentId: null,
            timestamp: "2026-08-18T00:00:00.000Z",
            customType: SESSION_SETTINGS_ENTRY,
            data: { version: 1, overrides: { triggerMode: "auto" } },
          },
        ],
      },
    } as unknown as ExtensionCommandContext;

    handlers.get("agent_settled")?.({}, ctx);
    handlers.get("agent_settled")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("/curate __context_curator_auto__:session-auto");

    percent = 93;
    handlers.get("agent_settled")?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sent).toHaveLength(2);
  });

  test("manual mode leaves Pi native threshold compaction untouched", () => {
    let beforeCompact: ((event: unknown, ctx: ExtensionCommandContext) => unknown) | undefined;
    const api = {
      registerCommand() {},
      on(name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => unknown) {
        if (name === "session_before_compact") beforeCompact = handler;
      },
    } as unknown as ExtensionAPI;
    contextCurator(api);

    const result = beforeCompact?.(
      { reason: "threshold", customInstructions: undefined },
      {
        sessionManager: {
          getSessionId: () => "manual-session",
        },
      } as unknown as ExtensionCommandContext,
    );
    expect(result).toBeUndefined();
  });

  test("explicit fallback invokes Pi native compaction without curator instructions", async () => {
    let compactOptions: {
      customInstructions?: string;
      onComplete?: (result: unknown) => void;
    } | undefined;
    const statuses: Array<string | undefined> = [];
    const ctx = {
      compact(options: typeof compactOptions) {
        compactOptions = options;
        options?.onComplete?.({});
      },
      ui: {
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
        notify() {},
      },
    } as unknown as ExtensionCommandContext;

    await applyNativeFallback(ctx, "en");

    expect(compactOptions?.customInstructions).toBeUndefined();
    expect(statuses[0]).toContain("Pi native compaction");
    expect(statuses.at(-1)).toBeUndefined();
  });

  test("new input supersedes an active automatic curator without consuming the input", async () => {
    let command: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> } | undefined;
    let inputHandler:
      | ((event: { text: string; source: string }, ctx: ExtensionCommandContext) => unknown)
      | undefined;
    const api = {
      registerCommand(name: string, value: unknown) {
        if (name === "curate") command = value as typeof command;
      },
      on(name: string, handler: unknown) {
        if (name === "input") inputHandler = handler as typeof inputHandler;
      },
    } as unknown as ExtensionAPI;
    contextCurator(api);

    let releaseIdle!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const notices: string[] = [];
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/tmp",
      isProjectTrusted: () => false,
      isIdle: () => true,
      hasPendingMessages: () => false,
      waitForIdle: () => waiting,
      sessionManager: {
        getSessionId: () => "session-auto-input",
        getBranch: () => [
          {
            type: "custom",
            id: "settings",
            parentId: null,
            timestamp: "2026-08-18T00:00:00.000Z",
            customType: SESSION_SETTINGS_ENTRY,
            data: { version: 1, overrides: { language: "en" } },
          },
        ],
      },
      ui: {
        setStatus() {},
        notify(message: string) {
          notices.push(message);
        },
      },
    } as unknown as ExtensionCommandContext;

    const running = command?.handler(
      "__context_curator_auto__:session-auto-input",
      ctx,
    );
    await Promise.resolve();
    const inputResult = inputHandler?.({ text: "continue with this instead", source: "rpc" }, ctx);
    releaseIdle();
    await running;

    expect(inputResult).toEqual({ action: "continue" });
    expect(notices.join("\n")).toContain("new input takes priority");
  });
});
