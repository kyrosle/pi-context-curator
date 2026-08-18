import { homedir } from "node:os";
import { join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { analyzePartition, type AnalyzerProgress } from "./src/analyzer";
import { AutoCuratorGate } from "./src/auto";
import { compileCheckpoint, leafNodes } from "./src/compiler";
import {
  applyConfigOverrides,
  findSessionOverrides,
  loadConfig,
  SESSION_SETTINGS_ENTRY,
  settingsDraft,
} from "./src/config";
import { CuratorLoadingOverlay } from "./src/loading";
import { CuratorOverlay } from "./src/overlay";
import { CuratorSettingsOverlay } from "./src/settings";
import { localize } from "./src/i18n";
import { prepareSource, refineSourceUnit } from "./src/source";
import { validateCoverage } from "./src/validation";
import type {
  CuratorNode,
  CuratorLanguage,
  CuratorTrigger,
  CuratorPlanDetails,
  CuratorSettingsDraft,
  CuratorSettingsEntry,
  CompiledCheckpoint,
  PendingApplication,
  OverlayResult,
  SettingsOverlayResult,
  SourceUnit,
} from "./src/types";

const STATUS_KEY = "context-curator";
const AUTO_CURATE_PREFIX = "__context_curator_auto__:";

function isInternalAutoCommand(text: string): boolean {
  return text.trim().startsWith(`/curate ${AUTO_CURATE_PREFIX}`);
}

function notifyCuratorExit(
  ctx: ExtensionContext,
  language: CuratorLanguage,
  trigger: CuratorTrigger,
  superseded: boolean,
): void {
  ctx.ui.setStatus(STATUS_KEY, undefined);
  if (trigger === "auto") {
    ctx.ui.notify(
      superseded
        ? localize(
            language,
            "检测到新消息或 session 变化，已关闭旧的自动 Curator；新输入优先。",
            "New input or a session change superseded the automatic Curator; the new input takes priority.",
          )
        : localize(
            language,
            "已跳过本次自动策展并返回聊天；当前压力区间不会再次弹出，Pi 原生压缩仍会兜底。",
            "Skipped this auto-curation and returned to chat. It will not reopen in this pressure band, and Pi native compaction remains available as fallback.",
          ),
      "info",
    );
    return;
  }
  ctx.ui.notify(
    localize(language, "Context Curator 已取消。", "Context Curator cancelled."),
    "info",
  );
}

function effectiveConfig(ctx: ExtensionContext): {
  config: ReturnType<typeof loadConfig>;
  hasSessionOverride: boolean;
} {
  const base = loadConfig(agentDir(), ctx.cwd, ctx.isProjectTrusted());
  const overrides = findSessionOverrides(ctx.sessionManager.getBranch());
  return {
    config: applyConfigOverrides(base, overrides),
    hasSessionOverride: Object.keys(overrides).length > 0,
  };
}

function analyzerProgressLabel(
  model: string,
  progress: AnalyzerProgress,
  language: CuratorLanguage,
): string {
  if (progress.phase === "direct") {
    return localize(
      language,
      `${model} · 整体分块 ${progress.completed}/${progress.total}`,
      `${model} · Full partition ${progress.completed}/${progress.total}`,
    );
  }
  if (progress.phase === "merge") {
    return localize(
      language,
      `${model} · 合并分组 ${progress.completed}/${progress.total}`,
      `${model} · Merge groups ${progress.completed}/${progress.total}`,
    );
  }
  return localize(
    language,
    `${model} · 分组分析 ${progress.completed}/${progress.total} · 并发 ${progress.concurrency}`,
    `${model} · Group analysis ${progress.completed}/${progress.total} · concurrency ${progress.concurrency}`,
  );
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
}

function inferFocus(ctx: ExtensionCommandContext, language: CuratorLanguage): string {
  const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: unknown };
    if (message.role !== "user") continue;
    const text = textFromContent(message.content).replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 500);
  }
  return localize(
    language,
    "继续当前任务，保留后续决策、实现与验证真正需要的上下文。",
    "Continue the current task, retaining only the context needed for later decisions, implementation, and verification.",
  );
}

function resolveFocus(
  args: string,
  ctx: ExtensionCommandContext,
  language: CuratorLanguage,
): string {
  const explicit = args.trim();
  if (explicit) return explicit;
  return inferFocus(ctx, language);
}

