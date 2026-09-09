import type { AdDataset, AdRow } from "../../shared/types.js";

/**
 * Parses an ad platform's own export into campaign-day spend.
 *
 * The founder downloads a report from Ads Manager or Google Ads and drops the file in. That path needs
 * no app registered with anyone, no API access review, and no credential: it is the same data the
 * platform would return over its API, exported by the person who owns it.
 *
 * Real exports are not clean CSV. Google Ads puts the report name and the date range above the header
 * row and a "Total: …" row underneath; Meta names the spend column after the currency ("Amount spent
 * (USD)"); numbers arrive quoted with thousands separators and currency symbols; dates arrive in three
 * or four formats. Everything the parser cannot use is reported in notes rather than dropped in silence.
 */

const MAX_ROWS = 5000;

// ── column aliases (lowercased, punctuation-stripped) ────────────────────────
const CAMPAIGN = ["campaign name", "campaign", "ad set name", "adset name", "ad group", "ad group name", "campaign campaign"];
const CAMPAIGN_ID = ["campaign id", "campaign identifier", "campaignid"];
const DAY = ["day", "date", "date day", "reporting starts", "week", "month", "day of week"];
const SPEND = ["amount spent", "amount spent usd", "spend", "cost", "cost usd", "total spent", "amount", "spend usd", "money spent"];
const IMPRESSIONS = ["impressions", "impr", "impr .", "impressions total"];
const CLICKS = ["link clicks", "clicks", "clicks all", "clicks link", "outbound clicks", "unique link clicks"];
const CONVERSIONS = ["results", "conversions", "purchases", "conv", "all conv", "website purchases", "leads"];
const PLATFORM_HINT = ["platform", "publisher platform", "source", "network", "ad network type"];

const norm = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

function findColumn(headers: string[], aliases: string[]): number {
  const n = headers.map(norm);
  for (const a of aliases) { const i = n.indexOf(a); if (i >= 0) return i; }
  // A prefix match catches "Amount spent (USD)" → "amount spent", "Cost / conv." → "cost".
  for (const a of aliases) { const i = n.findIndex((h) => h === a || h.startsWith(a + " ")); if (i >= 0) return i; }
  return -1;
}

// ── CSV / TSV ────────────────────────────────────────────────────────────────
function detectDelimiter(text: string): string {
  const head = text.slice(0, 5000);
  const counts = [",", "\t", ";"].map((d) => ({ d, n: (head.match(new RegExp(`\\${d}`, "g")) ?? []).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}

/** RFC4180-ish: quoted fields, doubled quotes, embedded delimiters and newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === delimiter) { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); field = ""; rows.push(row); row = []; continue; }
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// ── values ───────────────────────────────────────────────────────────────────
const CURRENCY_SYMBOL: Record<string, string> = { "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY", "₹": "INR", "R$": "BRL", "A$": "AUD", "C$": "CAD" };

/**
 * A lone separator before three digits is genuinely ambiguous: "1.234" is 1234 in Berlin and 1.234 in
 * Boston. It cannot be settled per cell, so the caller settles it once per FILE (see detectDecimalComma)
 * and passes the answer down; otherwise a European export reads 10.000 impressions as 10.
 */
export function parseNumber(raw: string, decimalComma = false): number | null {
  let s = (raw ?? "").trim();
  if (!s || /^(--|-|n\/?a|—)$/i.test(s)) return null;
  s = s.replace(/[^\d,.\-]/g, "");
  if (!s || s === "-") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal point.
    if (lastComma > lastDot) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (decimalComma) {
    s = lastComma >= 0 ? s.replace(/\./g, "").replace(",", ".") : s.replace(/\./g, "");
  } else if (lastComma >= 0) {
    // A lone comma is a decimal separator only when it splits exactly two trailing digits.
    s = /,\d{2}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when the file writes decimals with a comma, decided from every numeric-looking cell at once. */
export function detectDecimalComma(grid: string[][]): boolean {
  let commaDecimal = 0, dotDecimal = 0;
  for (const row of grid) {
    for (const cell of row) {
      const s = (cell ?? "").trim();
      if (!/\d/.test(s) || s.length > 24) continue;
      if (/[.]\d{3}(?:[.]\d{3})*,\d+$/.test(s) || /^\D*\d+,\d{1,2}$/.test(s)) commaDecimal++;
      if (/[,]\d{3}(?:[,]\d{3})*\.\d+$/.test(s) || /^\D*\d+\.\d{1,2}$/.test(s)) dotDecimal++;
    }
  }
  return commaDecimal > dotDecimal;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, "0");

export function parseDay(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  // "Sep 1, 2026" / "1 Sep 2026"
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].slice(0, 3).toLowerCase()])}-${pad(+m[2])}`;
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].slice(0, 3).toLowerCase()])}-${pad(+m[1])}`;
  // M/D/YYYY — ambiguous with D/M/YYYY, so only accept it when the first part cannot be a month.
  m = /^(\d{1,2})[/](\d{1,2})[/](\d{4})$/.exec(s);
  if (m) { const a = +m[1], b = +m[2]; if (a > 12 && b <= 12) return `${m[3]}-${pad(b)}-${pad(a)}`; if (a <= 12) return `${m[3]}-${pad(a)}-${pad(b)}`; }
  return null;
}

function detectCurrency(headers: string[], sample: string): string {
  for (const h of headers) { const m = /\(([A-Z]{3})\)/.exec(h); if (m) return m[1]; }
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOL)) if (sample.includes(sym)) return code;
  return "";
}

