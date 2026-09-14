import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { leafNodes, nodeDisplayTitle } from "./compiler";
import { displayMode, localize } from "./i18n";
import type {
  CuratorHistoryRecord,
  CuratorLanguage,
  CuratorNode,
  HistoryOverlayResult,
} from "./types";

interface HistoryNodeRow {
  node: CuratorNode;
  depth: number;
}

function flatten(nodes: readonly CuratorNode[], depth = 0): HistoryNodeRow[] {
  const rows: HistoryNodeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.children?.length) rows.push(...flatten(node.children, depth + 1));
  }
  return rows;
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatTimestamp(timestamp: string, language: CuratorLanguage): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp.slice(0, 16);
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-GB", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function wrapLimited(text: string, width: number, maxLines: number): string[] {
  const lines = wrapTextWithAnsi(text || "—", Math.max(4, width));
  if (lines.length <= maxLines) return lines;
  const visible = lines.slice(0, maxLines);
  visible[maxLines - 1] = `${truncateToWidth(visible[maxLines - 1] ?? "", Math.max(1, width - 1))}…`;
  return visible;
}

function boxed(
  lines: string[],
  width: number,
  color: (text: string) => string,
  title: string,
): string[] {
  const inner = Math.max(28, width - 2);
  const label = ` ${title} `;
  const remain = Math.max(0, inner - visibleWidth(label));
  const top = color(`╭${label}${"─".repeat(remain)}╮`);
  const bottom = color(`╰${"─".repeat(inner)}╯`);
  return [
    top,
    ...lines.map((line) => {
      const clipped = truncateToWidth(line, inner);
      return `${color("│")}${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))}${color("│")}`;
    }),
    bottom,
  ];
}

function modeGlyph(node: CuratorNode): string {
  if (node.children?.length) return "◐";
  if (node.mode === "exact") return "E";
  if (node.mode === "drop") return "D";
  return "S";
}

function modeCounts(record: CuratorHistoryRecord): string {
  const leaves = leafNodes(record.details.nodes);
  const summary = leaves.filter((node) => node.mode === "summary").length;
  const exact = leaves.filter((node) => node.mode === "exact").length;
  const drop = leaves.filter((node) => node.mode === "drop").length;
  return `S${summary} E${exact} D${drop}`;
}

