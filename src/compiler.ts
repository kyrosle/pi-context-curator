import type {
  CompiledActiveBlock,
  CompiledCheckpoint,
  CuratorNode,
  CuratorSnapshot,
  SourceUnit,
} from "./types";
import type { CuratorLanguage } from "./types";
import { localize } from "./i18n";

export function leafNodes(nodes: CuratorNode[]): CuratorNode[] {
  return nodes.flatMap((node) => (node.children?.length ? leafNodes(node.children) : [node]));
}

export function cloneNodes(nodes: CuratorNode[]): CuratorNode[] {
  return nodes.map((node) => ({
    ...node,
    sourceUnitIds: [...node.sourceUnitIds],
    dependencies: [...node.dependencies],
    verbatimEvidence: [...node.verbatimEvidence],
    children: node.children ? cloneNodes(node.children) : undefined,
  }));
}

export function nodeDisplayTitle(node: CuratorNode): string {
  return node.displayTitle?.trim() || node.title;
}

function sourceFor(node: CuratorNode, unitById: Map<string, SourceUnit>): string {
  return node.sourceUnitIds
    .map((id) => unitById.get(id)?.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

function summarySection(node: CuratorNode, language: CuratorLanguage): string {
  const evidence = node.verbatimEvidence.length
    ? `\n\n### ${localize(language, "原样证据", "Exact evidence")}\n${node.verbatimEvidence.map((item) => `- ${item}`).join("\n")}`
    : "";
  return `## ${nodeDisplayTitle(node)}\n\n${node.summary}${evidence}`;
}

function exactSection(
  node: CuratorNode,
  unitById: Map<string, SourceUnit>,
  language: CuratorLanguage,
): string {
  const suffix = localize(language, "（原样）", " (verbatim)");
  return `## ${nodeDisplayTitle(node)}${suffix}\n\n<verbatim-context>\n${sourceFor(node, unitById)}\n</verbatim-context>`;
}

export function dependencyWarnings(
  nodes: CuratorNode[],
  language: CuratorLanguage = "zh",
): string[] {
  const leaves = leafNodes(nodes);
  const keptTitles = new Set(leaves.filter((node) => node.mode !== "drop").map((node) => node.title));
  const displayTitles = new Map(leaves.map((node) => [node.title, nodeDisplayTitle(node)]));
  const warnings: string[] = [];
  for (const node of leaves) {
    if (node.mode === "drop") continue;
    for (const dependency of node.dependencies) {
      if (!keptTitles.has(dependency)) {
        warnings.push(
          localize(
            language,
            `${nodeDisplayTitle(node)} 依赖已排除块：${displayTitles.get(dependency) ?? dependency}`,
            `${nodeDisplayTitle(node)} depends on excluded block: ${displayTitles.get(dependency) ?? dependency}`,
          ),
        );
      }
    }
  }
  return warnings;
}

export function compileCheckpoint(
  snapshot: CuratorSnapshot,
  nodes: CuratorNode[],
  unitById: Map<string, SourceUnit>,
  includeArchiveIndex: boolean,
  language: CuratorLanguage = "zh",
): CompiledCheckpoint {
  const leaves = leafNodes(nodes);
  const kept = leaves.filter((node) => node.mode !== "drop");
  const dropped = leaves.filter((node) => node.mode === "drop");
  const activeBlocks: CompiledActiveBlock[] = kept.map((node) => {
    const mode: CompiledActiveBlock["mode"] = node.mode === "exact" ? "exact" : "summary";
    const text = mode === "exact"
      ? exactSection(node, unitById, language)
      : summarySection(node, language);
    return {
      id: node.id,
      title: nodeDisplayTitle(node),
      mode,
      text,
      sourceUnitIds: [...node.sourceUnitIds],
      estimatedTokens: Math.ceil(text.length / 4),
    };
  });
  const sections = activeBlocks.map((block) => block.text);

  const archivedBlocks = dropped.map((node) => ({
    id: node.id,
    title: nodeDisplayTitle(node),
    summary: node.summary,
    sourceUnitIds: [...node.sourceUnitIds],
  }));

  const archive = includeArchiveIndex && archivedBlocks.length
    ? `\n\n## ${localize(language, "可恢复的归档上下文", "Archived Context Available")}\n\n${archivedBlocks
        .map(
          (block) =>
            localize(
              language,
              `- ${block.title} [${block.id}] — ${block.sourceUnitIds.length} 个来源单元；使用 /curate restore 恢复其摘要`,
              `- ${block.title} [${block.id}] — ${block.sourceUnitIds.length} source unit(s); use /curate restore to reintroduce its summary`,
            ),
        )
        .join("\n")}`
    : "";

  const emptySelection = localize(
    language,
    "## 已选上下文\n\n没有选择任何历史块。请从保留的 raw tail 继续。",
    "## Selected Context\n\nNo historical blocks were selected. Continue from the retained raw tail.",
  );
  const metadata = localize(
    language,
    `## 检查点元数据\n\n- 策展时间：${snapshot.createdAt}\n- 来源 session：${snapshot.sessionId}\n- 来源快照：${snapshot.sourceHash.slice(0, 16)}\n- 历史来源仍可从 append-only session 恢复。`,
    `## Checkpoint Metadata\n\n- Curated at: ${snapshot.createdAt}\n- Source session: ${snapshot.sessionId}\n- Source snapshot: ${snapshot.sourceHash.slice(0, 16)}\n- Historical source remains recoverable from the append-only session.`,
  );
  const instruction = snapshot.curationInstruction
    ? `\n\n## ${localize(language, "策展指令", "Curation Instruction")}\n\n${snapshot.curationInstruction}`
    : "";
  const text = `# ${localize(language, "交互式上下文检查点", "Interactive Context Checkpoint")}\n\n## ${localize(language, "当前焦点", "Current Focus")}\n\n${snapshot.focus}${instruction}\n\n${
    sections.length ? sections.join("\n\n") : emptySelection
  }${archive}\n\n${metadata}`;

  return {
    text,
    estimatedTokens: Math.ceil(text.length / 4),
    activeBlocks,
    archivedBlocks,
  };
}

export function nodeSourceTokens(node: CuratorNode, unitById: Map<string, SourceUnit>): number {
  return node.sourceUnitIds.reduce((sum, id) => sum + (unitById.get(id)?.tokens ?? 0), 0);
}

export function nodeProjectedTokens(node: CuratorNode, unitById: Map<string, SourceUnit>): number {
  if (node.children?.length) {
    return node.children.reduce((sum, child) => sum + nodeProjectedTokens(child, unitById), 0);
  }
  if (node.mode === "drop") return 0;
  if (node.mode === "exact") return Math.ceil(sourceFor(node, unitById).length / 4);
  return Math.ceil((nodeDisplayTitle(node).length + node.summary.length + node.verbatimEvidence.join("\n").length) / 4);
}
