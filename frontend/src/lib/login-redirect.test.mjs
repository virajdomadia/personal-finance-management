import assert from "node:assert/strict";
import { test } from "node:test";

import { afterLoginPath } from "./login-redirect.ts";


test("after login, returns to the same-site page the visitor asked for", () => {
  assert.equal(afterLoginPath("?next=%2Fbudgets"), "/budgets");
  assert.equal(afterLoginPath("?next=%2Ftransactions%3Fmonth%3D2026-11"), "/transactions?month=2026-11");
});

test("after login, anything that could leave the site falls back to home", () => {
  for (const search of [
    "",
    "?next=",
    "?next=https%3A%2F%2Fevil.example",
    "?next=%2F%2Fevil.example",
    "?next=%2F%5Cevil.example",
    "?next=javascript%3Aalert(1)",
    "?next=budgets",
  ]) {
    assert.equal(afterLoginPath(search), "/", search);
  }
});
