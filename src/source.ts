import { createHash } from "node:crypto";
import {
  convertToLlm,
  estimateTokens,
  findCutPoint,
  serializeConversation,
  sessionEntryToContextMessages,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { localize } from "./i18n";
import type {
  CompiledActiveBlock,
  CuratorLanguage,
  CuratorPlanDetails,
  CuratorSnapshot,
  SourceUnit,
} from "./types";

export interface PreparedSource {
  snapshot: CuratorSnapshot;
  units: SourceUnit[];
  unitById: Map<string, SourceUnit>;
  firstKeptEntryId: string;
  prefixEntries: SessionEntry[];
  rawTailEntries: SessionEntry[];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

interface VirtualCheckpoint {
  focus: string;
  sourceHash: string;
  blocks: CompiledActiveBlock[];
}

function virtualCheckpoint(entry: SessionEntry): VirtualCheckpoint | undefined {
  if (entry.type !== "compaction" && entry.type !== "custom_message") return undefined;
  const details = entry.details as Partial<CuratorPlanDetails> | undefined;
  if (details?.kind !== "pi-context-curator" || details.version !== 1) return undefined;
  if (!Array.isArray(details.activeBlocks) || details.activeBlocks.length === 0) return undefined;
  const blocks = details.activeBlocks.filter(
    (block): block is CompiledActiveBlock =>
      Boolean(
        block &&
        typeof block.id === "string" &&
        typeof block.title === "string" &&
        (block.mode === "summary" || block.mode === "exact") &&
        typeof block.text === "string" &&
        Array.isArray(block.sourceUnitIds) &&
        block.sourceUnitIds.every((id) => typeof id === "string") &&
        typeof block.estimatedTokens === "number" &&
        Number.isFinite(block.estimatedTokens) &&
        block.estimatedTokens >= 0,
      ),
  );
  if (blocks.length === 0) return undefined;
  return {
    focus: typeof details.snapshot?.focus === "string" ? details.snapshot.focus : "",
    sourceHash: typeof details.snapshot?.sourceHash === "string" ? details.snapshot.sourceHash : "unknown",
    blocks,
  };
}

function entryText(entry: SessionEntry): { text: string; tokens: number; startsTurn: boolean } | null {
  const messages = sessionEntryToContextMessages(entry);
  if (messages.length === 0) return null;

  const text = serializeConversation(convertToLlm(messages));
  const tokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  const startsTurn = messages.some((message) => {
    const role = (message as { role?: string }).role;
    return role === "user" || role === "custom" || role === "compactionSummary";
  });

  return { text, tokens, startsTurn };
}

export function buildSourceUnits(entries: SessionEntry[]): SourceUnit[] {
  const units: SourceUnit[] = [];
  let current: { entryIds: string[]; parts: string[]; tokens: number } | undefined;

  const pushUnit = (entryIds: string[], text: string, tokens: number) => {
    units.push({
      id: `u${String(units.length + 1).padStart(4, "0")}`,
      entryIds,
      text,
      tokens,
      hash: sha256(text),
    });
  };

  const flush = () => {
    if (!current || current.parts.length === 0) return;
    const text = current.parts.join("\n\n");
    pushUnit(current.entryIds, text, current.tokens);
    current = undefined;
  };

  for (const entry of entries) {
    const checkpoint = virtualCheckpoint(entry);
    if (checkpoint) {
      flush();
      const metadata = [
        "<prior-curator-checkpoint>",
        checkpoint.focus ? `Previous focus: ${checkpoint.focus}` : "Previous focus: unavailable",
        `Source snapshot: ${checkpoint.sourceHash.slice(0, 16)}`,
        "</prior-curator-checkpoint>",
      ].join("\n");
      pushUnit([entry.id], metadata, Math.ceil(metadata.length / 4));
      for (const block of checkpoint.blocks) {
        const text = `<prior-curator-block id="${block.id}" mode="${block.mode}" title="${block.title}">\n${block.text}\n</prior-curator-block>`;
        pushUnit([entry.id], text, block.estimatedTokens || Math.ceil(text.length / 4));
      }
      continue;
    }
    const visible = entryText(entry);
    if (!visible) continue;
    if (visible.startsTurn && current) flush();
    current ??= { entryIds: [], parts: [], tokens: 0 };
    current.entryIds.push(entry.id);
    current.parts.push(`<entry id="${entry.id}">\n${visible.text}\n</entry>`);
    current.tokens += visible.tokens;
  }
  flush();

  return units;
}

function nearbyBoundary(text: string, target: number, min: number, max: number): number {
  const radius = Math.max(80, Math.floor((max - min) / 3));
  const low = Math.max(min, target - radius);
  const high = Math.min(max, target + radius);
  for (const marker of ["\n\n", "\n", "。", ". "]) {
    const before = text.lastIndexOf(marker, target);
    const after = text.indexOf(marker, target);
    const candidates = [before >= low ? before + marker.length : -1, after >= 0 && after <= high ? after + marker.length : -1]
      .filter((value) => value > min && value < max)
      .sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
    if (candidates[0] !== undefined) return candidates[0];
  }
  return Math.max(min + 1, Math.min(max - 1, target));
}

/** Losslessly split one oversized semantic unit so recursive curation can continue. */
export function refineSourceUnit(unit: SourceUnit, maxParts: 2 | 3): SourceUnit[] {
  const text = unit.text;
  if (text.trim().length < 160) return [unit];
  const partCount = maxParts === 3 && text.length >= 1_200 ? 3 : 2;
  const cuts = [0];
  for (let index = 1; index < partCount; index++) {
    const remainingParts = partCount - index;
    const min = cuts[cuts.length - 1] + 1;
    const max = text.length - remainingParts;
    cuts.push(nearbyBoundary(text, Math.floor((text.length * index) / partCount), min, max));
  }
  cuts.push(text.length);

  const parts = cuts.slice(0, -1).map((start, index) => text.slice(start, cuts[index + 1]));
  if (parts.length < 2 || parts.some((part) => part.length === 0)) return [unit];
  return parts.map((part, index) => ({
    id: `${unit.id}.${index + 1}`,
    entryIds: [...unit.entryIds],
    text: part,
    tokens: Math.max(1, Math.round(unit.tokens * (part.length / text.length))),
    hash: sha256(part),
  }));
}

/** Ensure the first Curator decision is useful even when the prefix is one large turn. */
export function expandInitialSourceUnits(units: SourceUnit[], maxParts: 2 | 3): SourceUnit[] {
  if (units.length !== 1) return units;
  return refineSourceUnit(units[0], maxParts);
}

function estimateEntriesTokens(entries: SessionEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      total += estimateTokens(message);
    }
  }
  return total;
}

