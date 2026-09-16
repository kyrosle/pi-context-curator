import { expect, test } from "bun:test";
import { compact, type ExtensionContext, type SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { compactAutomatically } from "../src/native-compaction";
import { DEFAULT_CONFIG } from "../src/config";

test("automatic threshold and overflow reuse native preparation with the selected model; manual and owned calls pass through", async () => {
  const model = { provider: "opencode-go", id: "deepseek-v4.1-flash", reasoning: true };
  const warnings: string[] = [];
  const ctx = {
    hasUI: true,
    sessionManager: { getSessionId: () => "session-native" },
    modelRegistry: {
      find: () => model,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
      getProvider: () => undefined,
    },
    ui: { notify: (text: string) => warnings.push(text) },
  } as unknown as ExtensionContext;
  const controller = new AbortController();
  const event = {
    reason: "threshold", signal: controller.signal,
    preparation: { firstKeptEntryId: "tail", previousSummary: "kept summary", fileOps: { read: new Set(), edited: new Set() } },
    branchEntries: [{ type: "compaction", details: { kind: "pi-context-curator-native", readFiles: ["old.ts"], modifiedFiles: ["edit.ts"] } }],
  } as unknown as SessionBeforeCompactEvent;
  let calls = 0;
  const summarize = (async (preparation, selected, key, headers, _instructions, signal, thinking, _stream, _env, _retry, _callbacks, sessionId) => {
    calls++;
    expect(selected).toBe(model);
    expect(key).toBe("test-key");
    expect(thinking).toBe("low");
    expect(headers).toEqual({
      "x-opencode-session": "session-native",
      "x-opencode-client": "pi",
    });
    expect(sessionId).toBe("session-native");
    expect(signal).toBe(controller.signal);
    expect(preparation.firstKeptEntryId).toBe("tail");
    expect(preparation.previousSummary).toBe("kept summary");
    expect([...preparation.fileOps.read]).toEqual(["old.ts"]);
    expect([...preparation.fileOps.edited]).toEqual(["edit.ts"]);
    return { summary: "native result", firstKeptEntryId: "tail", tokensBefore: 123, details: { readFiles: ["old.ts"], modifiedFiles: ["edit.ts"] } };
  }) as typeof compact;
  for (const reason of ["threshold", "overflow"] as const) {
    const result = await compactAutomatically(
      { ...event, reason },
      ctx,
      { ...DEFAULT_CONFIG, analyzerModel: "opencode-go/deepseek-v4.1-flash" },
      summarize,
    );
    expect(result?.compaction?.summary).toBe("native result");
    expect(result?.compaction?.details.kind).toBe("pi-context-curator-native");
  }
  expect(event.preparation.fileOps.read.size).toBe(0);
  const config = { ...DEFAULT_CONFIG, analyzerModel: "opencode-go/deepseek-v4.1-flash" };
  expect(await compactAutomatically({ ...event, reason: "manual" }, ctx, config, summarize)).toBeUndefined();
  expect(await compactAutomatically({ ...event, customInstructions: "context-curator:plan" }, ctx, config, summarize)).toBeUndefined();
  expect(await compactAutomatically(event, ctx, { ...DEFAULT_CONFIG, enabled: false }, summarize)).toBeUndefined();
  expect(calls).toBe(2);
  const fail = (async () => { throw new Error("provider failed"); }) as typeof compact;
  expect(await compactAutomatically(event, ctx, config, fail)).toBeUndefined();
  expect(warnings[0]).toContain("provider failed");
  controller.abort();
  expect(await compactAutomatically(event, ctx, config, summarize)).toEqual({ cancel: true });
  expect(calls).toBe(2);
});