/** Read-only browser for Curator metadata persisted on the active branch. */
export class CuratorHistoryOverlay implements Component {
  private view: "list" | "detail" = "list";
  private historyIndex = 0;
  private historyScroll = 0;
  private nodeIndex = 0;
  private nodeScroll = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly records: readonly CuratorHistoryRecord[],
    private readonly language: CuratorLanguage,
    private readonly done: (result: HistoryOverlayResult) => void,
  ) {}

  invalidate(): void {}

  private bodyHeight(): number {
    return Math.max(10, Math.floor(this.tui.terminal.rows * 0.82) - 8);
  }

  private selectedRecord(): CuratorHistoryRecord {
    return this.records[this.historyIndex];
  }

  private selectedNode(): CuratorNode | undefined {
    return flatten(this.selectedRecord().details.nodes)[this.nodeIndex]?.node;
  }

  private clampHistory(): void {
    this.historyIndex = Math.max(0, Math.min(this.historyIndex, this.records.length - 1));
    const height = Math.max(3, this.bodyHeight() - 8);
    if (this.historyIndex < this.historyScroll) this.historyScroll = this.historyIndex;
    if (this.historyIndex >= this.historyScroll + height) {
      this.historyScroll = this.historyIndex - height + 1;
    }
    this.historyScroll = Math.max(0, this.historyScroll);
  }

  private clampNodes(): void {
    const rows = flatten(this.selectedRecord().details.nodes);
    this.nodeIndex = Math.max(0, Math.min(this.nodeIndex, Math.max(0, rows.length - 1)));
    const height = Math.max(3, this.bodyHeight() - 12);
    if (this.nodeIndex < this.nodeScroll) this.nodeScroll = this.nodeIndex;
    if (this.nodeIndex >= this.nodeScroll + height) this.nodeScroll = this.nodeIndex - height + 1;
    this.nodeScroll = Math.max(0, this.nodeScroll);
  }

  private requestRestore(): void {
    const record = this.selectedRecord();
    const node = this.view === "detail" ? this.selectedNode() : undefined;
    const block = node?.mode === "drop"
      ? record.details.archivedBlocks.find((candidate) => candidate.id === node.id)
      : undefined;
    if (block) {
      this.done({ type: "restore", checkpointEntryId: record.entryId, blockId: block.id });
      return;
    }
    this.done({ type: "restore", checkpointEntryId: record.entryId });
  }

  handleInput(data: string): void {
    const lower = data.toLowerCase();
    if (lower === "q") {
      this.done({ type: "cancel" });
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.view === "detail") {
        this.view = "list";
        this.tui.requestRender();
      } else {
        this.done({ type: "cancel" });
      }
      return;
    }
    if (lower === "r") {
      this.requestRestore();
      return;
    }
    if (lower === "f") {
      this.done({ type: "fork", checkpointEntryId: this.selectedRecord().entryId });
      return;
    }
    if (this.view === "list") {
      if (matchesKey(data, Key.up)) this.historyIndex--;
      else if (matchesKey(data, Key.down)) this.historyIndex++;
      else if (matchesKey(data, "pageUp")) this.historyIndex -= Math.max(3, this.bodyHeight() - 8);
      else if (matchesKey(data, "pageDown")) this.historyIndex += Math.max(3, this.bodyHeight() - 8);
      else if (matchesKey(data, Key.home)) this.historyIndex = 0;
      else if (matchesKey(data, Key.end)) this.historyIndex = this.records.length - 1;
      else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        this.view = "detail";
        this.nodeIndex = 0;
        this.nodeScroll = 0;
      } else {
        return;
      }
      this.clampHistory();
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) this.nodeIndex--;
    else if (matchesKey(data, Key.down)) this.nodeIndex++;
    else if (matchesKey(data, "pageUp")) this.nodeIndex -= Math.max(3, this.bodyHeight() - 12);
    else if (matchesKey(data, "pageDown")) this.nodeIndex += Math.max(3, this.bodyHeight() - 12);
    else if (matchesKey(data, Key.home)) this.nodeIndex = 0;
    else if (matchesKey(data, Key.end)) this.nodeIndex = flatten(this.selectedRecord().details.nodes).length - 1;
    else if (matchesKey(data, Key.left)) {
      this.view = "list";
    } else {
      return;
    }
    this.clampNodes();
    this.tui.requestRender();
  }

  private renderList(inner: number): string[] {
    const height = Math.max(3, this.bodyHeight() - 8);
    const visible = this.records.slice(this.historyScroll, this.historyScroll + height);
    const selected = this.selectedRecord();
    const focus = wrapLimited(selected.details.snapshot.focus, inner - 2, 2);
    const instruction = selected.details.snapshot.curationInstruction
      ? wrapLimited(selected.details.snapshot.curationInstruction, inner - 2, 1)
      : [];
    return [
      this.theme.bold(localize(this.language, "当前分支的 Curator 历史", "Curator history on the current branch")),
      this.theme.fg(
        "muted",
        localize(
          this.language,
          "只读浏览不会恢复内容，也不会进入模型上下文。",
          "Browsing is read-only and never restores content into model context.",
        ),
      ),
      "",
      ...visible.map((record, offset) => {
        const index = this.historyScroll + offset;
        const number = this.records.length - index;
        const text = `#${number}  ${formatTimestamp(record.timestamp, this.language)}  ${fmtTokens(record.tokensBefore)} → ${fmtTokens(record.projectedTokens)}  ${modeCounts(record)}`;
        return index === this.historyIndex
          ? this.theme.fg("accent", `› ${this.theme.bold(text)}`)
          : `  ${text}`;
      }),
      "",
      this.theme.fg("muted", `${localize(this.language, "焦点", "Focus")}:`),
      ...focus.map((line) => `  ${line}`),
      ...instruction.flatMap((line, index) => index === 0
        ? [this.theme.fg("muted", `${localize(this.language, "指令", "Instruction")}:`), `  ${line}`]
        : [`  ${line}`]),
      this.theme.fg(
        "muted",
        localize(
          this.language,
          "Enter 详情 · R 恢复归档摘要 · F 从压缩前 fork · Esc/Q 关闭",
          "Enter Details · R Restore archived summary · F Fork before curation · Esc/Q Close",
        ),
      ),
    ];
  }

  private renderDetail(inner: number): string[] {
    const record = this.selectedRecord();
    const rows = flatten(record.details.nodes);
    const height = Math.max(3, this.bodyHeight() - 12);
    const visible = rows.slice(this.nodeScroll, this.nodeScroll + height);
    const selected = this.selectedNode();
    const summary = wrapLimited(
      selected?.summary ?? localize(this.language, "没有摘要", "No summary"),
      inner - 2,
      3,
    );
    return [
      this.theme.bold(`${formatTimestamp(record.timestamp, this.language)} · ${fmtTokens(record.tokensBefore)} → ${fmtTokens(record.projectedTokens)}`),
      this.theme.fg(
        "muted",
        `${record.details.analyzerModel} · ${localize(this.language, "来源", "source")} ${record.details.snapshot.sourceHash.slice(0, 16)}`,
      ),
      ...wrapLimited(`${localize(this.language, "焦点", "Focus")}: ${record.details.snapshot.focus}`, inner, 2),
      ...(record.details.snapshot.curationInstruction
        ? wrapLimited(`${localize(this.language, "指令", "Instruction")}: ${record.details.snapshot.curationInstruction}`, inner, 2)
        : []),
      "",
      ...visible.map((row, offset) => {
        const index = this.nodeScroll + offset;
        const indent = "  ".repeat(row.depth);
        const text = `${indent}[${modeGlyph(row.node)}] ${nodeDisplayTitle(row.node)}`;
        return index === this.nodeIndex
          ? this.theme.fg("accent", `› ${this.theme.bold(text)}`)
          : `  ${text}`;
      }),
      "",
      this.theme.fg(
        "muted",
        `${localize(this.language, "当前块", "Selected block")} · ${selected ? displayMode(this.language, selected.mode) : "—"}`,
      ),
      ...summary.map((line) => `  ${line}`),
      this.theme.fg(
        "muted",
        localize(
          this.language,
          "R 恢复当前 Drop 块/选择归档 · F 从压缩前 fork · ←/Esc 返回 · Q 关闭",
          "R Restore selected Drop/choose archive · F Fork before curation · ←/Esc Back · Q Close",
        ),
      ),
    ];
  }

  render(width: number): string[] {
    const inner = Math.max(28, width - 4);
    const lines = this.view === "list" ? this.renderList(inner) : this.renderDetail(inner);
    return boxed(
      lines,
      width,
      (text) => this.theme.fg("border", text),
      localize(this.language, "Context Curator 历史", "Context Curator History"),
    );
  }
}
