import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type RetentionMode = "summary" | "exact" | "drop";
export type CuratorLanguage = "zh" | "en";
export type CuratorTrigger = "manual" | "auto";

export interface SourceUnit {
  id: string;
  entryIds: string[];
  text: string;
  tokens: number;
  hash: string;
}

export interface CuratorNode {
  id: string;
  title: string;
  /** Short local label for display when title contains a fully-qualified hierarchy path. */
  displayTitle?: string;
  summary: string;
  sourceUnitIds: string[];
  recommendedMode: RetentionMode;
  mode: RetentionMode;
  risk: "low" | "medium" | "high";
  rationale: string;
  dependencies: string[];
  verbatimEvidence: string[];
  children?: CuratorNode[];
}

export interface CuratorSnapshot {
  version: 1;
  sessionId: string;
  sessionFile?: string;
  leafId: string;
  createdAt: string;
  focus: string;
  curationInstruction?: string;
  activeTokens: number;
  rawTailTokens: number;
  rawTailStartEntryId: string;
  prefixEntryIds: string[];
  sourceHash: string;
}

export interface CoverageReport {
  ok: boolean;
  expected: string[];
  assigned: string[];
  missing: string[];
  duplicates: string[];
  unknown: string[];
}

export interface CuratorPlanDetails {
  kind: "pi-context-curator";
  version: 1;
  snapshot: CuratorSnapshot;
  analyzerModel: string;
  language?: CuratorLanguage;
  nodes: CuratorNode[];
  coverage: CoverageReport;
  checkpointTokens: number;
  activeBlocks?: CompiledActiveBlock[];
  archivedBlocks: Array<{
    id: string;
    title: string;
    summary: string;
    sourceUnitIds: string[];
  }>;
}

export interface CompiledActiveBlock {
  id: string;
  title: string;
  mode: Exclude<RetentionMode, "drop">;
  text: string;
  sourceUnitIds: string[];
  estimatedTokens: number;
}

export interface CuratorConfig {
  enabled: boolean;
  language: CuratorLanguage;
  analyzerModel: string;
  thinkingLevel: ModelThinkingLevel;
  triggerMode: "manual" | "auto";
  confirmCrossProvider: boolean;
  maxConcurrentAnalyzerCalls: number;
  rawTailTokens: number;
  targetCheckpointTokens: number;
  maxAnalyzerInputTokens: number;
  maxBlocksPerSplit: 2 | 3;
  archiveIndex: boolean;
  notifyPercent: number;
  strongNotifyPercent: number;
  emergencyPercent: number;
  defaultApplyMode: "boundary" | "handoff";
}

export type CuratorSettingsDraft = Pick<
  CuratorConfig,
  | "language"
  | "analyzerModel"
  | "thinkingLevel"
  | "triggerMode"
  | "confirmCrossProvider"
  | "maxConcurrentAnalyzerCalls"
  | "rawTailTokens"
  | "targetCheckpointTokens"
  | "maxAnalyzerInputTokens"
  | "maxBlocksPerSplit"
  | "defaultApplyMode"
>;

export type CuratorSessionOverrides = Partial<CuratorSettingsDraft>;

export interface CuratorSettingsEntry {
  version: 1;
  overrides: CuratorSessionOverrides;
}

export type SettingsOverlayResult =
  | { type: "cancel" }
  | { type: "choose-model"; draft: CuratorSettingsDraft }
  | { type: "save"; draft: CuratorSettingsDraft }
  | { type: "reset" };

export interface CompiledCheckpoint {
  text: string;
  estimatedTokens: number;
  activeBlocks: CompiledActiveBlock[];
  archivedBlocks: CuratorPlanDetails["archivedBlocks"];
}

export interface PendingApplication {
  planId: string;
  snapshot: CuratorSnapshot;
  details: CuratorPlanDetails;
  checkpoint: CompiledCheckpoint;
  firstKeptEntryId: string;
}

export type OverlayResult =
  | { type: "cancel" }
  | { type: "fallback" }
  | { type: "instruction"; applyMode: "boundary" | "handoff" }
  | { type: "settings"; applyMode: "boundary" | "handoff" }
  | {
      type: "apply";
      nodes: CuratorNode[];
      applyMode: "boundary" | "handoff";
    };
