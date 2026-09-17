import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  applyConfigOverrides,
  DEFAULT_CONFIG,
  findSessionOverrides,
  loadConfigLayers,
  SESSION_SETTINGS_ENTRY,
  settingsDraft,
  settingsOverrides,
  writeSettingsOverrides,
} from "../src/config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  test("global and project files keep sparse inheritance and preserve advanced fields", () => {
    const root = mkdtempSync(join(tmpdir(), "curator-scopes-"));
    temporaryDirectories.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    const globalPath = join(agentDir, "context-curator.json");
    writeSettingsOverrides(globalPath, {});
    writeFileSync(globalPath, JSON.stringify({ enabled: false, archiveIndex: true }));

    const globalDraft = {
      ...settingsDraft(DEFAULT_CONFIG),
      analyzerModel: "openai/test-model",
    };
    writeSettingsOverrides(globalPath, settingsOverrides(globalDraft, DEFAULT_CONFIG));
    let layers = loadConfigLayers(agentDir, cwd, true);
    expect(layers.global.analyzerModel).toBe("openai/test-model");
    expect(layers.global.enabled).toBe(false);
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toMatchObject({
      enabled: false,
      archiveIndex: true,
      analyzerModel: "openai/test-model",
    });

    const projectDraft = { ...settingsDraft(layers.global), thinkingLevel: "high" as const };
    writeSettingsOverrides(
      layers.projectPath,
      settingsOverrides(projectDraft, layers.global),
    );
    layers = loadConfigLayers(agentDir, cwd, true);
    expect(layers.project.analyzerModel).toBe("openai/test-model");
    expect(layers.project.thinkingLevel).toBe("high");
    expect(JSON.parse(readFileSync(layers.projectPath, "utf8"))).toEqual({ thinkingLevel: "high" });

    writeSettingsOverrides(layers.projectPath, {});
    layers = loadConfigLayers(agentDir, cwd, true);
    expect(layers.project.thinkingLevel).toBe(layers.global.thinkingLevel);
    expect(layers.hasProjectOverride).toBe(false);
  });
});
