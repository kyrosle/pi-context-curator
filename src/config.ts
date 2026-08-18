import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  CuratorConfig,
  CuratorSessionOverrides,
  CuratorSettingsDraft,
  CuratorSettingsEntry,
} from "./types";

export const SESSION_SETTINGS_ENTRY = "pi-context-curator-settings";

export const DEFAULT_CONFIG: CuratorConfig = {
  enabled: true,
  language: "zh",
  analyzerModel: "deepseek/deepseek-v4-flash",
  thinkingLevel: "low",
  triggerMode: "manual",
  confirmCrossProvider: true,
  maxConcurrentAnalyzerCalls: 3,
  rawTailTokens: 16_000,
  targetCheckpointTokens: 24_000,
  maxAnalyzerInputTokens: 600_000,
  maxBlocksPerSplit: 3,
  archiveIndex: false,
  notifyPercent: 65,
  strongNotifyPercent: 80,
  emergencyPercent: 92,
  defaultApplyMode: "boundary",
};

function asFiniteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

function normalizeConfig(raw: Record<string, unknown>, fallback: CuratorConfig): CuratorConfig {
  const language = raw.language;
  const thinking = raw.thinkingLevel;
  const triggerMode = raw.triggerMode;
  const legacyAutoOpenMode = raw.autoOpenMode;
  const applyMode = raw.defaultApplyMode;
  const blocks = raw.maxBlocksPerSplit;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
    language: language === "zh" || language === "en" ? language : fallback.language,
    analyzerModel:
      typeof raw.analyzerModel === "string" && raw.analyzerModel.includes("/")
        ? raw.analyzerModel
        : fallback.analyzerModel,
    thinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
      String(thinking),
    )
      ? (thinking as CuratorConfig["thinkingLevel"])
      : fallback.thinkingLevel,
    triggerMode:
      triggerMode === "manual" || triggerMode === "auto"
        ? triggerMode
        : legacyAutoOpenMode === "popup"
          ? "auto"
          : legacyAutoOpenMode === "off" || legacyAutoOpenMode === "suggest"
            ? "manual"
            : fallback.triggerMode,
    confirmCrossProvider:
      typeof raw.confirmCrossProvider === "boolean"
        ? raw.confirmCrossProvider
        : fallback.confirmCrossProvider,
    maxConcurrentAnalyzerCalls: asFiniteNumber(
      raw.maxConcurrentAnalyzerCalls,
      fallback.maxConcurrentAnalyzerCalls,
      1,
      4,
    ),
    rawTailTokens: asFiniteNumber(raw.rawTailTokens, fallback.rawTailTokens, 1_000, 100_000),
    targetCheckpointTokens: asFiniteNumber(
      raw.targetCheckpointTokens,
      fallback.targetCheckpointTokens,
      2_000,
      200_000,
    ),
    maxAnalyzerInputTokens: asFiniteNumber(
      raw.maxAnalyzerInputTokens,
      fallback.maxAnalyzerInputTokens,
      20_000,
      900_000,
    ),
    maxBlocksPerSplit: blocks === 2 || blocks === 3 ? blocks : fallback.maxBlocksPerSplit,
    archiveIndex: typeof raw.archiveIndex === "boolean" ? raw.archiveIndex : fallback.archiveIndex,
    notifyPercent: asFiniteNumber(raw.notifyPercent, fallback.notifyPercent, 20, 95),
    strongNotifyPercent: asFiniteNumber(
      raw.strongNotifyPercent,
      fallback.strongNotifyPercent,
      30,
      98,
    ),
    emergencyPercent: asFiniteNumber(raw.emergencyPercent, fallback.emergencyPercent, 50, 99),
    defaultApplyMode:
      applyMode === "handoff" || applyMode === "boundary"
        ? applyMode
        : fallback.defaultApplyMode,
  };
}

export function loadConfig(agentDir: string, cwd: string, includeProjectConfig = true): CuratorConfig {
  const candidates = [
    join(agentDir, "context-curator.json"),
    ...(includeProjectConfig ? [join(cwd, ".pi", "context-curator.json")] : []),
  ];

  let raw: Record<string, unknown> = {};
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        raw = { ...raw, ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Invalid configuration is ignored. /curate status reports effective defaults.
    }
  }

  return normalizeConfig(raw, DEFAULT_CONFIG);
}

export function applyConfigOverrides(
  base: CuratorConfig,
  overrides: CuratorSessionOverrides,
): CuratorConfig {
  return normalizeConfig({ ...base, ...overrides }, base);
}

export function settingsDraft(config: CuratorConfig): CuratorSettingsDraft {
  return {
    language: config.language,
    analyzerModel: config.analyzerModel,
    thinkingLevel: config.thinkingLevel,
    triggerMode: config.triggerMode,
    confirmCrossProvider: config.confirmCrossProvider,
    maxConcurrentAnalyzerCalls: config.maxConcurrentAnalyzerCalls,
    rawTailTokens: config.rawTailTokens,
    targetCheckpointTokens: config.targetCheckpointTokens,
    maxAnalyzerInputTokens: config.maxAnalyzerInputTokens,
    maxBlocksPerSplit: config.maxBlocksPerSplit,
    defaultApplyMode: config.defaultApplyMode,
  };
}

function sanitizeOverrides(raw: unknown): CuratorSessionOverrides {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const normalized = normalizeConfig(value, DEFAULT_CONFIG);
  const result: CuratorSessionOverrides = {};
  if (value.language === "zh" || value.language === "en") {
    result.language = value.language;
  }
  if (typeof value.analyzerModel === "string" && value.analyzerModel.includes("/")) {
    result.analyzerModel = normalized.analyzerModel;
  }
  if (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value.thinkingLevel))) {
    result.thinkingLevel = normalized.thinkingLevel;
  }
  if (value.triggerMode === "manual" || value.triggerMode === "auto") {
    result.triggerMode = value.triggerMode;
  } else if (value.autoOpenMode === "popup") {
    result.triggerMode = "auto";
  } else if (value.autoOpenMode === "off" || value.autoOpenMode === "suggest") {
    result.triggerMode = "manual";
  }
  if (typeof value.confirmCrossProvider === "boolean") {
    result.confirmCrossProvider = normalized.confirmCrossProvider;
  }
  for (const key of [
    "maxConcurrentAnalyzerCalls",
    "rawTailTokens",
    "targetCheckpointTokens",
    "maxAnalyzerInputTokens",
  ] as const) {
    if (typeof value[key] === "number" && Number.isFinite(value[key])) result[key] = normalized[key];
  }
  if (value.maxBlocksPerSplit === 2 || value.maxBlocksPerSplit === 3) {
    result.maxBlocksPerSplit = value.maxBlocksPerSplit;
  }
  if (value.defaultApplyMode === "boundary" || value.defaultApplyMode === "handoff") {
    result.defaultApplyMode = value.defaultApplyMode;
  }
  return result;
}

export function findSessionOverrides(entries: SessionEntry[]): CuratorSessionOverrides {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== SESSION_SETTINGS_ENTRY) continue;
    const data = entry.data as Partial<CuratorSettingsEntry> | undefined;
    if (data?.version !== 1) continue;
    return sanitizeOverrides(data.overrides);
  }
  return {};
}
