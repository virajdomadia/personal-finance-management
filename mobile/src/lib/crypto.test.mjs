import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankCryptoTradeForm,
  changedCryptoTrade,
  cryptoTradeDeleteText,
  cryptoTradeErrors,
  cryptoTradeFormFrom,
  cryptoTradePayload,
  cryptoTradeTitle,
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

test("formatCoinPrice shows paise from Rs 1 up and up to 4 decimals below", () => {
  assert.equal(formatCoinPrice("7066965.2378"), "₹70,66,965.24");
  assert.equal(formatCoinPrice("204971.1340"), "₹2,04,971.13");
  assert.equal(formatCoinPrice("7504827.5000"), "₹75,04,827.50");
  assert.equal(formatCoinPrice("0.0012"), "₹0.0012");
  assert.equal(formatCoinPrice("0.5000"), "₹0.50");
  assert.equal(formatCoinPrice("0.9999"), "₹0.9999");
  assert.equal(formatCoinPrice("1.0050"), "₹1.01");
  assert.equal(formatCoinPrice("0.0000"), "₹0.00");
  assert.equal(formatCoinPrice("99.9950"), "₹100.00");
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

test("qtyMismatch allows quantity x Rs 0.00005 when that is more than Rs 1.00", () => {
  // 1 crore coins: 10000000 x 0.00005 = Rs 500.00 of rounding
  const low = form({ quantity: "10000000", price: "0.0012", amount: "12345.60", charges: "0" });
  assert.equal(qtyMismatch(low), false); // 12000.00 is 345.60 off
  assert.equal(qtyMismatch({ ...low, price: "0.0010" }), true); // 10000.00 is 2345.60 off
  // exactly the tolerance passes, a paisa more fails
  assert.equal(qtyMismatch({ ...low, amount: "12500.00" }), false);
  assert.equal(qtyMismatch({ ...low, amount: "12500.01" }), true);
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

const trade = {
  id: 5, coin_id: 1, symbol: "BTC", account_id: 2, account_name: "CoinDCX", side: "buy",
  date: "2026-11-01", quantity: "0.00014067", price: "7504827.5000", charges: "0.00",
  amount: "1055.69", opening: false, note: null, realised: null,
};

test("cryptoTradeErrors returns the server's messages", () => {
  const today = "2026-11-10";
  assert.deepEqual(cryptoTradeErrors(form(), today), {});
  const blank = cryptoTradeErrors(blankCryptoTradeForm("buy", "2026-11-01"), today);
  assert.equal(blank.coin_id, "Choose a coin.");
  assert.equal(blank.account_id, "Choose a broker or exchange account.");
  assert.equal(blank.quantity, "Enter a quantity above 0, with up to 8 decimals, like 0.00014067.");
  assert.equal(blank.price, "Enter a price above 0, with up to 4 decimals, like 7504827.5.");
  assert.equal(blank.amount, "Enter the amount.");
  assert.equal(cryptoTradeErrors(form({ quantity: "0.000000001" }), today).quantity?.startsWith("Enter a quantity"), true);
  assert.equal(cryptoTradeErrors(form({ price: "1.00001" }), today).price?.startsWith("Enter a price"), true);
  assert.equal(cryptoTradeErrors(form({ date: "2026-12-01" }), today).date, "The date can't be in the future.");
  assert.equal(cryptoTradeErrors(form({ date: "2026-02-30" }), today).date, "Enter a date like 2026-11-08.");
  assert.equal(cryptoTradeErrors(form({ amount: "0" }), today).amount, "Amount must be greater than 0.");
  assert.equal(cryptoTradeErrors(form({ charges: "-1" }), today).charges, "Charges can't be negative.");
  assert.equal(cryptoTradeErrors(form({ charges: "300.19" }), today).charges, "Charges can't be more than the amount.");
});

test("cryptoTradeErrors skips the price for existing coins", () => {
  assert.deepEqual(cryptoTradeErrors(form({ mode: "opening", price: "" }), "2026-11-10"), {});
});

test("changedCryptoTrade sends only what changed", () => {
  const original = cryptoTradeFormFrom(trade);
  assert.deepEqual(changedCryptoTrade(original, trade), {});
  assert.deepEqual(changedCryptoTrade({ ...original, note: "x" }, trade), { note: "x" });
  assert.deepEqual(changedCryptoTrade({ ...original, quantity: "0.0002" }, trade), { quantity: "0.0002" });
});

test("cryptoTradeTitle and cryptoTradeDeleteText", () => {
  assert.equal(cryptoTradeTitle(trade), "Bought 0.00014067 BTC");
  assert.equal(cryptoTradeTitle({ ...trade, quantity: "0.00485000" }), "Bought 0.00485 BTC");
  assert.equal(cryptoTradeTitle({ ...trade, side: "sell" }), "Sold 0.00014067 BTC");
  assert.equal(cryptoTradeTitle({ ...trade, opening: true }), "Existing 0.00014067 BTC");
  const text = cryptoTradeDeleteText(trade);
  assert.equal(text.title, "Delete Bought 0.00014067 BTC on 1 Nov 2026?");
  assert.match(text.body, /CoinDCX's cash moves back/);
  assert.doesNotMatch(cryptoTradeDeleteText({ ...trade, opening: true }).body, /cash/);
});
