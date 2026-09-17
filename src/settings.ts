import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { languageName, localize } from "./i18n";
import type {
  CuratorSettingsDraft,
  CuratorSettingsScope,
  SettingsOverlayResult,
} from "./types";

type SettingKey = keyof CuratorSettingsDraft;
type LocalizedCopy = { zh: string; en: string };

const ROWS: Array<{ key: SettingKey; label: LocalizedCopy; hint: LocalizedCopy }> = [
  {
    key: "language",
    label: { zh: "显示语言", en: "Display language" },
    hint: { zh: "控制界面、提示、checkpoint 与分析模型输出", en: "Controls UI, messages, checkpoints, and analyzer output" },
  },
  {
    key: "analyzerModel",
    label: { zh: "分析模型", en: "Analyzer model" },
    hint: { zh: "Enter 打开 Pi 可用模型列表", en: "Press Enter to open Pi's available models" },
  },
  {
    key: "thinkingLevel",
    label: { zh: "Thinking effort", en: "Thinking effort" },
    hint: { zh: "跟随所选模型能力", en: "Limited to levels supported by the selected model" },
  },
  {
    key: "triggerMode",
    label: { zh: "Curate 触发方式", en: "Curate trigger" },
    hint: {
      zh: "manual 手动调用并保留 Pi 兜底 · auto 到强提醒阈值自动分析",
      en: "manual keeps Pi fallback · auto analyzes at the strong threshold",
    },
  },
  {
    key: "maxConcurrentAnalyzerCalls",
    label: { zh: "最大并发调用", en: "Max concurrency" },
    hint: { zh: "仅大型分层分析，1–4", en: "Hierarchical analysis only, 1–4" },
  },
  {
    key: "rawTailTokens",
    label: { zh: "Raw tail", en: "Raw tail" },
    hint: { zh: "始终原样保留的最新上下文", en: "Newest context always kept verbatim" },
  },
  {
    key: "targetCheckpointTokens",
    label: { zh: "Checkpoint 目标", en: "Checkpoint target" },
    hint: { zh: "超过目标时应用会二次确认", en: "Applying above this target requires confirmation" },
  },
  {
    key: "maxAnalyzerInputTokens",
    label: { zh: "分层触发阈值", en: "Hierarchy threshold" },
    hint: { zh: "超过后才会并发分组再合并", en: "Above this size, analyze groups concurrently and merge" },
  },
  {
    key: "maxBlocksPerSplit",
    label: { zh: "单次最多分块", en: "Blocks per split" },
    hint: { zh: "2 或 3", en: "2 or 3" },
  },
  {
    key: "confirmCrossProvider",
    label: { zh: "跨 Provider 确认", en: "Cross-provider prompt" },
    hint: { zh: "每个 Pi 进程、每个模型最多一次", en: "At most once per model in each Pi process" },
  },
  {
    key: "defaultApplyMode",
    label: { zh: "默认应用方式", en: "Default apply mode" },
    hint: { zh: "boundary 或 handoff", en: "boundary or handoff" },
  },
];

const LANGUAGES: CuratorSettingsDraft["language"][] = ["zh", "en"];
const SCOPES: CuratorSettingsScope[] = ["global", "project", "session"];
const TRIGGER_MODES: CuratorSettingsDraft["triggerMode"][] = ["manual", "auto"];
const RAW_TAIL_CHOICES = [4_000, 8_000, 12_000, 16_000, 24_000, 32_000, 48_000, 64_000, 96_000];
const CHECKPOINT_CHOICES = [8_000, 12_000, 18_000, 24_000, 32_000, 48_000, 64_000, 96_000, 128_000];
const HIERARCHY_CHOICES = [50_000, 100_000, 200_000, 400_000, 600_000, 800_000, 900_000];

function fmtTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function stepChoice(current: number, choices: number[], direction: -1 | 1): number {
  const values = [...new Set([...choices, current])].sort((a, b) => a - b);
  const index = values.indexOf(current);
  return values[Math.max(0, Math.min(values.length - 1, index + direction))];
}

function cycle<T>(values: T[], current: T, direction: -1 | 1): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + direction + values.length) % values.length];
}

function settingValue(config: CuratorSettingsDraft, key: SettingKey): string {
  switch (key) {
    case "language":
      return languageName(config.language);
    case "rawTailTokens":
    case "targetCheckpointTokens":
    case "maxAnalyzerInputTokens":
      return fmtTokens(config[key]);
    case "confirmCrossProvider":
      return config[key] ? "on" : "off";
    default:
      return String(config[key]);
  }
}

