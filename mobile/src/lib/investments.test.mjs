import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankTradeForm,
  canSearchMarket,
  linkLabel,
  marketSearchPath,
  changedTrade,
  formatPercent,
  formatSigned,
  tone,
  tradeDeleteText,
  tradeErrors,
  tradeFormFrom,
  tradePayload,
  tradeTitle,
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

test("tradeErrors passes a valid form", () => {
  assert.deepEqual(tradeErrors(form, "2026-11-09"), {});
  assert.deepEqual(tradeErrors({ ...form, charges: "", price: "₹1,234.50" }, "2026-11-09"), {});
});

test("tradeErrors checks broker, date, quantity, price and charges", () => {
  const errors = tradeErrors(
    { ...form, account_id: "", date: "2026-11-10", quantity: "1.5", price: "0", charges: "abc" },
    "2026-11-09",
  );
  assert.deepEqual(Object.keys(errors).sort(), ["account_id", "charges", "date", "price", "quantity"]);
  assert.equal(errors.date, "The date can't be in the future.");
  assert.equal(errors.price, "Price must be greater than 0.");
  assert.equal(tradeErrors({ ...form, date: "" }, "2026-11-09").date, "Choose a date.");
  assert.ok(tradeErrors({ ...form, quantity: "0" }, "2026-11-09").quantity);
  assert.ok(tradeErrors({ ...form, quantity: "100000001" }, "2026-11-09").quantity);
  assert.equal(tradeErrors({ ...form, quantity: "100000000" }, "2026-11-09").quantity, undefined);
  assert.equal(tradeErrors({ ...form, price: "12.345" }, "2026-11-09").price, "Enter a price, like 1234.50.");
});

const trade = {
  id: 9,
  stock_id: 4,
  symbol: "INFY",
  account_id: 2,
  account_name: "Zerodha",
  side: "sell",
  date: "2026-11-08",
  quantity: 3,
  price: "1234.56",
  charges: "20.10",
  opening: false,
  note: null,
  amount: "3683.58",
  realised: "10.00",
};

test("changedTrade sends only what changed", () => {
  const same = tradeFormFrom(trade);
  assert.deepEqual(changedTrade(same, trade), {});
  assert.deepEqual(changedTrade({ ...same, quantity: "4", note: " x " }, trade), { quantity: 4, note: "x" });
});

test("tradeTitle and tradeDeleteText", () => {
  assert.equal(tradeTitle(trade), "Sold 3 INFY");
  assert.equal(tradeTitle({ ...trade, side: "buy" }), "Bought 3 INFY");
  assert.equal(tradeTitle({ ...trade, side: "buy", opening: true }), "Existing 3 INFY");
  assert.equal(tradeDeleteText(trade).title, "Delete Sold 3 INFY on 8 Nov 2026?");
  assert.match(tradeDeleteText(trade).body, /Zerodha's cash moves back/);
  assert.match(tradeDeleteText({ ...trade, opening: true }).body, /holding shrinks/);
});

test("tradeErrors refuses dates that don't exist", () => {
  assert.equal(tradeErrors({ ...form, date: "2026-02-31" }, "2026-11-09").date, "Enter a date like 2026-11-08.");
  assert.equal(tradeErrors({ ...form, date: "2026-13-01" }, "2026-11-09").date, "Enter a date like 2026-11-08.");
  assert.equal(tradeErrors({ ...form, date: "2025-02-29" }, "2026-11-09").date, "Enter a date like 2026-11-08.");
  assert.equal(tradeErrors({ ...form, date: "2024-02-29" }, "2026-11-09").date, undefined);
});

test("marketSearchPath builds the search URL and encodes the text", () => {
  assert.equal(marketSearchPath("mutual_fund", "parag"), "/investments/market-codes?kind=mutual_fund&q=parag");
  assert.equal(marketSearchPath("stock", " Tata & Sons "), "/investments/market-codes?kind=stock&q=Tata%20%26%20Sons");
});

test("linkLabel names the link or offers one", () => {
  assert.equal(linkLabel(null), "Link to live prices");
  assert.equal(linkLabel("INFY"), "Linked to INFY");
});

test("canSearchMarket needs two characters", () => {
  assert.equal(canSearchMarket(" a "), false);
  assert.equal(canSearchMarket("ab"), true);
});