function effectiveModelKey(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

async function confirmCrossProvider(
  ctx: ExtensionCommandContext,
  analyzerModel: string,
  enabled: boolean,
  consentedAnalyzers: Set<string>,
  language: CuratorLanguage,
): Promise<boolean> {
  const current = effectiveModelKey(ctx);
  if (!current || current.startsWith(`${analyzerModel.split("/")[0]}/`)) return true;
  if (!enabled || consentedAnalyzers.has(analyzerModel)) return true;
  if (!ctx.hasUI) return false;
  const accepted = await ctx.ui.confirm(
    localize(language, "发送到额外模型", "Send to an additional model"),
    localize(
      language,
      `当前模型是 ${current}。Context Curator 将把可压缩前缀发送给 ${analyzerModel}；本次 Pi 进程只询问一次。继续？`,
      `The current model is ${current}. Context Curator will send the compactable prefix to ${analyzerModel}; this Pi process asks only once. Continue?`,
    ),
  );
  if (accepted) consentedAnalyzers.add(analyzerModel);
  return accepted;
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1_000)}K`;
}

async function editSessionSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  cancelSignal?: AbortSignal,
): Promise<boolean> {
  const resolved = effectiveConfig(ctx);
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(
      localize(
        resolved.config.language,
        "Context Curator 设置窗口需要 Pi TUI。",
        "The Context Curator settings window requires Pi TUI.",
      ),
      "warning",
    );
    return false;
  }

  let draft = settingsDraft(resolved.config);
  while (true) {
    if (cancelSignal?.aborted) return false;
    const slash = draft.analyzerModel.indexOf("/");
    const draftModel = slash > 0
      ? ctx.modelRegistry.find(
          draft.analyzerModel.slice(0, slash),
          draft.analyzerModel.slice(slash + 1),
        )
      : undefined;
    const thinkingLevels = draftModel ? getSupportedThinkingLevels(draftModel) : ["off" as const];
    if (!thinkingLevels.includes(draft.thinkingLevel)) {
      draft.thinkingLevel = draftModel
        ? clampThinkingLevel(draftModel, draft.thinkingLevel)
        : "off";
    }
    let detachAbort: (() => void) | undefined;
    let result: SettingsOverlayResult | undefined;
    try {
      result = await ctx.ui.custom<SettingsOverlayResult>((tui, theme, _keybindings, done) => {
        let settled = false;
        const finish = (value: SettingsOverlayResult) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        const abort = () => finish({ type: "cancel" });
        if (cancelSignal) {
          if (cancelSignal.aborted) abort();
          else {
            cancelSignal.addEventListener("abort", abort, { once: true });
            detachAbort = () => cancelSignal.removeEventListener("abort", abort);
          }
        }
        return new CuratorSettingsOverlay(
          tui,
          theme,
          draft,
          [...thinkingLevels],
          resolved.hasSessionOverride,
          finish,
        );
      }, {
        overlay: true,
        overlayOptions: { width: "78%", maxHeight: "90%", anchor: "center" },
      });
    } finally {
      detachAbort?.();
    }

    if (cancelSignal?.aborted || !result || result.type === "cancel") return false;
    if (result.type === "choose-model") {
      draft = result.draft;
      const choices = ctx.modelRegistry
        .getAvailable()
        .map((model) => {
          const key = `${model.provider}/${model.id}`;
          const label = `${key}${key === draft.analyzerModel ? "  ✓" : ""} · ${formatContextWindow(model.contextWindow)}${model.reasoning ? " · reasoning" : ""}`;
          return { key, label };
        })
        .sort((a, b) => a.key.localeCompare(b.key));
      if (choices.length === 0) {
        ctx.ui.notify(
          localize(
            draft.language,
            "Pi 当前没有已认证且可用的分析模型。",
            "Pi currently has no authenticated, available analyzer model.",
          ),
          "error",
        );
        continue;
      }
      const selected = await ctx.ui.select(
        localize(draft.language, "选择 Context Curator 分析模型", "Select Context Curator analyzer model"),
        choices.map((choice) => choice.label),
      );
      if (cancelSignal?.aborted) return false;
      const choice = choices.find((item) => item.label === selected);
      if (choice) {
        draft.analyzerModel = choice.key;
        const selectedSlash = choice.key.indexOf("/");
        const selectedModel = ctx.modelRegistry.find(
          choice.key.slice(0, selectedSlash),
          choice.key.slice(selectedSlash + 1),
        );
        if (selectedModel) {
          draft.thinkingLevel = clampThinkingLevel(selectedModel, draft.thinkingLevel);
        }
      }
      continue;
    }
    if (result.type === "reset") {
      pi.appendEntry<CuratorSettingsEntry>(SESSION_SETTINGS_ENTRY, {
        version: 1,
        overrides: {},
      });
      ctx.ui.notify(
        localize(
          draft.language,
          "已清除当前 session 的 Context Curator 覆盖设置。",
          "Cleared Context Curator overrides for the current session.",
        ),
        "info",
      );
      return true;
    }

    draft = result.draft;
    const savedSlash = draft.analyzerModel.indexOf("/");
    const provider = savedSlash > 0 ? draft.analyzerModel.slice(0, savedSlash) : "";
    const modelId = savedSlash > 0 ? draft.analyzerModel.slice(savedSlash + 1) : "";
    const model = provider && modelId ? ctx.modelRegistry.find(provider, modelId) : undefined;
    const available = ctx.modelRegistry
      .getAvailable()
      .some((candidate) => candidate.provider === provider && candidate.id === modelId);
    if (!model || !available) {
      ctx.ui.notify(
        localize(
          draft.language,
          `分析模型当前不可用：${draft.analyzerModel}。请重新选择模型。`,
          `Analyzer model is currently unavailable: ${draft.analyzerModel}. Select another model.`,
        ),
        "error",
      );
      continue;
    }
    draft.thinkingLevel = clampThinkingLevel(model, draft.thinkingLevel);

    pi.appendEntry<CuratorSettingsEntry>(SESSION_SETTINGS_ENTRY, {
      version: 1,
      overrides: { ...draft },
    });
    ctx.ui.notify(
      localize(
        draft.language,
        `Context Curator session 设置已保存：${draft.analyzerModel} (${draft.thinkingLevel})。`,
        `Context Curator session settings saved: ${draft.analyzerModel} (${draft.thinkingLevel}).`,
      ),
      "info",
    );
    return true;
  }
}

function buildDetails(
  snapshot: ReturnType<typeof prepareSource>["snapshot"],
  nodes: CuratorNode[],
  units: SourceUnit[],
  analyzerModel: string,
  checkpoint: CompiledCheckpoint,
  language: CuratorLanguage,
): CuratorPlanDetails {
  const coverage = validateCoverage(leafNodes(nodes), units.map((unit) => unit.id));
  return {
    kind: "pi-context-curator",
    version: 1,
    snapshot,
    analyzerModel,
    language,
    nodes,
    coverage,
    checkpointTokens: checkpoint.estimatedTokens,
    activeBlocks: checkpoint.activeBlocks,
    archivedBlocks: checkpoint.archivedBlocks,
  };
}

function latestCuratorDetails(ctx: ExtensionCommandContext): CuratorPlanDetails | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { details?: unknown };
    const details = entry.details as Partial<CuratorPlanDetails> | undefined;
    if (details?.kind === "pi-context-curator" && details.version === 1) {
      return details as CuratorPlanDetails;
    }
  }
  return undefined;
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const resolved = effectiveConfig(ctx);
  const config = resolved.config;
  const usage = ctx.getContextUsage();
  const lines = config.language === "zh"
    ? [
        "Context Curator",
        `启用：${config.enabled}`,
        `显示语言：${config.language}`,
        `分析模型：${config.analyzerModel} (${config.thinkingLevel})`,
        `Curate 触发：${config.triggerMode}`,
        `跨 Provider 确认：${config.confirmCrossProvider ? "每个分析模型/进程一次" : "关闭（配置视为已授权）"}`,
        `分析并发：${config.maxConcurrentAnalyzerCalls}（仅分层分组）`,
        `Session override：${resolved.hasSessionOverride ? "已启用" : "无"}`,
        `Raw tail：${config.rawTailTokens} tokens`,
        `Checkpoint 目标：${config.targetCheckpointTokens} tokens`,
        `分块宽度：2–${config.maxBlocksPerSplit}`,
        `用量：${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} (${usage?.percent?.toFixed(1) ?? "?"}%)`,
        "常规压缩：手动、交互式",
        "紧急压缩：Pi 原生兜底",
      ]
    : [
        "Context Curator",
        `enabled: ${config.enabled}`,
        `display language: ${config.language}`,
        `analyzer: ${config.analyzerModel} (${config.thinkingLevel})`,
        `curate trigger: ${config.triggerMode}`,
        `cross-provider confirmation: ${config.confirmCrossProvider ? "once per analyzer/process" : "disabled (configured consent)"}`,
        `analyzer concurrency: ${config.maxConcurrentAnalyzerCalls} (hierarchical groups only)`,
        `session override: ${resolved.hasSessionOverride ? "active" : "none"}`,
        `raw tail: ${config.rawTailTokens} tokens`,
        `checkpoint target: ${config.targetCheckpointTokens} tokens`,
        `split width: 2–${config.maxBlocksPerSplit}`,
        `usage: ${usage?.tokens ?? "?"}/${usage?.contextWindow ?? "?"} (${usage?.percent?.toFixed(1) ?? "?"}%)`,
        "normal compaction: manual and interactive",
        "emergency compaction: Pi built-in fallback",
      ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function undoLatest(ctx: ExtensionCommandContext): Promise<void> {
  const language = effectiveConfig(ctx).config.language;
  const branch = ctx.sessionManager.getBranch();
  const compactionIndex = branch.findLastIndex((entry) => {
    if (entry.type !== "compaction") return false;
    const details = (entry as { details?: unknown }).details as Partial<CuratorPlanDetails> | undefined;
    return details?.kind === "pi-context-curator";
  });
  if (compactionIndex < 0) {
    ctx.ui.notify(
      localize(language, "当前分支没有 Context Curator checkpoint。", "The current branch has no Context Curator checkpoint."),
      "warning",
    );
    return;
  }
  const compaction = branch[compactionIndex];
  if (!compaction.parentId) {
    ctx.ui.notify(
      localize(language, "该 checkpoint 没有可恢复的父节点。", "This checkpoint has no parent node to restore."),
      "error",
    );
    return;
  }
  const newerEntries = branch.length - compactionIndex - 1;
  const confirmed = await ctx.ui.confirm(
    localize(language, "恢复到策展前", "Restore to before curation"),
    newerEntries > 0
      ? localize(
          language,
          `Checkpoint 后还有 ${newerEntries} 条 entry。恢复会切换当前分支指针，但不会删除任何历史。继续？`,
          `There are ${newerEntries} entries after the checkpoint. Restoring moves the current branch pointer but deletes no history. Continue?`,
        )
      : localize(
          language,
          "恢复到策展前的 session 节点？原历史不会被删除。",
          "Restore to the session node before curation? No history will be deleted.",
        ),
  );
  if (!confirmed) return;
  await ctx.navigateTree(compaction.parentId);
}

async function restoreArchived(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const language = effectiveConfig(ctx).config.language;
  const details = latestCuratorDetails(ctx);
  if (!details || details.archivedBlocks.length === 0) {
    ctx.ui.notify(
      localize(language, "当前分支没有可恢复的归档块。", "The current branch has no archived block to restore."),
      "warning",
    );
    return;
  }
  const labels = details.archivedBlocks.map((block) => block.title);
  const selected = await ctx.ui.select(
    localize(language, "恢复哪个归档块？", "Which archived block should be restored?"),
    labels,
  );
  if (!selected) return;
  const block = details.archivedBlocks.find((candidate) => candidate.title === selected);
  if (!block) return;
  pi.sendMessage(
    {
      customType: "context-curator-restore",
      content: localize(
        language,
        `## 已恢复的归档上下文：${block.title}\n\n${block.summary}\n\n来源单元：${block.sourceUnitIds.join(", ")}`,
        `## Restored Archived Context: ${block.title}\n\n${block.summary}\n\nSource units: ${block.sourceUnitIds.join(", ")}`,
      ),
      display: true,
      details: { kind: "pi-context-curator-restore", block },
    },
    { triggerTurn: false },
  );
  ctx.ui.notify(
    localize(
      language,
      `已将“${block.title}”的归档摘要恢复到 active context。`,
      `Restored the archived summary “${block.title}” to active context.`,
    ),
    "info",
  );
}

