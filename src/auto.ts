export type AutoPressureBand = 0 | 1 | 2;

export function autoPressureBand(
  percent: number,
  strongNotifyPercent: number,
  emergencyPercent: number,
): AutoPressureBand {
  if (percent >= emergencyPercent) return 2;
  if (percent >= strongNotifyPercent) return 1;
  return 0;
}

/** Claims at most one automatic Curator launch in each pressure band. */
export class AutoCuratorGate {
  private readonly claimedBand = new Map<string, AutoPressureBand>();

  claim(
    sessionId: string,
    percent: number,
    strongNotifyPercent: number,
    emergencyPercent: number,
  ): AutoPressureBand {
    const band = autoPressureBand(percent, strongNotifyPercent, emergencyPercent);
    if (band === 0) {
      this.claimedBand.delete(sessionId);
      return 0;
    }
    if (band <= (this.claimedBand.get(sessionId) ?? 0)) return 0;
    this.claimedBand.set(sessionId, band);
    return band;
  }

  reset(sessionId: string): void {
    this.claimedBand.delete(sessionId);
  }

  clear(): void {
    this.claimedBand.clear();
  }
}
