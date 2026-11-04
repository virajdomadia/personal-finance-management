import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createSessionToken,
  hashPassword,
  isValidSessionToken,
  SESSION_MAX_AGE_SECONDS,
  verifyPassword,
} from "./auth.ts";

const NOW = 1_800_000_000_000;

test("correct password verifies against its hash", () => {
  assert.equal(verifyPassword("correct horse", hashPassword("correct horse")), true);
});

test("wrong password is rejected", () => {
  assert.equal(verifyPassword("wrong", hashPassword("correct horse")), false);
});

test("hashing salts, so the same password hashes differently", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

test("hash does not contain the password", () => {
  assert.equal(hashPassword("correct horse").includes("correct horse"), false);
});

for (const stored of ["", "nocolon", ":", "zz:zz", "abcd:"]) {
  test(`malformed stored hash ${JSON.stringify(stored)} is rejected`, () => {
    assert.equal(verifyPassword("anything", stored), false);
  });
}

test("fresh session token is valid", () => {
  assert.equal(isValidSessionToken(createSessionToken("key", NOW), "key", NOW), true);
});

test("token is still valid just before it expires", () => {
  const token = createSessionToken("key", NOW);
  const later = NOW + SESSION_MAX_AGE_SECONDS * 1000 - 1;
  assert.equal(isValidSessionToken(token, "key", later), true);
});

test("token is invalid once expired", () => {
  const token = createSessionToken("key", NOW);
  const later = NOW + SESSION_MAX_AGE_SECONDS * 1000;
  assert.equal(isValidSessionToken(token, "key", later), false);
});

test("token signed with another key is rejected", () => {
  assert.equal(isValidSessionToken(createSessionToken("other", NOW), "key", NOW), false);
});

test("extending a token's expiry invalidates its signature", () => {
  const [expiry, signature] = createSessionToken("key", NOW).split(".");
  const forged = `${Number(expiry) + 1000}.${signature}`;
  assert.equal(isValidSessionToken(forged, "key", NOW), false);
});

test("empty secret never validates, even a token signed with it", () => {
  assert.equal(isValidSessionToken(createSessionToken("", NOW), "", NOW), false);
});

for (const token of [undefined, "", "garbage", ".", "123.", ".abc", "1.2.3"]) {
  test(`malformed token ${JSON.stringify(token)} is rejected`, () => {
    assert.equal(isValidSessionToken(token, "key", NOW), false);
  });
}