async function applyBoundary(
  ctx: ExtensionCommandContext,
  pendingBySession: Map<string, PendingApplication>,
  pending: PendingApplication,
): Promise<void> {
  pendingBySession.set(pending.snapshot.sessionId, pending);
  await new Promise<void>((resolve, reject) => {
    ctx.compact({
      customInstructions: `context-curator:${pending.planId}`,
      onComplete: () => resolve(),
      onError: reject,
    });
  });
  pendingBySession.delete(pending.snapshot.sessionId);
}

export async function applyNativeFallback(
  ctx: ExtensionCommandContext,
  language: CuratorLanguage,
): Promise<void> {
  ctx.ui.setStatus(
    STATUS_KEY,
    localize(language, "curator · Pi 原生压缩中", "curator · Pi native compaction"),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      ctx.compact({
        onComplete: () => resolve(),
        onError: reject,
      });
    });
    ctx.ui.notify(
      localize(
        language,
        "已使用 Pi 原生 compaction 处理本次上下文。",
        "Pi native compaction handled this context cycle.",
      ),
      "info",
    );
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

async function applyHandoff(
  ctx: ExtensionCommandContext,
  pending: PendingApplication,
  successMessage: string,
  language: CuratorLanguage,
): Promise<void> {
  const parentSession = ctx.sessionManager.getSessionFile();
  const name = localize(
    language,
    `已策展：${pending.snapshot.focus.slice(0, 60)}`,
    `Curated: ${pending.snapshot.focus.slice(0, 60)}`,
  );
  const result = await ctx.newSession({
    ...(parentSession ? { parentSession } : {}),
    setup: async (sessionManager) => {
      sessionManager.appendSessionInfo(name);
      sessionManager.appendCustomMessageEntry(
        "context-curator-handoff",
        pending.checkpoint.text,
        true,
        pending.details,
      );
    },
    withSession: async (newCtx) => {
      newCtx.ui.notify(successMessage, "info");
    },
  });
  if (result.cancelled) {
    ctx.ui.notify(
      localize(
        language,
        "Handoff 被其他扩展取消；当前 session 未切换。",
        "Handoff was cancelled by another extension; the current session was not switched.",
      ),
      "warning",
    );
  }
}

