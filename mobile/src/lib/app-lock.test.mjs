import assert from "node:assert/strict";
import { test } from "node:test";

import { LOCK_AFTER_MS, shouldLock } from "./app-lock.ts";

const NOW = 1_000_000_000;

test("locks on a cold start", () => {
  assert.equal(shouldLock(null, NOW), true);
});

test("stays unlocked just under five minutes", () => {
  assert.equal(shouldLock(NOW - 299_999, NOW), false);
});

test("locks at five minutes", () => {
  assert.equal(shouldLock(NOW - 300_000, NOW), true);
  assert.equal(LOCK_AFTER_MS, 300_000);
});
