import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  Loader,
  matchesKey,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { localize } from "./i18n";
import type { CuratorLanguage } from "./types";

/** Animated, cancellable progress surface for analyzer calls made outside the agent turn. */
export class CuratorLoadingOverlay extends Container {
  private readonly controller = new AbortController();
  private readonly loader: Loader;
  private readonly detail: Text;
  private detailText: string;
  private readonly startedAt = Date.now();
  private elapsedTimer?: ReturnType<typeof setInterval>;
  private finished = false;
  private disposed = false;
  onAbort?: () => void;

  constructor(
    tui: TUI,
    private readonly theme: Theme,
    message: string,
    detail: string,
    private readonly language: CuratorLanguage = "zh",
    private readonly autoTriggered = false,
  ) {
    super();
    const border = (text: string) => theme.fg("border", text);
    this.addChild(new DynamicBorder(border));
    this.loader = new Loader(
      tui,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("text", text),
      message,
    );
    this.addChild(this.loader);
    this.detailText = detail;
    this.detail = new Text(theme.fg("muted", this.elapsedDetail()), 1, 0);
    this.addChild(this.detail);
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg(
          "muted",
          autoTriggered
            ? localize(
                language,
                "Esc / Q 跳过本次自动策展并返回聊天",
                "Esc / Q Skip this auto-curation and return to chat",
              )
            : localize(language, "Esc / Q 取消分析", "Esc / Q Cancel analysis"),
        ),
        1,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(border));
    this.elapsedTimer = setInterval(() => {
      this.refreshDetail();
      tui.requestRender();
    }, 1_000);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  setProgress(message: string, detail?: string): void {
    if (this.disposed) return;
    this.loader.setMessage(message);
    if (detail !== undefined) this.detailText = detail;
    this.refreshDetail();
  }

  private elapsedDetail(): string {
    const elapsed = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1_000));
    return `${this.detailText} · ${localize(this.language, `已等待 ${elapsed}s`, `Elapsed ${elapsed}s`)}`;
  }

  private refreshDetail(): void {
    this.detail.setText(this.theme.fg("muted", this.elapsedDetail()));
  }

  complete(): void {
    this.finished = true;
  }

  cancel(message?: string): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.loader.setMessage(
      message ??
        (this.autoTriggered
          ? localize(this.language, "正在返回聊天…", "Returning to chat…")
          : localize(this.language, "正在取消上下文分析…", "Cancelling context analysis…")),
    );
    this.onAbort?.();
  }

  handleInput(data: string): void {
    if (this.controller.signal.aborted) return;
    if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
      this.cancel();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    this.elapsedTimer = undefined;
    this.loader.stop();
    if (!this.finished && !this.controller.signal.aborted) this.controller.abort();
  }
}