function detectPlatform(text: string, headers: string[], fallback?: string): string {
  const blob = (text.slice(0, 2000) + " " + headers.join(" ")).toLowerCase();
  if (/amount spent|ad set name|facebook|instagram|meta ads/.test(blob)) return "Meta";
  if (/impr\.|google ads|ad group|conv\. rate|campaign type/.test(blob)) return "Google Ads";
  if (/linkedin/.test(blob)) return "LinkedIn";
  if (/tiktok/.test(blob)) return "TikTok";
  if (/reddit/.test(blob)) return "Reddit";
  if (/twitter|x ads/.test(blob)) return "X";
  return fallback?.trim() || "Ads";
}

export interface ParseOptions { source?: string; platform?: string }

export function parseAdExport(text: string, opts: ParseOptions = {}): AdDataset {
  if (!text || !text.trim()) throw new Error("The file is empty.");
  if (/^PK/.test(text) || text.includes("[Content_Types].xml")) {
    throw new Error("That looks like an .xlsx workbook. Export as CSV (Ads Manager: Reports → Export → CSV; Google Ads: the download icon → .csv) and try again.");
  }
  const delimiter = detectDelimiter(text);
  const grid = parseDelimited(text, delimiter).filter((r) => r.some((c) => c.trim() !== ""));
  if (!grid.length) throw new Error("No rows could be read from that file.");

  // Google Ads puts the report name and date range above the header row; find the real header.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const cells = grid[i];
    if (cells.length < 2) continue;
    if (findColumn(cells, SPEND) >= 0 && (findColumn(cells, CAMPAIGN) >= 0 || findColumn(cells, DAY) >= 0)) { headerIdx = i; break; }
  }
  if (headerIdx < 0) {
    const seen = (grid.find((r) => r.length > 1) ?? []).slice(0, 8).map((c) => c.trim()).filter(Boolean).join(", ");
    throw new Error(`No spend column was found. The export needs a cost/spend column and a campaign or date column. First row read: ${seen || "(blank)"}.`);
  }

  const headers = grid[headerIdx].map((h) => h.trim());
  const notes: string[] = [];
  if (headerIdx > 0) notes.push(`Skipped ${headerIdx} preamble row(s) above the column headers.`);

  const iCampaign = findColumn(headers, CAMPAIGN);
  const iCampaignId = findColumn(headers, CAMPAIGN_ID);
  const iDay = findColumn(headers, DAY);
  const iSpend = findColumn(headers, SPEND);
  const iImpr = findColumn(headers, IMPRESSIONS);
  const iClicks = findColumn(headers, CLICKS);
  const iConv = findColumn(headers, CONVERSIONS);
  const iPlatform = findColumn(headers, PLATFORM_HINT);

  const platform = detectPlatform(text, headers, opts.platform);
  const body = grid.slice(headerIdx + 1);
  const currency = detectCurrency(headers, body.slice(0, 20).map((r) => r[iSpend] ?? "").join(" "));
  const decimalComma = detectDecimalComma(body.slice(0, 200));
  const num = (v: string | undefined) => parseNumber(v ?? "", decimalComma);

  // A date-range in the preamble stamps rows that carry no day of their own.
  let fallbackDay: string | null = null;
  if (iDay < 0) {
    for (let i = 0; i < headerIdx; i++) {
      const line = grid[i].join(" ");
      const m = /(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})\s*[-–—to]+\s*(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})/.exec(line);
      if (m) { fallbackDay = parseDay(m[1]); if (fallbackDay) notes.push(`The export has no per-day column; every row is dated ${fallbackDay}, the first day of the report's range (${m[1]} to ${m[2]}). Totals are right; a daily trend is not available from this file.`); break; }
    }
    if (!fallbackDay) notes.push("The export has no per-day column and no date range in the file, so rows are dated by upload day. Re-export with a day breakdown for anything time-based.");
  }

  const rows: AdRow[] = [];
  let skippedNoSpend = 0, skippedNoDay = 0, totals = 0;
  for (const cells of body) {
    const first = (cells[0] ?? "").trim();
    if (/^(total|totals|grand total|—|-)\b/i.test(first) || /^total/i.test((cells[iCampaign] ?? "").trim())) { totals++; continue; }
    const spend = num(cells[iSpend]);
    if (spend == null) { if (cells.some((c) => c.trim())) skippedNoSpend++; continue; }
    const day = iDay >= 0 ? parseDay(cells[iDay] ?? "") : (fallbackDay ?? new Date().toISOString().slice(0, 10));
    if (!day) { skippedNoDay++; continue; }
    const campaign = (iCampaign >= 0 ? (cells[iCampaign] ?? "").trim() : "") || "(all campaigns)";
    const row: AdRow = { platform: (iPlatform >= 0 && cells[iPlatform]?.trim()) || platform, campaign, day, spend: Math.round(spend * 100) / 100 };
    const campaignId = iCampaignId >= 0 ? (cells[iCampaignId] ?? "").trim() : "";
    if (campaignId) row.campaignId = campaignId;
    const impressions = iImpr >= 0 ? num(cells[iImpr]) : null;
    const clicks = iClicks >= 0 ? num(cells[iClicks]) : null;
    const conv = iConv >= 0 ? num(cells[iConv]) : null;
    if (impressions != null) row.impressions = impressions;
    if (clicks != null) row.clicks = clicks;
    if (conv != null) row.platformConversions = conv;
    rows.push(row);
    if (rows.length >= MAX_ROWS) { notes.push(`Only the first ${MAX_ROWS} rows were read.`); break; }
  }

  if (!rows.length) throw new Error(`No spend rows could be read. ${skippedNoSpend} row(s) had no usable amount in the "${headers[iSpend]}" column.`);
  if (totals) notes.push(`Ignored ${totals} total row(s).`);
  if (skippedNoSpend) notes.push(`${skippedNoSpend} row(s) had no usable amount and were skipped.`);
  if (skippedNoDay) notes.push(`${skippedNoDay} row(s) had a date this parser could not read and were skipped.`);
  if (iCampaign < 0) notes.push("No campaign column: everything is grouped as one campaign, so spend cannot be split by audience.");
  if (iCampaignId < 0 && iCampaign >= 0) notes.push("No campaign ID column: spend can only be joined to accounts by campaign name, which breaks if a campaign was ever renamed. Add the campaign ID column and re-export for a durable join.");
  if (iClicks < 0 && iImpr < 0) notes.push("No clicks or impressions column: only spend is available from this export.");
  if (decimalComma) notes.push("Numbers were read with a comma decimal separator (1.234,56 = 1234.56), matching the rest of this file.");
  if (!currency) notes.push("The export does not name a currency, so amounts are shown as plain numbers; they are in whatever currency the ad account bills in.");

  const days = rows.map((r) => r.day).sort();
  const platforms = [...new Set(rows.map((r) => r.platform))];
  return {
    rows,
    currency,
    source: opts.source?.slice(0, 120) || "pasted",
    uploadedAt: new Date().toISOString(),
    platforms,
    firstDay: days[0],
    lastDay: days[days.length - 1],
    totalSpend: Math.round(rows.reduce((a, r) => a + r.spend, 0) * 100) / 100,
    notes,
  };
}
