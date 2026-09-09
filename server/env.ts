import fs from "node:fs";
import path from "node:path";

// Minimal .env loader (no dependency). Real deployments set variables in the platform.
(function loadDotEnv() {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
})();

const str = (k: string, d = "") => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== "" ? v : d;
};
const onoff = (k: string, d: "on" | "off"): "on" | "off" => {
  const v = str(k).toLowerCase();
  return v === "on" || v === "true" || v === "1" ? "on" : v === "off" || v === "false" || v === "0" ? "off" : d;
};

export interface ModelPrices { hit: number; miss: number; out: number }
export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseURL: string;
  model: string;
  thinking: "on" | "off";
  /** Max reasoning tokens when thinking is on (0 = provider default). Honored by Model Studio (thinking_budget). */
  thinkingBudget: number;
  jsonMode: boolean;
  prices: ModelPrices; // USD per million tokens
}

export const env = {
  port: num("PORT", 8787),
  chat: (): ProviderConfig => ({
    name: "chat",
    apiKey: str("DEEPSEEK_API_KEY") || str("CHAT_API_KEY"),
    baseURL: str("CHAT_BASE_URL", "https://api.deepseek.com/v1"),
    model: str("CHAT_MODEL", "deepseek-v4-pro"),
    thinking: onoff("CHAT_THINKING", "off"),
    thinkingBudget: num("CHAT_THINKING_BUDGET", 0),
    jsonMode: false,
    prices: { hit: num("CHAT_PRICE_HIT", 0.044), miss: num("CHAT_PRICE_MISS", 1.32), out: num("CHAT_PRICE_OUT", 3.96) },
  }),
  prompts: (): ProviderConfig => ({
    name: "prompts",
    apiKey: str("DASHSCOPE_API_KEY") || str("PROMPT_API_KEY"),
    baseURL: str("PROMPT_BASE_URL", "https://dashscope-us.aliyuncs.com/compatible-mode/v1"),
    model: str("PROMPT_MODEL", "qwen3.8-max-0902"),
    thinking: onoff("PROMPT_THINKING", "off"),
    thinkingBudget: num("PROMPT_THINKING_BUDGET", 0),
    jsonMode: onoff("PROMPT_JSON_MODE", "on") === "on",
    prices: { hit: num("PROMPT_PRICE_CACHED", 0.25), miss: num("PROMPT_PRICE_IN", 2.0), out: num("PROMPT_PRICE_OUT", 6.0) },
  }),
  accessCode: str("ACCESS_CODE"),
  dailyBudgetUsd: num("DAILY_BUDGET_USD", 10),
  rate: {
    chat: num("RATE_CHAT_PER_HOUR", 60),
    scan: num("RATE_SCAN_PER_HOUR", 20),
    prompts: num("RATE_PROMPTS_PER_HOUR", 10),
  },
  /** Ceiling across everyone. Per-IP limits rest on X-Forwarded-For, which only a proxy makes
   *  trustworthy; these bound total abuse even if that assumption is wrong. 0 disables. */
  rateGlobal: {
    chat: num("RATE_GLOBAL_CHAT_PER_HOUR", 600),
    scan: num("RATE_GLOBAL_SCAN_PER_HOUR", 300),
    prompts: num("RATE_GLOBAL_PROMPTS_PER_HOUR", 120),
  },
  maxToolRounds: num("MAX_TOOL_ROUNDS", 8),
  /** Verify TLS certificates on founder Postgres connections. Off by default: managed providers
   *  (Supabase pooler, Neon, RDS) present certificates this client has no root for. */
  dbStrictTls: onoff("DB_STRICT_TLS", "off") === "on",
  /** Allow a connection string that resolves to a private address (local development only). */
  allowPrivateDbHosts: onoff("ALLOW_PRIVATE_DB_HOSTS", "off") === "on",
  /** Number of proxies in front of this server. The client IP is taken that many hops from the right
   *  of X-Forwarded-For, so a header a visitor sends themselves cannot become their rate-limit key. */
  trustProxyHops: num("TRUST_PROXY_HOPS", 1),
  /** Public origin for OAuth callbacks; derived from the request when unset. */
  appOrigin: str("APP_ORIGIN"),
  github: {
    clientId: str("GITHUB_CLIENT_ID"),
    clientSecret: str("GITHUB_CLIENT_SECRET"),
    oauthBase: str("GITHUB_OAUTH_BASE", "https://github.com"),
    apiBase: str("GITHUB_API_BASE", "https://api.github.com"),
  },
  supabase: {
    clientId: str("SUPABASE_OAUTH_CLIENT_ID"),
    clientSecret: str("SUPABASE_OAUTH_CLIENT_SECRET"),
    apiBase: str("SUPABASE_API_BASE", "https://api.supabase.com"),
  },
};
