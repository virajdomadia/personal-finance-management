import assert from "node:assert/strict";
import { test } from "node:test";

import { errorMessage, fieldErrors, formatRupees, maskLast4, toPayload } from "./accounts.ts";

const blank = {
  type: "bank",
  name: "Main",
  balance: "10",
  institution: "",
  bank_kind: "",
  last4: "",
  credit_limit: "",
  statement_day: "",
  due_day: "",
};
const bank = (o = {}) => ({ ...blank, type: "bank", bank_kind: "savings", ...o });
const card = (o = {}) => ({ ...blank, type: "credit_card", ...o });
const cash = (o = {}) => ({ ...blank, type: "cash", ...o });

test("formatRupees uses Indian grouping without touching Number", () => {
  assert.equal(formatRupees("100000.50"), "₹1,00,000.50");
  assert.equal(formatRupees("999.00"), "₹999.00");
  assert.equal(formatRupees("1000.00"), "₹1,000.00");
  assert.equal(formatRupees("999999999999.99"), "₹9,99,99,99,99,999.99");
  assert.equal(formatRupees("-500.50"), "-₹500.50");
});

test("maskLast4", () => {
  assert.equal(maskLast4("1234"), "•••• 1234");
});

test("toPayload cleans money, nulls blanks, numbers days", () => {
  assert.equal(toPayload(bank({ balance: " ₹1,00,000.50 " }), "create").balance, "100000.50");
  assert.equal(toPayload(card({ last4: "" }), "create").last4, null);
  assert.equal(toPayload(card({ due_day: "25" }), "create").due_day, 25);
  assert.equal(toPayload(card({ credit_limit: "₹ 50,000" }), "create").credit_limit, "50000");
});

test("toPayload sends only applicable fields and type on create only", () => {
  assert.equal("last4" in toPayload(cash(), "create"), false);
  assert.equal("type" in toPayload(bank(), "edit"), false);
  assert.equal(toPayload(bank(), "create").type, "bank");
});

test("fieldErrors and errorMessage", () => {
  assert.deepEqual(
    fieldErrors(JSON.stringify({ detail: [{ loc: ["body", "last4"], msg: "Must be 4 digits" }] })),
    { last4: "Must be 4 digits" },
  );
  assert.deepEqual(fieldErrors("not json"), {});
  const conflict = Object.assign(new Error("API 409"), {
    status: 409,
    body: JSON.stringify({ detail: "Restore this account before editing it." }),
  });
  assert.equal(errorMessage(conflict), "Restore this account before editing it.");
  assert.equal(errorMessage(new TypeError("fetch failed")), "Something went wrong. Try again.");
  const listShaped = Object.assign(new Error("x"), { body: JSON.stringify({ detail: [{ msg: "x" }] }) });
  assert.equal(errorMessage(listShaped), "Something went wrong. Try again.");
});
