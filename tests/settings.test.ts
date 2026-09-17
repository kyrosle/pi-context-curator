import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { settingsDraft, DEFAULT_CONFIG } from "../src/config";
import { CuratorSettingsOverlay } from "../src/settings";
import type { SettingsOverlayResult } from "../src/types";

describe("settings overlay", () => {
  test("renders session scope and saves keyboard adjustments", () => {
    let result: SettingsOverlayResult | undefined;
    let renders = 0;
    const tui = {
      terminal: { rows: 40 },
      requestRender() {
        renders++;
      },
    } as unknown as TUI;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    const overlay = new CuratorSettingsOverlay(
      tui,
      theme,
      settingsDraft(DEFAULT_CONFIG),
      ["off", "low", "high", "max"],
      "session",
      ["global", "project", "session"],
      false,
      "session:test",
      (value) => {
        result = value;
      },
    );

    // Pi may assign this runtime field to focusable components.
    (overlay as unknown as { focused: boolean }).focused = true;
    const rendered = overlay.render(90).join("\n");
    expect(rendered).toContain("作用域");
    expect(rendered).toContain("[会话]");
    expect(rendered).toContain("不会进入模型上下文");

    overlay.handleInput("\u001b[B");
    overlay.handleInput("\u001b[B");
    overlay.handleInput("\u001b[C");
    overlay.handleInput("\u001b[C");
    overlay.handleInput("s");
    expect(renders).toBeGreaterThan(0);
    expect(result?.type).toBe("save");
    if (result?.type === "save") expect(result.draft.thinkingLevel).toBe("max");
  });

  test("Enter on the model row requests the Pi model picker", () => {
    let result: SettingsOverlayResult | undefined;
    const overlay = new CuratorSettingsOverlay(
      { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as unknown as Theme,
      settingsDraft(DEFAULT_CONFIG),
      ["off", "low", "high", "max"],
      "session",
      ["global", "project", "session"],
      true,
      "session:test",
      (value) => {
        result = value;
      },
    );

    overlay.handleInput("\u001b[B");
    overlay.handleInput("\r");
    expect(result?.type).toBe("choose-model");
  });

  test("switches the popup language immediately and saves it", () => {
    let result: SettingsOverlayResult | undefined;
    const overlay = new CuratorSettingsOverlay(
      { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as unknown as Theme,
      settingsDraft(DEFAULT_CONFIG),
      ["off", "low", "high", "max"],
      "session",
      ["global", "project", "session"],
      false,
      "session:test",
      (value) => {
        result = value;
      },
    );

    overlay.handleInput("\u001b[C");
    const rendered = overlay.render(90).join("\n");
    expect(rendered).toContain("Scope");
    expect(rendered).toContain("[Session]");
    expect(rendered).toContain("Display language");
    expect(rendered).not.toContain("当前 session 的覆盖设置");

    overlay.handleInput("s");
    expect(result?.type).toBe("save");
    if (result?.type === "save") expect(result.draft.language).toBe("en");
  });

  test("Tab switches from session to global scope", () => {
    let result: SettingsOverlayResult | undefined;
    const overlay = new CuratorSettingsOverlay(
      { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      } as unknown as Theme,
      settingsDraft(DEFAULT_CONFIG),
      ["off", "low", "high", "max"],
      "session",
      ["global", "project", "session"],
      false,
      "session:test",
      (value) => {
        result = value;
      },
    );

    overlay.handleInput("\t");
    expect(result?.type).toBe("scope");
    if (result?.type === "scope") expect(result.scope).toBe("global");
  });
});
