import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankCryptoTradeForm,
  cryptoTradeFormFrom,
  cryptoTradePayload,
  formatCoinPrice,
  formatCoinQty,
  qtyMismatch,
} from "./crypto.ts";

const form = (over = {}) => ({
  ...blankCryptoTradeForm("buy", "2026-11-01"),
  coin_id: "1",
  account_id: "2",
  quantity: "0.00004",
  price: "7504827.5",
  amount: "300.19",
  ...over,
});

test("formatCoinQty trims trailing zeros and groups the Indian way", () => {
  assert.equal(formatCoinQty("0.00014067"), "0.00014067");
  assert.equal(formatCoinQty("0.00485000"), "0.00485");
  assert.equal(formatCoinQty("12.50000000"), "12.5");
  assert.equal(formatCoinQty("1234.00000000"), "1,234");
  assert.equal(formatCoinQty("123456.00000000"), "1,23,456");
});

test("formatCoinPrice uses 2 decimals unless the 3rd or 4th is non-zero", () => {
  assert.equal(formatCoinPrice("7504827.5000"), "₹75,04,827.50");
  assert.equal(formatCoinPrice("0.0012"), "₹0.0012");
  assert.equal(formatCoinPrice("12.3400"), "₹12.34");
  assert.equal(formatCoinPrice("12.3450"), "₹12.345");
});

test("qtyMismatch applies the server's Rs 1.00 rule", () => {
  // 0.00004 x 7504827.5 = 300.193
  assert.equal(qtyMismatch(form()), false);
  assert.equal(qtyMismatch(form({ amount: "301.19" })), false);
  assert.equal(qtyMismatch(form({ amount: "301.20" })), true);
  // charges come off a buy
  assert.equal(qtyMismatch(form({ amount: "310.19", charges: "10" })), false);
  assert.equal(qtyMismatch(form({ amount: "300.19", charges: "10" })), true);
});

test("qtyMismatch on a sell adds charges to the amount", () => {
  const sell = form({ mode: "sell", amount: "290.19", charges: "10" });
  assert.equal(qtyMismatch(sell), false);
  assert.equal(qtyMismatch({ ...sell, amount: "300.19" }), true);
});

test("qtyMismatch is false for opening and for unfinished input", () => {
  assert.equal(qtyMismatch(form({ mode: "opening", amount: "1" })), false);
  assert.equal(qtyMismatch(form({ quantity: "" })), false);
  assert.equal(qtyMismatch(form({ price: "abc" })), false);
});

test("blank form and form from a trade", () => {
  assert.deepEqual(blankCryptoTradeForm("sell", "2026-11-01"), {
    coin_id: "",
    account_id: "",
    mode: "sell",
    date: "2026-11-01",
    quantity: "",
    price: "",
    charges: "",
    amount: "",
    note: "",
  });
  const trade = {
    id: 5, coin_id: 1, symbol: "BTC", account_id: 2, account_name: "CoinDCX", side: "buy",
    date: "2026-11-01", quantity: "0.00004000", price: "7504827.5000", charges: "0.00",
    amount: "300.19", opening: false, note: null, realised: null,
  };
  const f = cryptoTradeFormFrom(trade);
  assert.equal(f.mode, "buy");
  assert.equal(f.coin_id, "1");
  assert.equal(f.note, "");
  assert.equal(cryptoTradeFormFrom({ ...trade, opening: true }).mode, "opening");
  assert.equal(cryptoTradeFormFrom({ ...trade, side: "sell" }).mode, "sell");
});

test("cryptoTradePayload sends text and honours create/edit", () => {
  assert.deepEqual(cryptoTradePayload(form({ charges: "1,000", note: " hi " }), "create"), {
    coin_id: 1,
    account_id: 2,
    side: "buy",
    date: "2026-11-01",
    quantity: "0.00004",
    price: "7504827.5",
    charges: "1000",
    amount: "300.19",
    opening: false,
    note: "hi",
  });
  const edit = cryptoTradePayload(form(), "edit");
  assert.equal("side" in edit, false);
  assert.equal("opening" in edit, false);
  assert.equal(edit.charges, "0");
  assert.equal(edit.note, null);
  const opening = cryptoTradePayload(form({ mode: "opening" }), "create");
  assert.equal("price" in opening, false);
  assert.equal(opening.opening, true);
  assert.equal(opening.side, "buy");
  assert.equal(cryptoTradePayload(form({ mode: "sell" }), "create").side, "sell");
});
