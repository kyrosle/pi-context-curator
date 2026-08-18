import {
  getSelectListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  cloneNodes,
  compileCheckpoint,
  dependencyWarnings,
  leafNodes,
  nodeProjectedTokens,
  nodeSourceTokens,
} from "./compiler";
import { displayMode, displayRisk, joinLocalized, localize } from "./i18n";
import type {
  CuratorConfig,
  CuratorNode,
  CuratorSnapshot,
  OverlayResult,
  SourceUnit,
} from "./types";

interface NodeRow {
  node: CuratorNode;
  depth: number;
}

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

function wrapInBox(lines: string[], width: number, color: (text: string) => string, title: string): string[] {
  const inner = Math.max(2, width - 2);
  const label = ` ${title} `;
  const remain = Math.max(0, inner - label.length);
  const left = Math.floor(remain / 2);
  const right = remain - left;
  const top = color(`╭${"─".repeat(left)}${label}${"─".repeat(right)}╮`);
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
  if (node.mode === "drop") return " ";
  return "✓";
}

function flatten(nodes: CuratorNode[], expanded: Set<string>, depth = 0): NodeRow[] {
  const rows: NodeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.children?.length && expanded.has(node.id)) {
      rows.push(...flatten(node.children, expanded, depth + 1));
    }
  }
  return rows;
}

