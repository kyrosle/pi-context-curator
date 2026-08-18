import type { CuratorLanguage, RetentionMode } from "./types";

export function localize(language: CuratorLanguage, zh: string, en: string): string {
  return language === "zh" ? zh : en;
}

export function languageName(language: CuratorLanguage): string {
  return language === "zh" ? "中文" : "English";
}

export function analyzerOutputLanguage(language: CuratorLanguage): string {
  return language === "zh" ? "Simplified Chinese (zh-CN)" : "English";
}

export function displayRisk(
  language: CuratorLanguage,
  risk: "low" | "medium" | "high",
): string {
  if (language === "en") return risk.toUpperCase();
  return risk === "low" ? "低" : risk === "medium" ? "中" : "高";
}

export function displayMode(language: CuratorLanguage, mode: RetentionMode | "split"): string {
  if (language === "en") return mode;
  if (mode === "summary") return "摘要";
  if (mode === "exact") return "原样";
  if (mode === "drop") return "排除";
  return "已拆分";
}

export function joinLocalized(language: CuratorLanguage, items: string[]): string {
  return items.join(language === "zh" ? "、" : ", ");
}
