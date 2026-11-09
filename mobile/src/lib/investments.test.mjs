import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankTradeForm,
  formatPercent,
  formatSigned,
  tone,
  tradeFormFrom,
  tradePayload,
  tradeTotal,
} from "./investments.ts";

const form = {
  stock_id: "4",
  account_id: "2",
  side: "buy",
  date: "2026-11-08",
  quantity: "3",
  price: "1234.56",
  charges: "20.10",
  opening: false,
  note: "",
};

test("formatSigned puts the sign before the rupee symbol", () => {
  assert.equal(formatSigned("1234.50"), "+₹1,234.50");
  assert.equal(formatSigned("-250.00"), "−₹250.00");
  assert.equal(formatSigned("0.00"), "₹0.00");
  assert.equal(formatSigned("-0.00"), "₹0.00");
  assert.equal(formatSigned("1234567.00"), "+₹12,34,567.00");
});

test("formatPercent follows the same sign rules", () => {
  assert.equal(formatPercent("12.34"), "+12.34%");
  assert.equal(formatPercent("-3.10"), "−3.10%");
  assert.equal(formatPercent("0.00"), "0.00%");
});

test("tone", () => {
  assert.equal(tone("1.00"), "gain");
  assert.equal(tone("-0.01"), "loss");
  assert.equal(tone("0.00"), "flat");
  assert.equal(tone("-0.00"), "flat");
});

test("tradeTotal", () => {
  assert.equal(tradeTotal(form), "3723.78");
  assert.equal(tradeTotal({ ...form, side: "sell" }), "3683.58");
  assert.equal(tradeTotal({ ...form, charges: "" }), "3703.68");
  assert.equal(tradeTotal({ ...form, price: "₹1,234.56" }), "3723.78");
  assert.equal(tradeTotal({ ...form, quantity: "" }), null);
  assert.equal(tradeTotal({ ...form, quantity: "0" }), null);
  assert.equal(tradeTotal({ ...form, quantity: "1.5" }), null);
  assert.equal(tradeTotal({ ...form, price: "" }), null);
  assert.equal(tradeTotal({ ...form, price: "0" }), null);
  assert.equal(tradeTotal({ ...form, price: "1.234" }), null);
  assert.equal(tradeTotal({ ...form, charges: "abc" }), null);
  assert.equal(tradeTotal({ ...form, side: "sell", quantity: "1", price: "10", charges: "25" }), "-15.00");
});

test("blankTradeForm and tradeFormFrom", () => {
  assert.deepEqual(blankTradeForm("sell", "2026-11-08"), {
    stock_id: "",
    account_id: "",
    side: "sell",
    date: "2026-11-08",
    quantity: "",
    price: "",
    charges: "",
    opening: false,
    note: "",
  });
  assert.equal(blankTradeForm("buy", "2026-11-08", true).opening, true);
  const trade = {
    id: 9,
    stock_id: 4,
    symbol: "TCS",
    account_id: 2,
    account_name: "Zerodha",
    side: "buy",
    date: "2026-11-01",
    quantity: 3,
    price: "1234.56",
    charges: "0.00",
    opening: true,
    note: null,
    amount: "3703.68",
    realised: null,
  };
  assert.deepEqual(tradeFormFrom(trade), {
    stock_id: "4",
    account_id: "2",
    side: "buy",
    date: "2026-11-01",
    quantity: "3",
    price: "1234.56",
    charges: "0.00",
    opening: true,
    note: "",
  });
});

test("tradePayload create", () => {
  assert.deepEqual(tradePayload({ ...form, price: " 1,234.56 ", note: " hi " }, "create"), {
    stock_id: 4,
    account_id: 2,
    side: "buy",
    date: "2026-11-08",
    quantity: 3,
    price: "1234.56",
    charges: "20.10",
    opening: false,
    note: "hi",
  });
  const blank = tradePayload({ ...form, charges: " " }, "create");
  assert.equal(blank.charges, "0");
  assert.equal(blank.note, null);
});

test("tradePayload edit leaves out side and opening", () => {
  const payload = tradePayload(form, "edit");
  assert.equal("side" in payload, false);
  assert.equal("opening" in payload, false);
  assert.equal(payload.quantity, 3);
  assert.equal(payload.stock_id, 4);
});
