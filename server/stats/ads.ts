import type { AdDataset, AdRow, StatResult, StatSpec } from "../../shared/types.js";

/**
 * Aggregations over uploaded ad spend.
 *
 * Spend lives in the founder's browser (uploaded from an ad platform export), not in their database,
 * so it cannot be joined to outcomes in one SQL query. It is aggregated here instead, and a `derived`
 * stat divides one stat by another — which keeps both halves of a cost-per-payer figure visible and
 * separately checkable, rather than hiding them inside one number.
 */

const inRange = (r: AdRow, since?: string, until?: string) => (!since || r.day >= since) && (!until || r.day <= until);

function measureOf(r: AdRow, m: NonNullable<StatSpec["ads"]>["measure"]): number {
  switch (m) {
    case "spend": return r.spend;
    case "impressions": return r.impressions ?? 0;
    case "clicks": return r.clicks ?? 0;
    case "platform_conversions": return r.platformConversions ?? 0;
  }
}

export function runAdStat(spec: StatSpec, ads: AdDataset | null | undefined, computedAt: string): StatResult {
  const base: StatResult = { specId: spec.id, ok: true, computedAt, ms: 0 };
  const fail = (error: string): StatResult => ({ ...base, ok: false, error });
  if (!ads || !ads.rows.length) return fail("No ad spend has been uploaded yet.");
  const q = spec.ads;
  if (!q) return fail("An ads stat needs an ads block (measure, and optionally groupBy, platform, since, until).");

  const want = q.campaignContains?.trim().toLowerCase();
  const rows = ads.rows.filter((r) =>
    inRange(r, q.since, q.until) &&
    (!q.platform || r.platform.toLowerCase() === q.platform.toLowerCase()) &&
    (!want || r.campaign.toLowerCase().includes(want)));
  if (!rows.length) return fail(`No uploaded ad rows match that filter (uploaded range ${ads.firstDay}…${ads.lastDay}, platforms ${ads.platforms.join(", ")}).`);

  const notes: string[] = [];
  const covered = { from: rows[0].day, to: rows[0].day };
  for (const r of rows) { if (r.day < covered.from) covered.from = r.day; if (r.day > covered.to) covered.to = r.day; }
  notes.push(`From the uploaded ${ads.platforms.join(" + ")} export covering ${covered.from} to ${covered.to}${ads.currency ? ` in ${ads.currency}` : ""}${ads.grain === "range" ? ", where each row covers a range rather than one day" : ""}.`);
  if (!ads.currency && q.measure === "spend") notes.push("The export names no single currency, so this amount carries no currency; do not compare it with a figure in one.");
  if (q.measure === "platform_conversions") notes.push("Platform-reported conversions are the ad platform's own attribution, not the founder's data; never treat them as signups or payers.");

  const sum = (f: (r: AdRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  if (q.groupBy === "day" && ads.grain === "range") {
    return fail("This export's rows each cover a date range, not a single day, so it cannot produce a daily series. Re-export with the day breakdown (Meta: Breakdown → Time → By Day; Google Ads: Segment → Time → Day).");
  }
  if (!q.groupBy) return { ...base, value: round2(sum((r) => measureOf(r, q.measure))), n: rows.length, notes };

  const by = new Map<string, number>();
  for (const r of rows) {
    const key = q.groupBy === "campaign" ? r.campaign : q.groupBy === "platform" ? r.platform : r.day;
    by.set(key, (by.get(key) ?? 0) + measureOf(r, q.measure));
  }
  if (q.groupBy === "day") {
    const points = [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, value]) => ({ day, value: round2(value) }));
    return { ...base, points, notes };
  }
  const items = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, value]) => ({ label, value: round2(value) }));
  if (by.size > 12) notes.push(`${by.size} ${q.groupBy}s in the export; the 12 largest are shown.`);
  return { ...base, items, notes };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A ratio of two other stats. Runs after them, so it sees their results. */
export function runDerivedStat(spec: StatSpec, results: Record<string, StatResult>, specs: StatSpec[], computedAt: string): StatResult {
  const base: StatResult = { specId: spec.id, ok: true, computedAt, ms: 0 };
  const fail = (error: string): StatResult => ({ ...base, ok: false, error });
  const d = spec.derived;
  if (!d) return fail("A derived stat needs numeratorStatId and denominatorStatId.");
  const num = results[d.numeratorStatId];
  const den = results[d.denominatorStatId];
  const numSpec = specs.find((s) => s.id === d.numeratorStatId);
  const denSpec = specs.find((s) => s.id === d.denominatorStatId);
  if (!numSpec || !denSpec) return fail("A derived stat must reference two stats that exist on this scoreboard.");
  if (!num?.ok || typeof num.value !== "number") return fail(`${numSpec.title} has no single value to divide (${num?.error ?? "not computed"}).`);
  if (!den?.ok || typeof den.value !== "number") return fail(`${denSpec.title} has no single value to divide by (${den?.error ?? "not computed"}).`);
  if (den.value === 0) return fail(`${denSpec.title} is zero, so the ratio is undefined. Say so rather than showing a number.`);

  const notes = [`${numSpec.title} ÷ ${denSpec.title}: ${num.value} ÷ ${den.value}. Both are on this board and can be checked separately.`];
  // "Below 10 show counts": at three payers one more moves a cost-per-payer figure by a quarter.
  const smallN = den.value < 10;
  if (smallN) notes.push(`Only ${den.value} in the denominator: too few to quote as a per-unit figure. Give the two counts instead — ${num.value} over ${den.value}.`);
  if (denSpec.kind === "ads" && denSpec.ads?.measure === "platform_conversions") {
    return fail("The denominator is the ad platform's own conversion count, which is its own attribution and is not a signup, an activation or a payer. Divide by an outcome from the founder's database instead.");
  }
  // A spend total that does not cover the same period as the outcome makes the ratio meaningless; say when we cannot tell.
  if (numSpec.kind === "ads" && denSpec.kind !== "ads" && !numSpec.ads?.since) notes.push("The spend covers the whole uploaded export while the denominator may cover a different period; match the ranges before trusting the ratio.");
  return { ...base, value: round2(num.value / den.value), n: den.value, smallN, notes };
}
