import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "pfm_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Longer than any real id, expiry or version; mirrors backend/app/core/security.py.
const MAX_NUMBER_DIGITS = 20;

function isNumber(text: string): boolean {
  return /^[0-9]+$/.test(text) && text.length <= MAX_NUMBER_DIGITS;
}

/**
 * Checks a token issued by the API: "userId.sessionVersion.sessionId.expirySeconds.signature", or
 * one from before sessions without the session id. Only the signature and expiry can be checked
 * here; the API still checks the session version and that the session wasn't logged out.
 * `now` is in seconds.
 */
export function isValidSessionToken(
  token: string | undefined,
  secret: string,
  now: number = Date.now() / 1000,
): boolean {
  if (!token || !secret) return false;

  const parts = token.split(".");
  if (parts.length !== 4 && parts.length !== 5) return false;
  const fields = parts.slice(0, -1);
  if (!fields.every(isNumber)) return false;

  const payload = fields.join(".");
  const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  const actual = Buffer.from(parts[parts.length - 1]);
  const signatureMatches = actual.length === expected.length && timingSafeEqual(actual, expected);

  return signatureMatches && now < Number(fields[fields.length - 1]);
}

/** The dev bypass has no real session, so /login must stay reachable there. */
export function hasSessionToRedirect(
  token: string | undefined,
  secret: string | undefined,
  now?: number,
): boolean {
  return Boolean(secret) && isValidSessionToken(token, secret ?? "", now);
}

/** How long logging out waits for the API before going ahead without it. */
export const END_SESSION_TIMEOUT_MS = 5000;

/**
 * The API call that ends a session: "logout" revokes this browser's session, "everywhere" signs
 * every browser and phone out.
 */
export function endSessionRequest(
  apiUrl: string,
  scope: "logout" | "everywhere",
  token: string,
): [string, RequestInit] {
  const path = scope === "logout" ? "logout" : "logout-everywhere";
  return [
    `${apiUrl}/api/auth/${path}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(END_SESSION_TIMEOUT_MS),
    },
  ];
}
