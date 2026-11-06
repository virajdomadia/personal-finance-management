import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "pfm_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// Longer than any real id, expiry or version; mirrors backend/app/core/security.py.
const MAX_NUMBER_DIGITS = 20;

function isNumber(text: string): boolean {
  return /^[0-9]+$/.test(text) && text.length <= MAX_NUMBER_DIGITS;
}

/**
 * Checks a token issued by the API: "userId.sessionVersion.expirySeconds.signature".
 * Only the signature and expiry can be checked here; the API still checks the session version.
 * `now` is in seconds.
 */
export function isValidSessionToken(
  token: string | undefined,
  secret: string,
  now: number = Date.now() / 1000,
): boolean {
  if (!token || !secret) return false;

  const parts = token.split(".");
  if (parts.length !== 4 || !parts.slice(0, 3).every(isNumber)) return false;

  const payload = parts.slice(0, 3).join(".");
  const expected = Buffer.from(createHmac("sha256", secret).update(payload).digest("base64url"));
  const actual = Buffer.from(parts[3]);
  const signatureMatches = actual.length === expected.length && timingSafeEqual(actual, expected);

  return signatureMatches && now < Number(parts[2]);
}

/** The dev bypass has no real session, so /login must stay reachable there. */
export function hasSessionToRedirect(
  token: string | undefined,
  secret: string | undefined,
  now?: number,
): boolean {
  return Boolean(secret) && isValidSessionToken(token, secret ?? "", now);
}
