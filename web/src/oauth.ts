import type { OAuthRelay } from "../../shared/types";

type Provider = "github" | "supabase";
type Ok<P extends Provider> = Extract<OAuthRelay, { provider: P; ok: true }>;

/**
 * Opens the broker in a popup; the callback page posts the token back and closes.
 * If the popup is blocked, the whole tab navigates and the result is picked up from sessionStorage after the redirect.
 */
export function startOAuth<P extends Provider>(provider: P): Promise<Ok<P>> {
  return new Promise((resolve, reject) => {
    const w = window.open(`/api/auth/${provider}/start`, "vd-oauth", "popup=yes,width=640,height=780");
    if (!w) { window.location.assign(`/api/auth/${provider}/start`); return; }
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; window.removeEventListener("message", onMsg); clearInterval(poll); fn(); };
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as OAuthRelay | undefined;
      if (!d || d.type !== "vd:oauth" || d.provider !== provider) return;
      finish(() => (d.ok ? resolve(d as Ok<P>) : reject(new Error(d.error))));
    };
    window.addEventListener("message", onMsg);
    const poll = setInterval(() => {
      if (w.closed) setTimeout(() => finish(() => reject(new Error("The sign-in window closed before finishing."))), 800);
    }, 500);
  });
}

/** Result left by the callback page when it could not reach an opener (popup blocked → full redirect). */
export function consumePendingOAuth<P extends Provider>(provider: P): Ok<P> | null {
  try {
    const raw = sessionStorage.getItem(`vd.oauth.${provider}`);
    if (!raw) return null;
    sessionStorage.removeItem(`vd.oauth.${provider}`);
    const d = JSON.parse(raw) as OAuthRelay;
    return d.ok && d.provider === provider ? (d as Ok<P>) : null;
  } catch { return null; }
}