export function prepareSource(
  ctx: ExtensionCommandContext,
  focus: string,
  rawTailTokens: number,
  language: CuratorLanguage = "zh",
  maxBlocksPerSplit: 2 | 3 = 3,
): PreparedSource {
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) {
    throw new Error(localize(language, "当前 session 没有可策展的消息。", "This session has no messages to curate."));
  }

  const activeEntries = ctx.sessionManager.buildContextEntries();
  if (activeEntries.length < 2) {
    throw new Error(localize(language, "当前上下文太短，不需要压缩。", "The current context is too short to compact."));
  }

  const cut = findCutPoint(activeEntries, 0, activeEntries.length, rawTailTokens);
  const cutIndex = cut.firstKeptEntryIndex;
  if (cutIndex <= 0 || cutIndex >= activeEntries.length) {
    throw new Error(
      localize(
        language,
        "没有足够的历史前缀可压缩；请继续工作一段时间后再试。",
        "There is not enough historical prefix to compact; continue working and try again later.",
      ),
    );
  }

  const prefixEntries = activeEntries.slice(0, cutIndex);
  const rawTailEntries = activeEntries.slice(cutIndex);
  const firstKeptEntryId = activeEntries[cutIndex]?.id;
  if (!firstKeptEntryId) {
    throw new Error(localize(language, "无法确定安全的 raw-tail 边界。", "Could not determine a safe raw-tail boundary."));
  }

  const units = expandInitialSourceUnits(buildSourceUnits(prefixEntries), maxBlocksPerSplit);
  if (units.length === 0) {
    throw new Error(localize(language, "压缩前缀中没有可见消息。", "The compactable prefix contains no visible messages."));
  }
  if (units.length === 1) {
    throw new Error(
      localize(
        language,
        "可压缩前缀只有一个过短的来源单元，无法形成有意义的 2–3 块初始选择。",
        "The compactable prefix has only one short source unit and cannot form a meaningful initial 2–3-block choice.",
      ),
    );
  }

  const sourceHash = sha256(units.map((unit) => `${unit.id}:${unit.hash}`).join("\n"));
  const usage = ctx.getContextUsage();
  const snapshot: CuratorSnapshot = {
    version: 1,
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    leafId,
    createdAt: new Date().toISOString(),
    focus,
    activeTokens: usage?.tokens ?? estimateEntriesTokens(activeEntries),
    rawTailTokens: estimateEntriesTokens(rawTailEntries),
    rawTailStartEntryId: firstKeptEntryId,
    prefixEntryIds: prefixEntries.map((entry) => entry.id),
    sourceHash,
  };

  return {
    snapshot,
    units,
    unitById: new Map(units.map((unit) => [unit.id, unit])),
    firstKeptEntryId,
    prefixEntries,
    rawTailEntries,
  };
}

export function sourceTextForNode(sourceUnitIds: string[], unitById: Map<string, SourceUnit>): string {
  return sourceUnitIds
    .map((id) => {
      const unit = unitById.get(id);
      return unit ? `<source-unit id="${unit.id}" tokens="${unit.tokens}">\n${unit.text}\n</source-unit>` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export function sourceTokensForNode(sourceUnitIds: string[], unitById: Map<string, SourceUnit>): number {
  return sourceUnitIds.reduce((sum, id) => sum + (unitById.get(id)?.tokens ?? 0), 0);
}
