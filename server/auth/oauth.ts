import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { OAuthRelay } from "../../shared/types.js";
import { env } from "../env.js";
import { getUser } from "../github/client.js";

/**
 * OAuth broker. The server only exchanges the code for a token (it holds the client secret);
 * the token is handed to the founder's browser through the relay page and never stored here.
 */
export const auth = new Hono();

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const nonce = () => b64url(randomBytes(24));

export function originOf(c: { req: { header: (k: string) => string | undefined; url: string } }): string {
  if (env.appOrigin) return env.appOrigin.replace(/\/$/, "");
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  const proto = c.req.header("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${proto}://${host}`;
}

const cookieOpts = (origin: string) => ({ httpOnly: true, secure: origin.startsWith("https"), sameSite: "Lax" as const, path: "/api/auth", maxAge: 600 });

function relay(origin: string, payload: OAuthRelay): Response {
  const json = JSON.stringify(payload).replace(/</g, "\\u003c");
  const html = `<!doctype html><meta charset="utf-8"><title>${payload.ok ? "Connected" : "Could not connect"}</title>
<style>body{font:15px system-ui,sans-serif;color:#161c19;background:#f5f7f4;display:grid;place-items:center;height:100vh;margin:0}p{max-width:36ch;text-align:center;line-height:1.5}</style>
<p>${payload.ok ? "Connected. You can close this window." : `Could not connect: ${escapeHtml(payload.error)}`}</p>
<script>(function(){var p=${json};var o=${JSON.stringify(origin)};
try{if(window.opener&&!window.opener.closed){window.opener.postMessage(p,o);setTimeout(function(){window.close()},150);return;}}catch(e){}
try{sessionStorage.setItem("vd.oauth."+p.provider,JSON.stringify(p));}catch(e){}
location.replace(o+"/");})();</script>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── GitHub (OAuth App; scope "repo" so private repositories can be read) ────
auth.get("/github/start", (c) => {
  if (!env.github.clientId || !env.github.clientSecret) return c.json({ error: "GitHub OAuth is not configured on this server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET)." }, 503);
  const origin = originOf(c);
  const state = nonce();
  setCookie(c, "vd_gh_state", state, cookieOpts(origin));
  const u = new URL(`${env.github.oauthBase.replace(/\/$/, "")}/login/oauth/authorize`);
  u.searchParams.set("client_id", env.github.clientId);
  u.searchParams.set("redirect_uri", `${origin}/api/auth/github/callback`);
  u.searchParams.set("scope", "repo");
  u.searchParams.set("state", state);
  return c.redirect(u.toString(), 302);
});

auth.get("/github/callback", async (c) => {
  const origin = originOf(c);
  const expected = getCookie(c, "vd_gh_state");
  deleteCookie(c, "vd_gh_state", { path: "/api/auth" });
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (c.req.query("error")) return relay(origin, { type: "vd:oauth", provider: "github", ok: false, error: c.req.query("error_description") ?? c.req.query("error")! });
  if (!code || !state || !expected || state !== expected) return relay(origin, { type: "vd:oauth", provider: "github", ok: false, error: "The sign-in state did not match; try again." });
  try {
    const res = await fetch(`${env.github.oauthBase.replace(/\/$/, "")}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "VibeDistributionAudit/0.1" },
      body: JSON.stringify({ client_id: env.github.clientId, client_secret: env.github.clientSecret, code, redirect_uri: `${origin}/api/auth/github/callback` }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.error ?? `GitHub token exchange failed (HTTP ${res.status})`);
    const user = await getUser(data.access_token);
    return relay(origin, { type: "vd:oauth", provider: "github", ok: true, github: { token: data.access_token, login: user.login } });
  } catch (e) {
    return relay(origin, { type: "vd:oauth", provider: "github", ok: false, error: msg(e) });
  }
});

// ── Supabase (OAuth app registered in the organization; PKCE + Basic auth exchange) ──
const sbBase = () => env.supabase.apiBase.replace(/\/$/, "");
const sbBasic = () => `Basic ${Buffer.from(`${env.supabase.clientId}:${env.supabase.clientSecret}`).toString("base64")}`;

interface SbTokens { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; error?: string; error_description?: string; message?: string }

async function sbToken(form: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const res = await fetch(`${sbBase()}/v1/oauth/token`, {
    method: "POST",
    headers: { authorization: sbBasic(), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => ({}))) as SbTokens;
  if (!res.ok || !data.access_token) throw new Error(data.error_description ?? data.message ?? data.error ?? `Supabase token exchange failed (HTTP ${res.status})`);
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined };
}

auth.get("/supabase/start", (c) => {
  if (!env.supabase.clientId || !env.supabase.clientSecret) return c.json({ error: "Supabase OAuth is not configured on this server (SUPABASE_OAUTH_CLIENT_ID / SUPABASE_OAUTH_CLIENT_SECRET)." }, 503);
  const origin = originOf(c);
  const state = nonce();
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  setCookie(c, "vd_sb_state", `${state}.${verifier}`, cookieOpts(origin));
  const u = new URL(`${sbBase()}/v1/oauth/authorize`);
  u.searchParams.set("client_id", env.supabase.clientId);
  u.searchParams.set("redirect_uri", `${origin}/api/auth/supabase/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return c.redirect(u.toString(), 302);
});

auth.get("/supabase/callback", async (c) => {
  const origin = originOf(c);
  const cookie = getCookie(c, "vd_sb_state") ?? "";
  deleteCookie(c, "vd_sb_state", { path: "/api/auth" });
  const [expected, verifier] = cookie.split(".");
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (c.req.query("error")) return relay(origin, { type: "vd:oauth", provider: "supabase", ok: false, error: c.req.query("error_description") ?? c.req.query("error")! });
  if (!code || !state || !expected || !verifier || state !== expected) return relay(origin, { type: "vd:oauth", provider: "supabase", ok: false, error: "The sign-in state did not match; try again." });
  try {
    const tokens = await sbToken({ grant_type: "authorization_code", code, redirect_uri: `${origin}/api/auth/supabase/callback`, code_verifier: verifier });
    return relay(origin, { type: "vd:oauth", provider: "supabase", ok: true, supabase: tokens });
  } catch (e) {
    return relay(origin, { type: "vd:oauth", provider: "supabase", ok: false, error: msg(e) });
  }
});

auth.post("/supabase/refresh", async (c) => {
  if (!env.supabase.clientId) return c.json({ error: "Supabase OAuth is not configured" }, 503);
  const { refreshToken } = (await c.req.json().catch(() => ({}))) as { refreshToken?: string };
  if (!refreshToken) return c.json({ error: "refreshToken is required" }, 400);
  try { return c.json(await sbToken({ grant_type: "refresh_token", refresh_token: refreshToken })); } catch (e) { return c.json({ error: msg(e) }, 401); }
});