type LoadingOutcome =
  | { type: "complete"; nodes: CuratorNode[] }
  | { type: "cancel" }
  | { type: "error"; error: Error };

async function analyzeWithLoading(
  ctx: ExtensionCommandContext,
  units: SourceUnit[],
  focus: string,
  config: ReturnType<typeof loadConfig>,
  trigger: CuratorTrigger,
  cancelSignal?: AbortSignal,
): Promise<CuratorNode[] | undefined> {
  ctx.ui.setStatus(
    STATUS_KEY,
    localize(config.language, "curator · 分析中", "curator · analyzing"),
  );
  let outcome: LoadingOutcome | undefined;
  let detachExternalAbort: (() => void) | undefined;
  try {
    outcome = await ctx.ui.custom<LoadingOutcome>((tui, theme, _keybindings, done) => {
      const detail = localize(
        config.language,
        `目标：${focus.replace(/\s+/g, " ").slice(0, 120)} · ${units.length} 个来源单元`,
        `Focus: ${focus.replace(/\s+/g, " ").slice(0, 120)} · ${units.length} source units`,
      );
      const loader = new CuratorLoadingOverlay(
        tui,
        theme,
        localize(
          config.language,
          `${config.analyzerModel} · 准备上下文分块`,
          `${config.analyzerModel} · Preparing context partition`,
        ),
        detail,
        config.language,
        trigger === "auto",
      );
      let settled = false;
      const finish = (result: LoadingOutcome) => {
        if (settled) return;
        settled = true;
        if (result.type === "complete") loader.complete();
        done(result);
      };
      loader.onAbort = () => finish({ type: "cancel" });
      const externalAbort = () => {
        loader.cancel(
          localize(
            config.language,
            "检测到新消息，正在返回聊天…",
            "New input detected; returning to chat…",
          ),
        );
      };
      if (cancelSignal) {
        if (cancelSignal.aborted) externalAbort();
        else {
          cancelSignal.addEventListener("abort", externalAbort, { once: true });
          detachExternalAbort = () => cancelSignal.removeEventListener("abort", externalAbort);
        }
      }
      void analyzePartition(
        ctx,
        units,
        focus,
        config,
        loader.signal,
        undefined,
        (progress) => {
          if (settled) return;
          const label = analyzerProgressLabel(config.analyzerModel, progress, config.language);
          loader.setProgress(label, detail);
          ctx.ui.setStatus(STATUS_KEY, `curator · ${progress.completed}/${progress.total}`);
        },
      )
        .then((nodes) => finish({ type: "complete", nodes }))
        .catch((error) => {
          if (loader.signal.aborted) finish({ type: "cancel" });
          else finish({ type: "error", error: error instanceof Error ? error : new Error(String(error)) });
        });
      return loader;
    }, {
      overlay: true,
      overlayOptions: { width: "76%", anchor: "center" },
    });
  } finally {
    detachExternalAbort?.();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }

  if (!outcome || outcome.type === "cancel") return undefined;
  if (outcome.type === "error") throw outcome.error;
  return outcome.nodes;
}

