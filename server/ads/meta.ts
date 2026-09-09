import type { AdDataset, AdRow } from "../../shared/types.js";
import { env } from "../env.js";

/**
 * Reads spend straight from Meta's Marketing API using a token the FOUNDER minted in their own
 * business, against their own app.
 *
 * This app registers no Meta app of its own, and that is deliberate rather than lazy: serving other
 * people's ad accounts from one app requires Advanced Access to ads_read, which means Business
 * Verification and per-permission App Review. A founder reading their own ad account has no such
 * problem — Meta grants Standard Access automatically to someone who holds a role on both the app and
 * the ad account — so the token they can mint in two minutes does what an approved app would do here.
 *
 * The token arrives per request from the founder's browser and is never written down on this side.
 */

interface GraphError { error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_user_msg?: string } }

async function graph<T>(path: string, token: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${env.metaGraphBase.replace(/\/$/, "")}/${env.metaGraphVersion}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return graphUrl<T>(url.toString(), token);
}

async function graphUrl<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(45_000) });
  const text = await res.text();
  let body: (T & GraphError) | undefined;
  try { body = JSON.parse(text) as T & GraphError; } catch { /* handled below */ }
  if (!res.ok || body?.error) {
    const e = body?.error;
    const msg = e?.error_user_msg || e?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    if (e?.code === 190) throw new Error(`Meta rejected the token: ${msg}. A user token from the Graph API Explorer expires within a couple of hours — mint a system user token instead if you want it to keep working.`);
    if (e?.code === 17 || e?.code === 4 || e?.code === 613) throw new Error(`Meta is rate-limiting this ad account: ${msg}. Wait a few minutes, or ask for a shorter date range.`);
    if (e?.code === 100 && /(\(#100\)|nonexisting field|Unsupported get request)/i.test(msg)) throw new Error(`Meta could not read that ad account: ${msg}. Check the account id, and that the token's user or system user has access to it.`);
    if (e?.code === 200 || e?.code === 10) throw new Error(`The token lacks permission for this: ${msg}. It needs ads_read on an ad account the token's user can see.`);
    throw new Error(`Meta: ${msg}`);
  }
  if (!body) throw new Error("Meta returned a response that was not JSON.");
  return body;
}

export interface MetaAdAccount { id: string; accountId: string; name: string; currency?: string; timezone?: string; disabled?: boolean }

/** The ad accounts this token can see, so the founder picks one instead of hunting for an act_ id. */
export async function metaAdAccounts(token: string): Promise<MetaAdAccount[]> {
  const data = await graph<{ data: { id: string; account_id: string; name: string; currency?: string; timezone_name?: string; account_status?: number }[] }>(
    "/me/adaccounts", token, { fields: "id,account_id,name,currency,timezone_name,account_status", limit: "200" },
  );
  return (data.data ?? []).map((a) => ({
    id: a.id,
    accountId: a.account_id,
    name: a.name || a.id,
    currency: a.currency,
    timezone: a.timezone_name,
    // 1 is ACTIVE; anything else still reports history, so it is shown, just marked.
    disabled: a.account_status != null && a.account_status !== 1,
  }));
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
};

interface InsightRow {
  campaign_id?: string; campaign_name?: string; spend?: string; impressions?: string;
  clicks?: string; inline_link_clicks?: string; date_start?: string; account_currency?: string;
}

/** One campaign-day of spend per row, straight from the account that owns it. */
export async function metaInsights(token: string, adAccountId: string, since: string, until: string): Promise<AdDataset> {
  const act = /^act_/.test(adAccountId) ? adAccountId : `act_${adAccountId.replace(/^act_/, "")}`;
  if (!/^act_\d+$/.test(act)) throw new Error(`"${adAccountId}" is not an ad account id. It looks like act_1234567890, and the picker above fills it in for you.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new Error("Give the date range as YYYY-MM-DD.");
  if (since > until) throw new Error("The start date is after the end date.");

  const rows: AdRow[] = [];
  const currencies = new Set<string>();
  let url: string | null = null;
  let pages = 0;
  for (;;) {
    const page: { data?: InsightRow[]; paging?: { next?: string } } = url
      ? await graphUrl(url, token)
      : await graph("/" + act + "/insights", token, {
          level: "campaign",
          time_increment: "1",
          time_range: JSON.stringify({ since, until }),
          fields: "campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,account_currency",
          limit: "500",
        });
    for (const r of page.data ?? []) {
      const spend = num(r.spend);
      if (spend == null || !r.date_start) continue;
      if (r.account_currency) currencies.add(r.account_currency);
      const row: AdRow = { platform: "Meta", campaign: r.campaign_name || r.campaign_id || "(unnamed campaign)", day: r.date_start, spend: Math.round(spend * 100) / 100 };
      if (r.campaign_id) row.campaignId = r.campaign_id;
      const impressions = num(r.impressions);
      const clicks = num(r.inline_link_clicks) ?? num(r.clicks);
      if (impressions != null) row.impressions = impressions;
      if (clicks != null) row.clicks = clicks;
      rows.push(row);
    }
    url = page.paging?.next ?? null;
    if (!url || ++pages >= 20) break;
  }

  if (!rows.length) throw new Error(`Meta returned no spend for ${act} between ${since} and ${until}. Check the dates, and that this account ran ads in that window.`);

  const notes: string[] = [
    `Read live from Meta's Marketing API for ${act} between ${since} and ${until}, one row per campaign per day.`,
    "Days follow the ad account's own timezone, which Meta fixes when the account is created and which may differ from the reporting timezone on the scoreboard.",
  ];
  if (pages >= 20) notes.push("Only the first 20 pages were read; ask for a shorter date range to see all of it.");
  if (currencies.size > 1) notes.push(`This account reported more than one currency (${[...currencies].join(", ")}); amounts must not be added together.`);

  const days = rows.map((r) => r.day).sort();
  return {
    rows,
    currency: currencies.size === 1 ? [...currencies][0] : "",
    source: `Meta Marketing API · ${act}`,
    uploadedAt: new Date().toISOString(),
    platforms: ["Meta"],
    firstDay: days[0],
    lastDay: days[days.length - 1],
    totalSpend: Math.round(rows.reduce((a, r) => a + r.spend, 0) * 100) / 100,
    grain: "day",
    notes,
  };
}