export class CuratorOverlay implements Component {
  private readonly selectTheme = getSelectListTheme();
  private readonly expanded = new Set<string>();
  private focusIndex = 0;
  private scrollOffset = 0;
  private preview = false;
  private inspect = false;
  private busy = false;
  private error?: string;
  private confirmApply = false;
  private splitController?: AbortController;
  private busyMessage: string;
  private busyStartedAt = 0;
  private spinnerIndex = 0;
  private spinnerTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly snapshot: CuratorSnapshot,
    private readonly nodes: CuratorNode[],
    private readonly unitById: Map<string, SourceUnit>,
    private readonly config: CuratorConfig,
    private applyMode: "boundary" | "handoff",
    private readonly autoTriggered: boolean,
    private readonly allowNativeFallback: boolean,
    private readonly splitNode: (
      node: CuratorNode,
      signal: AbortSignal,
      report: (message: string) => void,
    ) => Promise<CuratorNode[]>,
    private readonly done: (result: OverlayResult) => void,
  ) {
    this.busyMessage = localize(config.language, "准备拆分当前块", "Preparing to split the current block");
    for (const node of nodes) this.expanded.add(node.id);
  }

  invalidate(): void {}

  dispose(): void {
    this.splitController?.abort();
    this.stopSpinner();
  }

  private rows(): NodeRow[] {
    return flatten(this.nodes, this.expanded);
  }

  private bodyHeight(): number {
    return Math.max(9, Math.floor(this.tui.terminal.rows * 0.82) - 10);
  }

  private clamp(): void {
    const rows = this.rows();
    this.focusIndex = Math.max(0, Math.min(this.focusIndex, Math.max(0, rows.length - 1)));
    const height = this.bodyHeight();
    if (this.focusIndex < this.scrollOffset) this.scrollOffset = this.focusIndex;
    if (this.focusIndex >= this.scrollOffset + height) this.scrollOffset = this.focusIndex - height + 1;
    this.scrollOffset = Math.max(0, this.scrollOffset);
  }

  private currentNode(): CuratorNode | undefined {
    return this.rows()[this.focusIndex]?.node;
  }

  private resetConfirmation(): void {
    this.confirmApply = false;
    this.error = undefined;
  }

  private startSpinner(message: string): void {
    this.stopSpinner();
    this.busyMessage = message;
    this.busyStartedAt = Date.now();
    this.spinnerIndex = 0;
    this.spinnerTimer = setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % 10;
      this.tui.requestRender();
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  private reportBusy(message: string): void {
    this.busyMessage = message;
    this.tui.requestRender();
  }

  private cycleMode(node: CuratorNode): void {
    if (node.children?.length) return;
    node.mode = node.mode === "summary" ? "exact" : node.mode === "exact" ? "drop" : "summary";
    this.resetConfirmation();
  }

  private async splitFocused(): Promise<void> {
    const node = this.currentNode();
    if (!node) return;
    if (node.children?.length) {
      if (this.expanded.has(node.id)) this.expanded.delete(node.id);
      else this.expanded.add(node.id);
      this.tui.requestRender();
      return;
    }
    if (node.sourceUnitIds.length === 0 || this.busy) return;

    this.busy = true;
    this.error = undefined;
    this.splitController = new AbortController();
    this.startSpinner(
      localize(
        this.config.language,
        `准备拆分“${node.title}”`,
        `Preparing to split “${node.title}”`,
      ),
    );
    this.tui.requestRender();
    try {
      node.children = await this.splitNode(
        node,
        this.splitController.signal,
        (message) => this.reportBusy(message),
      );
      this.expanded.add(node.id);
      this.resetConfirmation();
    } catch (error) {
      if (!this.splitController.signal.aborted) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.busy = false;
      this.splitController = undefined;
      this.stopSpinner();
      this.tui.requestRender();
    }
  }

  private apply(): void {
    if (this.busy) return;
    const compiled = compileCheckpoint(
      this.snapshot,
      this.nodes,
      this.unitById,
      this.config.archiveIndex,
      this.config.language,
    );
    const warnings = dependencyWarnings(this.nodes, this.config.language);
    const leaves = leafNodes(this.nodes);
    const highRiskDrops = leaves.filter((node) => node.mode === "drop" && node.risk === "high");
    const keptCount = leaves.filter((node) => node.mode !== "drop").length;
    const risky =
      warnings.length > 0 ||
      highRiskDrops.length > 0 ||
      keptCount === 0 ||
      compiled.estimatedTokens > this.config.targetCheckpointTokens;
    if (risky && !this.confirmApply) {
      this.confirmApply = true;
      this.error = [
        ...warnings,
        ...(highRiskDrops.length > 0
          ? [
              localize(
                this.config.language,
                `将排除高风险块：${joinLocalized(this.config.language, highRiskDrops.map((node) => node.title))}`,
                `High-risk blocks will be excluded: ${joinLocalized(this.config.language, highRiskDrops.map((node) => node.title))}`,
              ),
            ]
          : []),
        ...(keptCount === 0
          ? [
              localize(
                this.config.language,
                "所有历史块都将被排除，只保留 raw tail",
                "All historical blocks will be excluded; only the raw tail will remain",
              ),
            ]
          : []),
        ...(compiled.estimatedTokens > this.config.targetCheckpointTokens
          ? [
              localize(
                this.config.language,
                `Checkpoint ${fmtTokens(compiled.estimatedTokens)} 超过目标 ${fmtTokens(this.config.targetCheckpointTokens)}`,
                `Checkpoint ${fmtTokens(compiled.estimatedTokens)} exceeds target ${fmtTokens(this.config.targetCheckpointTokens)}`,
              ),
            ]
          : []),
        localize(this.config.language, "如确认继续，请再次按 A。", "Press A again to confirm."),
      ].join(" · ");
      this.tui.requestRender();
      return;
    }
    this.done({ type: "apply", nodes: cloneNodes(this.nodes), applyMode: this.applyMode });
  }

  handleInput(data: string): void {
    if (this.busy) {
      if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
        this.reportBusy(
          localize(this.config.language, "正在取消本次拆分…", "Cancelling this split…"),
        );
        this.splitController?.abort();
      }
      return;
    }
    if (this.preview || this.inspect) {
      if (
        matchesKey(data, Key.escape) ||
        data === "q" ||
        (this.preview && data.toLowerCase() === "p") ||
        (this.inspect && data.toLowerCase() === "i")
      ) {
        this.preview = false;
        this.inspect = false;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q") {
      this.done({ type: "cancel" });
      return;
    }
    if (data.toLowerCase() === "b" && this.allowNativeFallback) {
      this.done({ type: "fallback" });
      return;
    }
    if (matchesKey(data, Key.up)) this.focusIndex--;
    else if (matchesKey(data, Key.down)) this.focusIndex++;
    else if (matchesKey(data, "pageUp")) this.focusIndex -= this.bodyHeight();
    else if (matchesKey(data, "pageDown")) this.focusIndex += this.bodyHeight();
    else if (matchesKey(data, Key.home)) this.focusIndex = 0;
    else if (matchesKey(data, Key.end)) this.focusIndex = this.rows().length - 1;
    else if (data === " ") {
      const node = this.currentNode();
      if (node) this.cycleMode(node);
    } else if (data.toLowerCase() === "e") {
      const node = this.currentNode();
      if (node && !node.children?.length) {
        node.mode = "exact";
        this.resetConfirmation();
      }
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
      void this.splitFocused();
      return;
    } else if (matchesKey(data, Key.left)) {
      const node = this.currentNode();
      if (node?.children?.length) this.expanded.delete(node.id);
    } else if (data.toLowerCase() === "p") {
      this.preview = true;
    } else if (data.toLowerCase() === "i") {
      this.inspect = true;
    } else if (data.toLowerCase() === "h") {
      this.applyMode = this.applyMode === "boundary" ? "handoff" : "boundary";
      this.resetConfirmation();
    } else if (data.toLowerCase() === "s") {
      this.done({ type: "settings", applyMode: this.applyMode });
      return;
    } else if (data.toLowerCase() === "a") {
      this.apply();
      return;
    } else {
      return;
    }
    this.clamp();
    this.tui.requestRender();
  }

  private renderTree(width: number): string[] {
    const rows = this.rows();
    this.clamp();
    const height = this.bodyHeight();
    const visible = rows.slice(this.scrollOffset, this.scrollOffset + height);
    const result = visible.map((row, offset) => {
      const node = row.node;
      const branch = node.children?.length ? (this.expanded.has(node.id) ? "▾" : "▸") : " ";
      const source = nodeSourceTokens(node, this.unitById);
      const projected = nodeProjectedTokens(node, this.unitById);
      const riskColor = node.risk === "high" ? "error" : node.risk === "medium" ? "warning" : "muted";
      const base = `${"  ".repeat(row.depth)}${branch} [${modeGlyph(node)}] ${node.title}  ${fmtTokens(source)} → ${fmtTokens(projected)}  ${this.theme.fg(riskColor, displayRisk(this.config.language, node.risk))}`;
      const focused = this.scrollOffset + offset === this.focusIndex;
      return focused
        ? `${this.selectTheme.selectedPrefix("› ")}${this.selectTheme.selectedText(truncateToWidth(base, Math.max(10, width - 2)))}`
        : `  ${truncateToWidth(base, Math.max(10, width - 2))}`;
    });
    while (result.length < height) result.push("");
    return result;
  }

  private renderPreview(width: number): string[] {
    const compiled = compileCheckpoint(
      this.snapshot,
      this.nodes,
      this.unitById,
      this.config.archiveIndex,
      this.config.language,
    );
    const height = this.bodyHeight() + 3;
    const lines = compiled.text.split("\n").slice(0, height);
    if (compiled.text.split("\n").length > height) {
      lines.push(localize(this.config.language, "… 预览已截断 …", "… preview truncated …"));
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private renderInspect(width: number): string[] {
    const node = this.currentNode();
    if (!node) {
      return [localize(this.config.language, "没有可检查的上下文块。", "No context block to inspect.")];
    }
    const sourceTokens = nodeSourceTokens(node, this.unitById);
    const lines = [
      this.theme.bold(node.title),
      localize(
        this.config.language,
        `当前：${displayMode(this.config.language, node.children?.length ? "split" : node.mode)} · 推荐：${displayMode(this.config.language, node.recommendedMode)} · 风险：${displayRisk(this.config.language, node.risk)} · 来源：${fmtTokens(sourceTokens)}`,
        `Current: ${displayMode(this.config.language, node.children?.length ? "split" : node.mode)} · Recommended: ${displayMode(this.config.language, node.recommendedMode)} · Risk: ${displayRisk(this.config.language, node.risk)} · Source: ${fmtTokens(sourceTokens)}`,
      ),
      "",
      this.theme.bold(localize(this.config.language, "保留理由", "Retention rationale")),
      node.rationale,
      "",
      this.theme.bold(localize(this.config.language, "摘要", "Summary")),
      node.summary,
      "",
      this.theme.bold(localize(this.config.language, "依赖", "Dependencies")),
      node.dependencies.length
        ? joinLocalized(this.config.language, node.dependencies)
        : localize(this.config.language, "无", "None"),
      "",
      this.theme.bold(localize(this.config.language, "原样证据", "Verbatim evidence")),
      ...(node.verbatimEvidence.length
        ? node.verbatimEvidence.map((item) => `- ${item}`)
        : [localize(this.config.language, "无", "None")]),
      "",
      this.theme.bold(localize(this.config.language, "来源单元", "Source units")),
      node.sourceUnitIds.join(", "),
    ].flatMap((line) => wrapTextWithAnsi(line, width));
    const height = this.bodyHeight() + 3;
    if (lines.length <= height) return lines;
    return [
      ...lines.slice(0, Math.max(1, height - 1)),
      localize(this.config.language, "… 详情已截断 …", "… details truncated …"),
    ];
  }

  render(width: number): string[] {
    const inner = Math.max(20, width - 2);
    const compiled = compileCheckpoint(
      this.snapshot,
      this.nodes,
      this.unitById,
      this.config.archiveIndex,
      this.config.language,
    );
    const projected = compiled.estimatedTokens + this.snapshot.rawTailTokens;
    const header = [
      this.theme.bold(
        `${localize(this.config.language, "焦点", "Focus")}: ${truncateToWidth(this.snapshot.focus, Math.max(10, inner - 7))}`,
      ),
      localize(
        this.config.language,
        `${fmtTokens(this.snapshot.activeTokens)} 当前 → ${fmtTokens(projected)} 预计 · raw tail ${fmtTokens(this.snapshot.rawTailTokens)} · 应用 ${this.applyMode}`,
        `${fmtTokens(this.snapshot.activeTokens)} active → ${fmtTokens(projected)} projected · raw tail ${fmtTokens(this.snapshot.rawTailTokens)} · apply ${this.applyMode}`,
      ),
      this.theme.fg(
        "muted",
        localize(
          this.config.language,
          `快照 ${this.snapshot.sourceHash.slice(0, 12)} · 强制来源全覆盖`,
          `Snapshot ${this.snapshot.sourceHash.slice(0, 12)} · source coverage enforced`,
        ),
      ),
      "",
    ];
    const body = this.preview
      ? this.renderPreview(inner)
      : this.inspect
        ? this.renderInspect(inner)
        : this.renderTree(inner);
    const status = this.busy
      ? this.theme.fg(
          "warning",
          `${["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.spinnerIndex]} ${this.busyMessage} · ${Math.max(0, Math.floor((Date.now() - this.busyStartedAt) / 1000))}s · ${localize(this.config.language, "Esc 取消", "Esc Cancel")}`,
        )
      : this.error
        ? this.theme.fg("error", truncateToWidth(this.error, inner))
        : this.theme.fg(
            "muted",
            `${localize(
              this.config.language,
              "Space 三态 · E 原样 · Enter 拆分 · I 详情 · P checkpoint · S 设置 · H 方式 · A 应用",
              "Space Cycle · E Exact · Enter Split · I Inspect · P Checkpoint · S Settings · H Mode · A Apply",
            )}${
              this.allowNativeFallback
                ? localize(this.config.language, " · B Pi 原生兜底", " · B Pi fallback")
                : ""
            }${
              this.autoTriggered
                ? localize(
                    this.config.language,
                    " · Esc 继续聊天（本区间不再弹）",
                    " · Esc Keep chatting (do not reopen in this band)",
                  )
                : localize(this.config.language, " · Esc 取消", " · Esc Cancel")
            }`,
          );
    const footer = this.preview
      ? this.theme.fg(
          "muted",
          localize(this.config.language, "P / Esc 返回上下文树", "P / Esc Return to context tree"),
        )
      : this.inspect
        ? this.theme.fg(
            "muted",
            localize(this.config.language, "I / Esc 返回上下文树", "I / Esc Return to context tree"),
          )
        : status;
    return wrapInBox([...header, ...body, "", footer], width, (text) => this.theme.fg("border", text), "Context Curator");
  }
}
