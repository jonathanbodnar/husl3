import type { StatResult } from "./types.js";

export interface Leak {
  /** Index of the step people leave FROM. */
  from: number;
  fromStep: string;
  toStep: string;
  /** Share lost between the two steps, 0–1, when the counts allow quoting it. */
  lost?: number;
  /** People lost, as a count — always available. */
  lostCount: number;
  /** True when the step counts are too small for the share to be honest. */
  smallN: boolean;
}

/** The leaks between consecutive steps of a path funnel, biggest share first; a step whose count grew is skipped. */
export function pathLeaks(result: StatResult | undefined): Leak[] {
  const steps = result?.steps ?? [];
  const out: Leak[] = [];
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1], cur = steps[i];
    if (cur.count > prev.count) continue;
    const lostCount = prev.count - cur.count;
    out.push({ from: i - 1, fromStep: prev.step, toStep: cur.step, lost: cur.fromPrev != null ? 1 - cur.fromPrev : undefined, lostCount, smallN: !!cur.smallN || cur.fromPrev == null });
  }
  return out.sort((a, b) => (b.lost ?? -1) - (a.lost ?? -1) || b.lostCount - a.lostCount);
}

export const pct0 = (v: number) => `${Math.round(v * 100)}%`;
