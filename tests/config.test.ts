import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  applyConfigOverrides,
  DEFAULT_CONFIG,
  findSessionOverrides,
  SESSION_SETTINGS_ENTRY,
} from "../src/config";

function settingsEntry(id: string, overrides: Record<string, unknown>): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-08-18T00:00:00.000Z",
    customType: SESSION_SETTINGS_ENTRY,
    data: { version: 1, overrides },
  } as SessionEntry;
}

describe("session settings", () => {
  test("latest branch entry wins and reset clears all overrides", () => {
    const first = settingsEntry("one", {
      analyzerModel: "deepseek/deepseek-v4-flash",
      thinkingLevel: "max",
      triggerMode: "auto",
      language: "en",
    });
    const second = settingsEntry("two", {});

    expect(findSessionOverrides([first])).toEqual({
      analyzerModel: "deepseek/deepseek-v4-flash",
      thinkingLevel: "max",
      triggerMode: "auto",
      language: "en",
    });
    expect(findSessionOverrides([first, second])).toEqual({});
  });

  test("validates and clamps persisted overrides without corrupting the file config", () => {
    const base = {
      ...DEFAULT_CONFIG,
      analyzerModel: "openai/gpt-test",
      thinkingLevel: "high" as const,
      rawTailTokens: 24_000,
    };
    const overrides = findSessionOverrides([
      settingsEntry("one", {
        analyzerModel: "invalid",
        thinkingLevel: "unsupported",
        language: "unsupported",
        rawTailTokens: 999_999,
        maxConcurrentAnalyzerCalls: 8,
      }),
    ]);
    const effective = applyConfigOverrides(base, overrides);

    expect(effective.analyzerModel).toBe("openai/gpt-test");
    expect(effective.thinkingLevel).toBe("high");
    expect(effective.language).toBe("zh");
    expect(effective.rawTailTokens).toBe(100_000);
    expect(effective.maxConcurrentAnalyzerCalls).toBe(4);
  });

  test("migrates legacy automatic-curation values to manual/auto", () => {
    expect(findSessionOverrides([settingsEntry("popup", { autoOpenMode: "popup" })])).toEqual({
      triggerMode: "auto",
    });
    expect(findSessionOverrides([settingsEntry("suggest", { autoOpenMode: "suggest" })])).toEqual({
      triggerMode: "manual",
    });
  });
});