async function runCuratorSession(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  pendingBySession: Map<string, PendingApplication>,
  consentedAnalyzers: Set<string>,
  trigger: CuratorTrigger,
  cancelSignal?: AbortSignal,
): Promise<void> {
  const config = effectiveConfig(ctx).config;
  if (!config.enabled) {
    ctx.ui.notify(
      localize(config.language, "Context Curator 已在配置中禁用。", "Context Curator is disabled in configuration."),
      "warning",
    );
    return;
  }
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(
      localize(
        config.language,
        "交互式策展需要 Pi TUI。无 UI 模式会继续使用 Pi 原生紧急压缩。",
        "Interactive curation requires Pi TUI. Non-UI mode continues to use Pi's native emergency compaction.",
      ),
      "warning",
    );
    return;
  }

  await ctx.waitForIdle();
  if (
    cancelSignal?.aborted ||
    (trigger === "auto" && (!ctx.isIdle() || ctx.hasPendingMessages()))
  ) {
    notifyCuratorExit(ctx, config.language, trigger, true);
    return;
  }
  const focus = resolveFocus(args, ctx, config.language);
  if (!focus?.trim()) return;
  if (
    !(await confirmCrossProvider(
      ctx,
      config.analyzerModel,
      config.confirmCrossProvider,
      consentedAnalyzers,
      config.language,
    ))
  ) return;

  if (cancelSignal?.aborted) {
    notifyCuratorExit(ctx, config.language, trigger, true);
    return;
  }

  const prepared = prepareSource(
    ctx,
    focus.trim(),
    config.rawTailTokens,
    config.language,
    config.maxBlocksPerSplit,
  );
  const nodes = await analyzeWithLoading(
    ctx,
    prepared.units,
    focus.trim(),
    config,
    trigger,
    cancelSignal,
  );
  if (!nodes) {
    notifyCuratorExit(ctx, config.language, trigger, cancelSignal?.aborted ?? false);
    return;
  }
  if (
    cancelSignal?.aborted ||
    (trigger === "auto" &&
      (ctx.hasPendingMessages() || ctx.sessionManager.getLeafId() !== prepared.snapshot.leafId))
  ) {
    notifyCuratorExit(ctx, config.language, trigger, true);
    return;
  }

  let applyMode = config.defaultApplyMode;
  let result: OverlayResult | undefined;
  while (true) {
    let detachOverlayAbort: (() => void) | undefined;
    try {
      result = await ctx.ui.custom<OverlayResult>((tui, theme, _keybindings, done) => {
        let settled = false;
        const finish = (value: OverlayResult) => {
          if (settled) return;
          settled = true;
          done(value);
        };
        const externalAbort = () => finish({ type: "cancel" });
        if (cancelSignal) {
          if (cancelSignal.aborted) externalAbort();
          else {
            cancelSignal.addEventListener("abort", externalAbort, { once: true });
            detachOverlayAbort = () => cancelSignal.removeEventListener("abort", externalAbort);
          }
        }
        return new CuratorOverlay(
          tui,
          theme,
          prepared.snapshot,
          nodes,
          prepared.unitById,
          config,
          applyMode,
          trigger === "auto",
          (ctx.getContextUsage()?.percent ?? 0) >= config.emergencyPercent,
          async (node, signal, report) => {
            let units = node.sourceUnitIds
              .map((id) => prepared.unitById.get(id))
              .filter((unit): unit is SourceUnit => unit !== undefined);
            let refinement: { sourceId: string; units: SourceUnit[] } | undefined;
            if (units.length === 1) {
              report(
                localize(
                  config.language,
                  "正在细分单个长来源单元",
                  "Refining one long source unit",
                ),
              );
              const refined = refineSourceUnit(units[0], config.maxBlocksPerSplit);
              if (refined.length < 2) {
                throw new Error(
                  localize(
                    config.language,
                    "当前来源单元太短，无法继续有意义地拆分。",
                    "The current source unit is too short for another meaningful split.",
                  ),
                );
              }
              refinement = { sourceId: units[0].id, units: refined };
              units = refined;
            }
            const children = await analyzePartition(
              ctx,
              units,
              focus.trim(),
              config,
              signal,
              node.title,
              (progress) => report(analyzerProgressLabel(config.analyzerModel, progress, config.language)),
            );
            const qualifiedTitles = new Map(
              children.map((child) => [child.title, `${node.title} › ${child.title}`]),
            );
            const qualifiedChildren = children.map((child) => ({
              ...child,
              title: qualifiedTitles.get(child.title) ?? child.title,
              dependencies: child.dependencies.map(
                (dependency) => qualifiedTitles.get(dependency) ?? dependency,
              ),
            }));
            if (refinement) {
              const sourceIndex = prepared.units.findIndex((unit) => unit.id === refinement.sourceId);
              if (sourceIndex < 0) {
                throw new Error(
                  localize(
                    config.language,
                    "来源单元已变化，请重新运行 /curate。",
                    "Source units changed; run /curate again.",
                  ),
                );
              }
              prepared.units.splice(sourceIndex, 1, ...refinement.units);
              for (const unit of refinement.units) prepared.unitById.set(unit.id, unit);
            }
            return qualifiedChildren;
          },
          finish,
        );
      }, {
        overlay: true,
        overlayOptions: { width: "92%", maxHeight: "94%", anchor: "center" },
      });
    } finally {
      detachOverlayAbort?.();
    }

    if (result?.type !== "settings") break;
    applyMode = result.applyMode;
    const changed = await editSessionSettings(pi, ctx, cancelSignal);
    if (cancelSignal?.aborted) {
      notifyCuratorExit(ctx, config.language, trigger, true);
      return;
    }
    if (changed) {
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        ctx.ui.notify(
          localize(
            config.language,
            "保存 session 设置后无法确认新的 session leaf，当前方案已取消。",
            "Could not confirm the new session leaf after saving settings; the current plan was cancelled.",
          ),
          "error",
        );
        return;
      }
      prepared.snapshot.leafId = leafId;
      ctx.ui.notify(
        localize(
          config.language,
          "设置从下一次 /curate 生效；当前已生成的方案继续使用原设置。",
          "Settings take effect on the next /curate; the current generated plan keeps its original settings.",
        ),
        "info",
      );
    }
  }

  if (!result || result.type === "cancel") {
    notifyCuratorExit(ctx, config.language, trigger, cancelSignal?.aborted ?? false);
    return;
  }
  if (cancelSignal?.aborted) {
    notifyCuratorExit(ctx, config.language, trigger, true);
    return;
  }
  if (result.type === "fallback") {
    await applyNativeFallback(ctx, config.language);
    return;
  }
  if (result.type !== "apply") return;
  if (ctx.sessionManager.getLeafId() !== prepared.snapshot.leafId) {
    ctx.ui.notify(
      localize(
        config.language,
        "Session 在分析期间发生了变化，旧方案已拒绝应用。请重新运行 /curate。",
        "The session changed during analysis, so the stale plan was rejected. Run /curate again.",
      ),
      "error",
    );
    return;
  }

  const coverage = validateCoverage(leafNodes(result.nodes), prepared.units.map((unit) => unit.id));
  if (!coverage.ok) {
    ctx.ui.notify(
      localize(
        config.language,
        "最终来源覆盖率不是 100%，已拒绝应用。",
        "Final source coverage is not 100%; apply was rejected.",
      ),
      "error",
    );
    return;
  }
  const checkpoint = compileCheckpoint(
    prepared.snapshot,
    result.nodes,
    prepared.unitById,
    config.archiveIndex,
    config.language,
  );
  const details = buildDetails(
    prepared.snapshot,
    result.nodes,
    prepared.units,
    config.analyzerModel,
    checkpoint,
    config.language,
  );
  const pending: PendingApplication = {
    planId: `${Date.now().toString(36)}-${prepared.snapshot.sourceHash.slice(0, 8)}`,
    snapshot: prepared.snapshot,
    details,
    checkpoint,
    firstKeptEntryId: prepared.firstKeptEntryId,
  };
  const projectedTokens = checkpoint.estimatedTokens + prepared.snapshot.rawTailTokens;
  const successMessage = localize(
    config.language,
    `Context Curator 已应用：${prepared.snapshot.activeTokens.toLocaleString()} → 预计 ${projectedTokens.toLocaleString()} tokens（${result.applyMode}）。`,
    `Context Curator applied: ${prepared.snapshot.activeTokens.toLocaleString()} → approximately ${projectedTokens.toLocaleString()} tokens (${result.applyMode}).`,
  );

  try {
    if (result.applyMode === "handoff") {
      await applyHandoff(ctx, pending, successMessage, config.language);
    } else {
      await applyBoundary(ctx, pendingBySession, pending);
      ctx.ui.notify(successMessage, "info");
    }
  } finally {
    pendingBySession.delete(prepared.snapshot.sessionId);
  }
}

