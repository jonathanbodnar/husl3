import dns from "node:dns/promises";
import net from "node:net";

/** Reject hosts that resolve to private, loopback, link-local or special ranges (SSRF guard). */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Refusing to fetch ${hostname}: not a public host`);
  }
  const addrs: string[] = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`Could not resolve ${hostname}`);
  for (const ip of addrs) if (isPrivateIp(ip)) throw new Error(`Refusing to fetch ${hostname}: resolves to a non-public address`);
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::") return true;
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10
  return false;
}

export interface SafeFetchResult { status: number; headers: Headers; text: string; finalUrl: string; bytes: number; truncated: boolean }

const UA = "Mozilla/5.0 (compatible; VibeDistributionAudit/0.1; +https://github.com/jonathanbodnar/husl3)";

/** Fetch a public URL with a timeout, a byte cap, and redirect re-validation. */
export async function safeFetch(input: string, opts: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string>; method?: string } = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  let url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http(s) URLs can be fetched");
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicHost(url.hostname);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.8", ...opts.headers },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0; let truncated = false;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytes += value.byteLength;
            if (bytes > maxBytes) { truncated = true; chunks.push(value.subarray(0, Math.max(0, maxBytes - (bytes - value.byteLength)))); await reader.cancel().catch(() => {}); break; }
            chunks.push(value);
          }
        }
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
      return { status: res.status, headers: res.headers, text, finalUrl: url.toString(), bytes, truncated };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("Too many redirects");
}
