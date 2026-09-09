import * as cheerio from "cheerio";
import type { SiteDigest, SiteForm, SitePage } from "../../shared/types.js";
import { safeFetch } from "../net.js";

const CTA_RE = /\b(sign ?up|get started|start( for)? free|start now|try( it)?( free| now)?|free trial|book a demo|request( a)? demo|see pricing|pricing|plans|log ?in|sign ?in|subscribe|buy now|upgrade|join|register|create( an| your)? account|download|install|checkout|contact sales|talk to us|start building|get access|claim)\b/i;

const PRICE_RE = /(?:US)?[$€£]\s?\d{1,5}(?:[.,]\d{1,2})?(?:\s?(?:\/|per)\s?(?:mo(?:nth)?|yr|year|user|seat|month|annual|wk|week|day|credit|1000|k))?|\b\d{1,5}(?:[.,]\d{1,2})?\s?(?:USD|EUR|GBP)\b(?:\s?(?:\/|per)\s?(?:mo(?:nth)?|yr|year|user|seat))?/gi;

const KIND_SCORES: [RegExp, SitePage["kind"], number][] = [
  [/\/(pricing|plans?|price|subscribe|upgrade)(\/|$|\?|#)/i, "pricing", 10],
  [/\/(sign-?up|register|get-?started|start|join|create-?account|onboard)(\/|$|\?|#)/i, "signup", 9],
  [/\/(checkout|billing|pay(ment)?)(\/|$|\?|#)/i, "checkout", 8],
  [/\/(features?|product|how-it-works|solutions?|use-?cases?|platform)(\/|$|\?|#)/i, "features", 6],
  [/\/(demo|book|schedule)(\/|$|\?|#)/i, "demo", 5],
  [/\/(log-?in|sign-?in|auth)(\/|$|\?|#)/i, "login", 5],
  [/\/(docs?|documentation|help|guides?|getting-?started)(\/|$|\?|#)/i, "docs", 4],
  [/\/(faqs?)(\/|$|\?|#)/i, "faq", 4],
  [/\/(about|team|company|story)(\/|$|\?|#)/i, "about", 3],
];

const STACK_MARKERS: [RegExp, string][] = [
  [/js\.stripe\.com|stripe\.com\/v3|data-stripe|checkout\.stripe\.com/i, "Stripe"],
  [/paddle\.com\/paddle|cdn\.paddle\.com/i, "Paddle"],
  [/lemonsqueezy\.com/i, "Lemon Squeezy"],
  [/chargebee|recurly|paypal\.com\/sdk|polar\.sh|dodopayments/i, "other payment SDK"],
  [/supabase\.co|supabase\.com/i, "Supabase"],
  [/firebaseapp|firebase(js)?\.com|__firebase/i, "Firebase"],
  [/clerk\.(com|dev|accounts)|__clerk/i, "Clerk"],
  [/auth0\.com/i, "Auth0"],
  [/posthog\.com|posthog\.init|\bposthog\b/i, "PostHog"],
  [/googletagmanager\.com|gtag\(|google-analytics\.com/i, "Google Analytics / Tag Manager"],
  [/segment\.(com|io)|analytics\.js/i, "Segment"],
  [/mixpanel/i, "Mixpanel"],
  [/plausible\.io/i, "Plausible"],
  [/usefathom|fathom\.js/i, "Fathom"],
  [/hotjar/i, "Hotjar"],
  [/intercom(cdn)?\.(io|com)|intercomSettings/i, "Intercom"],
  [/crisp\.chat/i, "Crisp"],
  [/tawk\.to/i, "Tawk"],
  [/connect\.facebook\.net|fbq\(/i, "Meta Pixel"],
  [/static\.ads-twitter|twq\(/i, "X (Twitter) pixel"],
  [/snap\.licdn|linkedin\.com\/insight/i, "LinkedIn Insight"],
  [/tiktok\.com\/i18n\/pixel|ttq\./i, "TikTok pixel"],
  [/rewardful|firstpromoter|partnerstack|tolt\.io|getrewardful/i, "affiliate/referral platform"],
  [/_next\/static|__NEXT_DATA__|next\/dist/i, "Next.js"],
  [/\/_nuxt\//i, "Nuxt"],
  [/__remixContext/i, "Remix"],
  [/data-sveltekit|__sveltekit/i, "SvelteKit"],
  [/\/_astro\//i, "Astro"],
  [/wp-content|wp-includes/i, "WordPress"],
  [/webflow\.com|data-wf-page/i, "Webflow"],
  [/framerusercontent|framer\.com/i, "Framer"],
  [/static\.wixstatic|wix\.com/i, "Wix"],
  [/squarespace/i, "Squarespace"],
  [/cdn\.shopify\.com|Shopify\./i, "Shopify"],
  [/tailwindcss|class="[^"]*\b(flex|grid|px-\d|py-\d|text-(sm|lg|xl))\b/i, "Tailwind CSS"],
  [/onesignal/i, "OneSignal"],
  [/sentry(-cdn)?\.io|browser\.sentry/i, "Sentry"],
  [/vercel\.(app|live|com)\/|\/_vercel\//i, "Vercel"],
  [/cloudflareinsights|cdn-cgi\/|cf-ray/i, "Cloudflare"],
];

function clean(t: string): string { return t.replace(/\s+/g, " ").trim(); }

export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const url = new URL(u);
  url.hash = "";
  return url.toString();
}

function kindFor(url: string, isHome: boolean): { kind: SitePage["kind"]; score: number } {
  if (isHome) return { kind: "home", score: 100 };
  for (const [re, kind, score] of KIND_SCORES) if (re.test(url)) return { kind, score };
  return { kind: "other", score: 1 };
}

export function parsePage(html: string, url: string, status: number, headers: Headers | null, isHome: boolean): { page: SitePage; links: string[]; stack: string[] } {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, template, iframe").remove();
  const title = clean($("title").first().text() || $('meta[property="og:title"]').attr("content") || "");
  const description = clean($('meta[name="description"]').attr("content") || $('meta[property="og:description"]').attr("content") || "") || undefined;
  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => { const t = clean($(el).text()); if (t && t.length < 160 && !headings.includes(t)) headings.push(t); });
  const ctas: string[] = [];
  $("a, button, input[type=submit]").each((_, el) => {
    const $el = $(el);
    const t = clean($el.text() || $el.attr("value") || $el.attr("aria-label") || "");
    if (!t || t.length > 60 || !CTA_RE.test(t)) return;
    const href = $el.attr("href");
    const label = href && !href.startsWith("#") && !href.startsWith("javascript") ? `${t} → ${safeResolve(href, url)}` : t;
    if (!ctas.includes(label)) ctas.push(label);
  });
  const bodyText = clean($("body").text() || "");
  const prices: string[] = [];
  const seenPrices = new Set<string>();
  for (const m of bodyText.matchAll(PRICE_RE)) {
    const i = m.index ?? 0;
    const ctx = clean(bodyText.slice(Math.max(0, i - 50), Math.min(bodyText.length, i + m[0].length + 40)));
    // Dedupe on the matched amount, not on the surrounding context (which made every later tier look seen).
    if (!seenPrices.has(m[0])) { seenPrices.add(m[0]); prices.push(ctx); }
    if (prices.length >= 16) break;
  }
  const forms: SiteForm[] = [];
  $("form").each((_, el) => {
    const $f = $(el);
    const fields: string[] = [];
    $f.find("input, select, textarea").each((__, inp) => {
      const $i = $(inp);
      const type = ($i.attr("type") || inp.tagName).toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button") return;
      const name = $i.attr("name") || $i.attr("id") || $i.attr("placeholder") || $i.attr("aria-label") || type;
      fields.push(`${name}${type !== "text" && type !== "input" ? `:${type}` : ""}`);
    });
    if (fields.length || $f.attr("action")) forms.push({ action: $f.attr("action") ? safeResolve($f.attr("action")!, url) : undefined, method: $f.attr("method")?.toUpperCase(), fields: fields.slice(0, 12) });
  });
  const links: string[] = [];
  const origin = new URL(url).origin;
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href")!;
    const abs = safeResolve(href, url);
    // Compare origins, never string prefixes: "https://example.com.evil.com" starts with the origin.
    let sameOrigin = false;
    try { sameOrigin = new URL(abs).origin === origin; } catch { sameOrigin = false; }
    if (sameOrigin && !/\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|css|js|ico)(\?|$)/i.test(abs)) links.push(abs.replace(/#.*$/, ""));
  });
  const stack = new Set<string>();
  const headerPairs: string[] = [];
  headers?.forEach((v, k) => headerPairs.push(`${k}: ${v}`));
  const headerBlob = headerPairs.join("\n");
  for (const [re, name] of STACK_MARKERS) if (re.test(html) || re.test(headerBlob)) stack.add(name);
  if (headers?.get("x-vercel-id")) stack.add("Vercel");
  if (headers?.get("cf-ray")) stack.add("Cloudflare");
  if (/x-powered-by: express/i.test(headerBlob)) stack.add("Express");
  const { kind } = kindFor(url, isHome);
  return {
    page: { url, status, title, description, headings: headings.slice(0, 40), ctas: ctas.slice(0, 30), prices, forms: forms.slice(0, 8), text: bodyText.slice(0, 6000), kind },
    links: [...new Set(links)],
    stack: [...stack],
  };
}

function safeResolve(href: string, base: string): string { try { return new URL(href, base).toString(); } catch { return href; } }

export async function scanSite(input: string, log: (m: string) => void = () => {}): Promise<SiteDigest> {
  let url = normalizeUrl(input);
  let home;
  try {
    home = await safeFetch(url, { timeoutMs: 15_000 });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (!/Could not resolve/i.test(m)) throw err;
    // Some sites only answer on www (or only on the apex); try the other form once before giving up.
    const u = new URL(url);
    const alt = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
    try {
      u.hostname = alt;
      home = await safeFetch(u.toString(), { timeoutMs: 15_000 });
      url = u.toString();
    } catch {
      throw new Error(`Could not resolve ${new URL(normalizeUrl(input)).hostname}. Check the spelling, or start the audit from your repository instead.`);
    }
  }
  if (home.status >= 400) throw new Error(`${new URL(url).hostname} answered HTTP ${home.status}. If the page is behind a login or a bot check, start the audit from your repository instead.`);
  if (!home.text.trim()) throw new Error(`${new URL(url).hostname} answered ${home.status} with an empty page, so there is nothing to read. If the site renders entirely in the browser, start from your repository instead.`);
  const finalUrl = home.finalUrl;
  const origin = new URL(finalUrl).origin;
  const parsedHome = parsePage(home.text, finalUrl, home.status, home.headers, true);
  log(`home: ${parsedHome.page.title}`);

  // Candidate pages: linked paths scored by kind, plus the usual suspects even when unlinked.
  const scored = new Map<string, number>();
  for (const l of parsedHome.links) { const { score, kind } = kindFor(l, false); if (kind !== "other") scored.set(l, Math.max(scored.get(l) ?? 0, score)); }
  for (const guess of ["/pricing", "/signup", "/login", "/features", "/docs"]) { const g = origin + guess; if (!scored.has(g)) scored.set(g, kindFor(g, false).score - 0.5); }
  const seenKinds = new Set<string>(["home"]);
  const picks: string[] = [];
  for (const [l] of [...scored.entries()].sort((a, b) => b[1] - a[1])) {
    if (l.replace(/\/$/, "") === finalUrl.replace(/\/$/, "")) continue;
    const k = kindFor(l, false).kind;
    if (seenKinds.has(k) && k !== "other") continue;
    seenKinds.add(k);
    picks.push(l);
    if (picks.length >= 6) break;
  }
  const pages: SitePage[] = [parsedHome.page];
  const stack = new Set<string>(parsedHome.stack);
  const results = await Promise.allSettled(picks.map(async (l) => {
    const r = await safeFetch(l, { timeoutMs: 10_000, maxBytes: 1_000_000 });
    if (r.status >= 400 || !r.text || !/<html|<body|<div|<main/i.test(r.text.slice(0, 5000))) return null;
    const p = parsePage(r.text, r.finalUrl, r.status, r.headers, false);
    if (p.page.text.length < 120) return null;
    return p;
  }));
  for (const r of results) if (r.status === "fulfilled" && r.value) { pages.push(r.value.page); for (const s of r.value.stack) stack.add(s); }
  // Dedupe pages that redirected to the same place.
  const uniq = new Map<string, SitePage>();
  for (const p of pages) if (!uniq.has(p.url.replace(/\/$/, ""))) uniq.set(p.url.replace(/\/$/, ""), p);
  const finalPages = [...uniq.values()];

  const notes: string[] = [];
  if (!finalPages.some((p) => p.kind === "pricing") && !finalPages.some((p) => p.prices.length)) notes.push("No pricing page and no prices found on the scanned pages.");
  if (!parsedHome.page.headings.length) notes.push("Home page has no h1/h2 text the scanner could read (may be rendered client-side).");
  if (!parsedHome.page.ctas.length) notes.push("No sign-up/get-started style call to action found on the home page.");
  const signup = finalPages.find((p) => p.kind === "signup");
  if (signup?.forms.length) notes.push(`Signup form asks for ${signup.forms[0].fields.length} field(s): ${signup.forms[0].fields.join(", ")}.`);
  if (home.truncated) notes.push("Home page HTML exceeded the scan cap and was truncated.");
  if (parsedHome.page.text.length < 400) notes.push("Very little server-rendered text on the home page; the product may be a client-rendered app behind login.");

  return {
    url: finalUrl,
    origin,
    domain: new URL(finalUrl).hostname.replace(/^www\./, ""),
    scannedAt: new Date().toISOString(),
    pages: finalPages,
    stack: [...stack].sort(),
    notes,
  };
}

/** Tool: fetch one page and return a compact reading. */
export async function fetchPageForTool(url: string, siteOrigin: string): Promise<{ page: SitePage; sameSite: boolean }> {
  const norm = normalizeUrl(url);
  const r = await safeFetch(norm, { timeoutMs: 12_000, maxBytes: 1_200_000 });
  const isHome = new URL(norm).pathname === "/" && new URL(norm).origin === siteOrigin;
  const p = parsePage(r.text || "", r.finalUrl, r.status, r.headers, isHome);
  return { page: p.page, sameSite: new URL(r.finalUrl).origin === siteOrigin };
}