async function runCurator(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  pendingBySession: Map<string, PendingApplication>,
  consentedAnalyzers: Set<string>,
  activeAutoCurators: Map<string, AbortController>,
  trigger: CuratorTrigger,
): Promise<void> {
  if (trigger === "manual") {
    await runCuratorSession(
      pi,
      args,
      ctx,
      pendingBySession,
      consentedAnalyzers,
      trigger,
    );
    return;
  }

  const sessionId = ctx.sessionManager.getSessionId();
  if (activeAutoCurators.has(sessionId) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
  const controller = new AbortController();
  activeAutoCurators.set(sessionId, controller);
  try {
    await runCuratorSession(
      pi,
      args,
      ctx,
      pendingBySession,
      consentedAnalyzers,
      trigger,
      controller.signal,
    );
  } finally {
    if (activeAutoCurators.get(sessionId) === controller) activeAutoCurators.delete(sessionId);
  }
}

export default function contextCurator(pi: ExtensionAPI): void {
  const pendingBySession = new Map<string, PendingApplication>();
  const reminderLevel = new Map<string, number>();
  const autoGate = new AutoCuratorGate();
  const activeAutoCurators = new Map<string, AbortController>();
  const consentedAnalyzers = new Set<string>();

  pi.registerCommand("curate", {
    description: "Interactively curate context: /curate [focus] | settings | status | undo | restore",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed.startsWith(AUTO_CURATE_PREFIX)) {
        const targetSessionId = trimmed.slice(AUTO_CURATE_PREFIX.length);
        if (targetSessionId !== ctx.sessionManager.getSessionId()) return;
        return runCurator(
          pi,
          "",
          ctx,
          pendingBySession,
          consentedAnalyzers,
          activeAutoCurators,
          "auto",
        );
      }
      const command = trimmed.toLowerCase();
      if (command === "settings") {
        await editSessionSettings(pi, ctx);
        return;
      }
      if (command === "status") return showStatus(ctx);
      if (command === "undo") return undoLatest(ctx);
      if (command === "restore") return restoreArchived(pi, ctx);
      return runCurator(
        pi,
        args,
        ctx,
        pendingBySession,
        consentedAnalyzers,
        activeAutoCurators,
        "manual",
      );
    },
  });

  pi.on("input", (event, ctx) => {
    if (isInternalAutoCommand(event.text)) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    const controller = activeAutoCurators.get(sessionId);
    if (!controller || controller.signal.aborted) return undefined;
    controller.abort("new-input");
    ctx.ui.setStatus(
      STATUS_KEY,
      localize(
        effectiveConfig(ctx).config.language,
        "curator · 新输入优先",
        "curator · new input takes priority",
      ),
    );
    return { action: "continue" };
  });

  pi.on("session_before_compact", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const pending = pendingBySession.get(sessionId);
    if (!pending) return undefined;
    if (ctx.sessionManager.getLeafId() !== pending.snapshot.leafId) {
      pendingBySession.delete(sessionId);
      return { cancel: true };
    }
    if (event.customInstructions !== `context-curator:${pending.planId}`) return { cancel: true };
    return {
      compaction: {
        summary: pending.checkpoint.text,
        firstKeptEntryId: pending.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: pending.details,
      },
    };
  });

  pi.on("session_compact", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    activeAutoCurators.get(sessionId)?.abort("session-compacted");
    activeAutoCurators.delete(sessionId);
    pendingBySession.delete(sessionId);
    reminderLevel.set(sessionId, 0);
    autoGate.reset(sessionId);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    const config = effectiveConfig(ctx).config;
    if (!config.enabled) return;
    const usage = ctx.getContextUsage();
    if (!usage?.percent) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const previous = reminderLevel.get(sessionId) ?? 0;
    const level = usage.percent >= config.emergencyPercent
      ? 3
      : usage.percent >= config.strongNotifyPercent
        ? 2
        : usage.percent >= config.notifyPercent
          ? 1
          : 0;
    if (level < previous) {
      reminderLevel.set(sessionId, level);
      if (level === 0) ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    if (level === previous) return;
    reminderLevel.set(sessionId, level);
    if (level === 1) {
      ctx.ui.setStatus(STATUS_KEY, `curator · ${usage.percent.toFixed(0)}% · /curate`);
      return;
    }
    if (level === 2) {
      if (config.triggerMode === "auto") {
        ctx.ui.setStatus(
          STATUS_KEY,
          localize(
            config.language,
            `curator · ${usage.percent.toFixed(0)}% · 正在准备窗口`,
            `curator · ${usage.percent.toFixed(0)}% · preparing popup`,
          ),
        );
        return;
      }
      ctx.ui.notify(
        localize(
          config.language,
          `上下文已使用 ${usage.percent.toFixed(1)}%。建议在下一阶段前运行 /curate。`,
          `Context usage is ${usage.percent.toFixed(1)}%. Consider running /curate before the next phase.`,
        ),
        "warning",
      );
      return;
    }
    if (config.triggerMode === "auto") {
      ctx.ui.setStatus(
        STATUS_KEY,
        localize(
          config.language,
          `curator · ${usage.percent.toFixed(0)}% · 紧急窗口`,
          `curator · ${usage.percent.toFixed(0)}% · emergency popup`,
        ),
      );
      return;
    }
    ctx.ui.notify(
      localize(
        config.language,
        `上下文已使用 ${usage.percent.toFixed(1)}%，接近紧急区。请立即运行 /curate；若继续增长，Pi 原生 compaction 仍会兜底。`,
        `Context usage is ${usage.percent.toFixed(1)}%, near the emergency zone. Run /curate now; Pi native compaction still provides fallback if usage keeps growing.`,
      ),
      "error",
    );
  });

  pi.on("agent_settled", (_event, ctx) => {
    const config = effectiveConfig(ctx).config;
    const sessionId = ctx.sessionManager.getSessionId();
    if (!config.enabled || config.triggerMode !== "auto") {
      autoGate.reset(sessionId);
      return;
    }
    if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const usage = ctx.getContextUsage();
    if (!usage?.percent) return;
    const level = autoGate.claim(
      sessionId,
      usage.percent,
      config.strongNotifyPercent,
      config.emergencyPercent,
    );
    if (level === 0) return;
    setTimeout(() => {
      try {
        pi.sendUserMessage(`/curate ${AUTO_CURATE_PREFIX}${sessionId}`, {
          expandPromptTemplates: true,
        });
      } catch {
        // The extension runtime may have been replaced between scheduling and dispatch.
      }
    }, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    for (const controller of activeAutoCurators.values()) controller.abort("session-started");
    activeAutoCurators.clear();
    pendingBySession.clear();
    reminderLevel.clear();
    autoGate.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
