import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  CuratorHistoryRecord,
  CuratorNode,
  CuratorPlanDetails,
} from "./types";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCuratorNode(value: unknown): value is CuratorNode {
  if (!isObject(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    (value.displayTitle !== undefined && typeof value.displayTitle !== "string") ||
    typeof value.summary !== "string" ||
    !isStringArray(value.sourceUnitIds) ||
    !["summary", "exact", "drop"].includes(String(value.recommendedMode)) ||
    !["summary", "exact", "drop"].includes(String(value.mode)) ||
    !["low", "medium", "high"].includes(String(value.risk)) ||
    typeof value.rationale !== "string" ||
    !isStringArray(value.dependencies) ||
    !isStringArray(value.verbatimEvidence)
  ) {
    return false;
  }
  return value.children === undefined || (
    Array.isArray(value.children) && value.children.every(isCuratorNode)
  );
}

/**
 * Parse persisted Curator metadata conservatively. History must never crash Pi
 * because an old or third-party compaction entry contains malformed details.
 */
export function parseCuratorPlanDetails(value: unknown): CuratorPlanDetails | undefined {
  if (!isObject(value) || value.kind !== "pi-context-curator" || value.version !== 1) {
    return undefined;
  }
  const snapshot = value.snapshot;
  if (
    !isObject(snapshot) ||
    snapshot.version !== 1 ||
    typeof snapshot.sessionId !== "string" ||
    typeof snapshot.leafId !== "string" ||
    typeof snapshot.createdAt !== "string" ||
    typeof snapshot.focus !== "string" ||
    (snapshot.curationInstruction !== undefined && typeof snapshot.curationInstruction !== "string") ||
    typeof snapshot.activeTokens !== "number" ||
    typeof snapshot.rawTailTokens !== "number" ||
    typeof snapshot.rawTailStartEntryId !== "string" ||
    !isStringArray(snapshot.prefixEntryIds) ||
    typeof snapshot.sourceHash !== "string"
  ) {
    return undefined;
  }
  if (
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isCuratorNode) ||
    typeof value.analyzerModel !== "string" ||
    typeof value.checkpointTokens !== "number" ||
    !Array.isArray(value.archivedBlocks)
  ) {
    return undefined;
  }
  const archivesValid = value.archivedBlocks.every((block) =>
    isObject(block) &&
    typeof block.id === "string" &&
    typeof block.title === "string" &&
    typeof block.summary === "string" &&
    isStringArray(block.sourceUnitIds)
  );
  if (!archivesValid) return undefined;
  return value as unknown as CuratorPlanDetails;
}

/** Return Curator checkpoints on the active branch, newest first. */
export function collectCuratorHistory(entries: readonly SessionEntry[]): CuratorHistoryRecord[] {
  const records: CuratorHistoryRecord[] = [];
  for (const entry of entries) {
    if (entry.type !== "compaction") continue;
    const details = parseCuratorPlanDetails(entry.details);
    if (!details) continue;
    const tokensBefore = Number.isFinite(entry.tokensBefore)
      ? entry.tokensBefore
      : details.snapshot.activeTokens;
    records.push({
      entryId: entry.id,
      parentId: entry.parentId,
      timestamp: entry.timestamp || details.snapshot.createdAt,
      tokensBefore,
      projectedTokens: details.checkpointTokens + details.snapshot.rawTailTokens,
      details,
    });
  }
  return records.reverse();
}

export function findHistoryRecord(
  records: readonly CuratorHistoryRecord[],
  entryId: string,
): CuratorHistoryRecord | undefined {
  return records.find((record) => record.entryId === entryId);
}
