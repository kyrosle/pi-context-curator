import { describe, expect, test } from "bun:test";
import { AutoCuratorGate, autoPressureBand } from "../src/auto";

describe("automatic curator pressure gate", () => {
  test("maps usage to strong and emergency bands", () => {
    expect(autoPressureBand(79.9, 80, 92)).toBe(0);
    expect(autoPressureBand(80, 80, 92)).toBe(1);
    expect(autoPressureBand(92, 80, 92)).toBe(2);
  });

  test("claims each band once and resets after pressure drops", () => {
    const gate = new AutoCuratorGate();

    expect(gate.claim("session", 85, 80, 92)).toBe(1);
    expect(gate.claim("session", 89, 80, 92)).toBe(0);
    expect(gate.claim("session", 93, 80, 92)).toBe(2);
    expect(gate.claim("session", 94, 80, 92)).toBe(0);
    expect(gate.claim("session", 70, 80, 92)).toBe(0);
    expect(gate.claim("session", 85, 80, 92)).toBe(1);
  });
});
