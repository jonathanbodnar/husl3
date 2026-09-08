import type { CostEvent, Usage } from "../shared/types.js";
import type { ModelPrices } from "./env.js";

export function usdFor(usage: Usage, prices: ModelPrices): number {
  const perM = 1_000_000;
  return (usage.promptHit * prices.hit + usage.promptMiss * prices.miss + usage.completion * prices.out) / perM;
}

export function costEvent(kind: CostEvent["kind"], model: string, usage: Usage, prices: ModelPrices): CostEvent {
  return { kind, model, usage, usd: round6(usdFor(usage, prices)), at: new Date().toISOString() };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    promptHit: a.promptHit + b.promptHit,
    promptMiss: a.promptMiss + b.promptMiss,
    completion: a.completion + b.completion,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  };
}

export const zeroUsage = (): Usage => ({ promptHit: 0, promptMiss: 0, completion: 0, reasoning: 0 });

function round6(n: number) { return Math.round(n * 1e6) / 1e6; }

/** In-memory daily spend guard. Resets at UTC midnight; single-instance by design. */
export class DailyBudget {
  private day = "";
  private spent = 0;
  constructor(private readonly limitUsd: number) {}
  private roll() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.spent = 0; }
  }
  add(usd: number) { this.roll(); this.spent += usd; }
  spentToday() { this.roll(); return this.spent; }
  exhausted() { this.roll(); return this.limitUsd > 0 && this.spent >= this.limitUsd; }
  get limit() { return this.limitUsd; }
}
