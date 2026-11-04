import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "pfm_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const KEY_LENGTH = 64;

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns "salt:key" in hex, the format APP_PASSWORD_HASH is stored in. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, keyHex, ...rest] = stored.split(":");
  if (!saltHex || !keyHex || rest.length > 0) return false;

  const salt = Buffer.from(saltHex, "hex");
  const key = Buffer.from(keyHex, "hex");
  if (salt.length === 0 || key.length !== KEY_LENGTH) return false;

  return equal(scryptSync(password, salt, KEY_LENGTH), key);
}

function sign(expiry: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(expiry).digest();
}

/** A token is "expiryMillis.signature"; holding a valid one means the password was entered. */
export function createSessionToken(secret: string, now: number = Date.now()): string {
  const expiry = String(now + SESSION_MAX_AGE_SECONDS * 1000);
  return `${expiry}.${sign(expiry, secret).toString("base64url")}`;
}

export function isValidSessionToken(
  token: string | undefined,
  secret: string,
  now: number = Date.now(),
): boolean {
  if (!token || !secret) return false;

  const [expiry, signature, ...rest] = token.split(".");
  if (!expiry || !signature || rest.length > 0 || !/^\d+$/.test(expiry)) return false;

  return equal(Buffer.from(signature, "base64url"), sign(expiry, secret)) && now < Number(expiry);
}