function boxed(
  lines: string[],
  width: number,
  color: (text: string) => string,
  language: CuratorSettingsDraft["language"],
): string[] {
  const inner = Math.max(24, width - 2);
  const title = ` ${localize(language, "Context Curator 设置", "Context Curator Settings")} `;
  const top = color(`╭${title}${"─".repeat(Math.max(0, inner - visibleWidth(title)))}╮`);
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

export class CuratorSettingsOverlay implements Component {
  private readonly draft: CuratorSettingsDraft;
  private focusIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    initial: CuratorSettingsDraft,
    private readonly thinkingLevels: CuratorSettingsDraft["thinkingLevel"][],
    private readonly scope: CuratorSettingsScope,
    private readonly availableScopes: CuratorSettingsScope[],
    private readonly hasScopeOverride: boolean,
    private readonly target: string,
    private readonly done: (result: SettingsOverlayResult) => void,
  ) {
    this.draft = { ...initial };
  }

  invalidate(): void {}

  private currentRow(): (typeof ROWS)[number] {
    return ROWS[this.focusIndex];
  }

  private adjust(direction: -1 | 1): void {
    const key = this.currentRow().key;
    switch (key) {
      case "language":
        this.draft.language = cycle(LANGUAGES, this.draft.language, direction);
        break;
      case "analyzerModel":
        this.done({ type: "choose-model", draft: { ...this.draft } });
        return;
      case "thinkingLevel":
        this.draft.thinkingLevel = cycle(this.thinkingLevels, this.draft.thinkingLevel, direction);
        break;
      case "triggerMode":
        this.draft.triggerMode = cycle(TRIGGER_MODES, this.draft.triggerMode, direction);
        break;
      case "maxConcurrentAnalyzerCalls":
        this.draft.maxConcurrentAnalyzerCalls = Math.max(
          1,
          Math.min(4, this.draft.maxConcurrentAnalyzerCalls + direction),
        );
        break;
      case "rawTailTokens":
        this.draft.rawTailTokens = stepChoice(this.draft.rawTailTokens, RAW_TAIL_CHOICES, direction);
        break;
      case "targetCheckpointTokens":
        this.draft.targetCheckpointTokens = stepChoice(
          this.draft.targetCheckpointTokens,
          CHECKPOINT_CHOICES,
          direction,
        );
        break;
      case "maxAnalyzerInputTokens":
        this.draft.maxAnalyzerInputTokens = stepChoice(
          this.draft.maxAnalyzerInputTokens,
          HIERARCHY_CHOICES,
          direction,
        );
        break;
      case "maxBlocksPerSplit":
        this.draft.maxBlocksPerSplit = this.draft.maxBlocksPerSplit === 2 ? 3 : 2;
        break;
      case "confirmCrossProvider":
        this.draft.confirmCrossProvider = !this.draft.confirmCrossProvider;
        break;
      case "defaultApplyMode":
        this.draft.defaultApplyMode = this.draft.defaultApplyMode === "boundary" ? "handoff" : "boundary";
        break;
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
      this.done({ type: "cancel" });
      return;
    }
    if (matchesKey(data, Key.tab)) {
      const index = this.availableScopes.indexOf(this.scope);
      const scope = this.availableScopes[(index + 1) % this.availableScopes.length];
      this.done({ type: "scope", scope, draft: { ...this.draft } });
      return;
    }
    if (data.toLowerCase() === "s") {
      this.done({ type: "save", draft: { ...this.draft } });
      return;
    }
    if (data.toLowerCase() === "r") {
      this.done({ type: "reset" });
      return;
    }
    if (matchesKey(data, Key.up)) this.focusIndex--;
    else if (matchesKey(data, Key.down)) this.focusIndex++;
    else if (matchesKey(data, Key.left)) {
      this.adjust(-1);
      return;
    } else if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) {
      this.adjust(1);
      return;
    } else {
      return;
    }
    this.focusIndex = Math.max(0, Math.min(ROWS.length - 1, this.focusIndex));
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const language = this.draft.language;
    const inner = Math.max(24, width - 4);
    const labelWidth = 20;
    const scopeNames: Record<CuratorSettingsScope, LocalizedCopy> = {
      global: { zh: "全局", en: "Global" },
      project: { zh: "项目", en: "Project" },
      session: { zh: "会话", en: "Session" },
    };
    const scopeTabs = SCOPES.map((candidate) => {
      const label = scopeNames[candidate][language];
      if (!this.availableScopes.includes(candidate)) return this.theme.fg("dim", `${label}×`);
      return candidate === this.scope ? this.theme.fg("accent", `[${label}]`) : label;
    }).join("  ");
    const inherited = this.scope === "global"
      ? localize(language, "内置默认值", "built-in defaults")
      : this.scope === "project"
        ? localize(language, "全局设置", "global settings")
        : localize(language, "项目/全局设置", "project/global settings");
    const lines = [
      `${this.theme.bold(localize(language, "作用域", "Scope"))}: ${scopeTabs}`,
      this.theme.fg("dim", this.target),
      this.theme.fg(
        "muted",
        this.hasScopeOverride
          ? localize(
              language,
              `当前层已有弹窗设置覆盖；其余字段继承自${inherited}。`,
              `This scope has popup-managed overrides; other fields inherit from ${inherited}.`,
            )
          : localize(
              language,
              `当前层没有弹窗设置覆盖；显示从${inherited}继承的值。`,
              `No popup-managed overrides in this scope; showing values inherited from ${inherited}.`,
            ),
      ),
      this.theme.fg(
        "muted",
        localize(language, "这些记录不会进入模型上下文。", "These records are not sent into model context."),
      ),
      "",
      ...ROWS.map((row, index) => {
        const valueWidth = Math.max(12, inner - labelWidth - 7);
        const label = row.label[language];
        const paddedLabel = `${label}${" ".repeat(Math.max(1, labelWidth - visibleWidth(label)))}`;
        const content = `${paddedLabel}${truncateToWidth(settingValue(this.draft, row.key), valueWidth)}`;
        return index === this.focusIndex
          ? this.theme.fg("accent", `› ${this.theme.bold(content)}`)
          : `  ${content}`;
      }),
      "",
      this.theme.fg(
        "muted",
        this.currentRow().key === "thinkingLevel"
          ? localize(
              language,
              `该模型支持：${this.thinkingLevels.join(" / ")}`,
              `Supported by this model: ${this.thinkingLevels.join(" / ")}`,
            )
          : this.currentRow().hint[language],
      ),
      this.theme.fg(
        "muted",
        localize(
          language,
          "Tab 切换作用域 · ↑↓ 选择 · ←→/Enter 修改 · S 保存 · R 重置本页字段 · Esc 取消",
          "Tab Scope · ↑↓ Select · ←→/Enter Change · S Save · R Reset shown fields · Esc Cancel",
        ),
      ),
    ];
    return boxed(lines, width, (text) => this.theme.fg("border", text), language);
  }
}
