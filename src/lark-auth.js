/*
 * Lark login check for the anthropic-ce service (copied from gemini-pdf's src/lark-auth.js, with the
 * tool's name and table description as parameters instead of "Fetch" and "briefs table").
 *
 * Appraisal signs people in with Lark (OAuth 2.0 + PKCE in the browser) and sends the resulting
 * user_access_token with every brief:
 *
 *     Authorization: Bearer <user_access_token>
 *
 * A token only proves that *someone* logged in to *some* Lark app, so it isn't enough on its
 * own: a user token from another app or another company would pass a plain identity check. This
 * module therefore asks Lark two things, as that user:
 *
 *     1. GET /authen/v1/user_info          -> who it is (open_id, name)
 *     2. GET /bitable/v1/apps/{base}/tables/{table}/fields?page_size=1
 *                                          -> can they open the access table?
 *
 * Only people the access Base is shared with pass step 2, so "authorized user" means exactly
 * "someone who can open that table in Lark". Revoking someone's access to the Base locks them out
 * of the extraction service too (within the cache time below).
 *
 * Results are cached per token (by SHA-256, never the token itself) for a few minutes, so a burst
 * of appraisals costs Lark two calls, not two each. On Workers the cache is per copy of the
 * Worker, so it may cost a few more. Failures are never cached. If Lark can't be reached the
 * request is refused (fail closed).
 */

export const LARK_API = "https://open.larksuite.com/open-apis";

// Lark codes meaning the token itself is no good (expired, revoked, malformed).
const DEAD_TOKEN = new Set([20005, 99991661, 99991663, 99991668, 99991677, 99991671]);
// Codes meaning the person is logged in but can't open the access table.
const NO_ACCESS = new Set([91402, 91403, 1254302, 1254003, 1254004, 1254040, 1254041, 99991672, 99991679]);

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The token from an "Authorization: Bearer …" header, or "" if it isn't one. */
export function bearer(headerValue) {
  const value = String(headerValue || "").trim();
  if (value.slice(0, 7).toLowerCase() !== "bearer ") return "";
  const token = value.slice(7).trim();
  return token.length >= 20 && token.length <= 4096 && !token.includes(" ") ? token : "";
}

export class LarkAuth {
  /**
   * @param opts.get   (url, token) => Promise<object>: GET a Lark API URL with a user token and
   *                   return its JSON body (Lark puts errors in the body, often with a 4xx
   *                   status). Throws when Lark can't be reached.
   */
  constructor({ baseToken, tableId, required = true, ttlSeconds = 300, get, api = LARK_API, tool = "Appraisal",
    tableLabel = "the Lark table that grants access" } = {}) {
    Object.assign(this, { baseToken, tableId, required, ttlMs: ttlSeconds * 1000, api: api.replace(/\/+$/, ""), tool, tableLabel });
    this.get = get || httpGet;
    this.cache = new Map();   // sha256(token) -> { user, until }
  }

  /** Resolves {open_id, name} for a signed-in, authorized user, or throws AuthError. With login
   *  not required, resolves null for requests without a token. `get` overrides the constructor's
   *  for this call (the service passes one that counts the request's outgoing calls). */
  async verify(headerValue, get = this.get) {
    const token = bearer(headerValue);
    if (!token) {
      if (!this.required) return null;
      throw new AuthError(401, "login_required", `Log in with Lark to use ${this.tool}.`);
    }
    const key = await sha256(token);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.user;

    const user = await this.check(token, get);
    if (this.cache.size > 2000) {   // drop expired entries now and then
      for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k);
    }
    this.cache.set(key, { user, until: now + this.ttlMs });
    return user;
  }

  async call(path, token, get = this.get) {
    let data;
    try {
      data = await get(`${this.api}${path}`, token);
    } catch (_) {
      throw new AuthError(503, "auth_unavailable", `${this.tool} couldn't check your Lark login right now. Try again in a moment.`);
    }
    return data && typeof data === "object" ? data : {};
  }

  async check(token, get = this.get) {
    const info = await this.call("/authen/v1/user_info", token, get);
    let code = Number(info.code ?? -1) || 0;
    if (DEAD_TOKEN.has(code)) throw new AuthError(401, "login_expired", "Your Lark login has ended. Log in again.");
    if (code !== 0) throw new AuthError(401, "login_invalid", "Lark didn't accept your login. Log in again.");
    const d = info.data || {};
    const user = { open_id: d.open_id || d.union_id || "", name: d.name || d.en_name || "" };

    const probe = await this.call(
      `/bitable/v1/apps/${encodeURIComponent(this.baseToken)}/tables/${encodeURIComponent(this.tableId)}/fields?page_size=1`, token, get);
    code = Number(probe.code ?? -1) || 0;
    if (DEAD_TOKEN.has(code)) throw new AuthError(401, "login_expired", "Your Lark login has ended. Log in again.");
    if (NO_ACCESS.has(code)) {
      throw new AuthError(403, "not_authorized",
        `Your Lark account doesn't have access to ${this.tableLabel}. Ask the Base owner to share it with you, then log in again.`);
    }
    if (code !== 0) {
      throw new AuthError(503, "auth_unavailable", `${this.tool} couldn't confirm your access with Lark (code ${code}). Try again in a moment.`);
    }
    return user;
  }
}

/** The default `get`: fetch with a 15 s limit. A non-JSON answer reads as {code: -status}. */
export function httpGetWith(f = (...a) => globalThis.fetch(...a)) {
  return async (url, token) => {
    const res = await f(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch (_) {
      return { code: -res.status, msg: `HTTP ${res.status}` };
    }
  };
}
const httpGet = httpGetWith();
