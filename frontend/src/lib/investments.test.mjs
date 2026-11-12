import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankTradeForm,
  formatPercent,
  formatSigned,
  canSearchMarket,
  holdingKinds,
  NO_MATCH,
  linkLabel,
  marketSearchPath,
  parseDismissed,
  selectedLabel,
  syncOutcome,
  syncStatusText,
  shouldShowLinkPrompt,
  unlinkedIds,
  settle,
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

test("settle turns a failed request into an error part, but rethrows what is fatal", async () => {
  assert.deepEqual(await settle(Promise.resolve(5)), { status: "ready", data: 5 });
  assert.deepEqual(await settle(Promise.reject(new Error("x"))), { status: "error" });
  await assert.rejects(settle(Promise.reject(new Error("401")), (e) => e.message === "401"));
});

test("holdingKinds counts stocks, funds, deposits and crypto that have something", () => {
  const empty = {
    by_stock: [],
    closed: [],
    funds: { by_fund: [], closed: [] },
    deposits: { accounts: [] },
    crypto: { by_coin: [], closed: [] },
  };
  assert.equal(holdingKinds(empty), 0);
  assert.equal(holdingKinds({ ...empty, by_stock: [1] }), 1);
  assert.equal(holdingKinds({ ...empty, closed: [1], deposits: { accounts: [1] } }), 2);
  assert.equal(holdingKinds({ ...empty, by_stock: [1], funds: { by_fund: [1], closed: [] }, deposits: { accounts: [1] } }), 3);
  assert.equal(holdingKinds({ ...empty, crypto: { by_coin: [1], closed: [] } }), 1);
  assert.equal(holdingKinds({ ...empty, by_stock: [1], crypto: { by_coin: [], closed: [1] } }), 2);
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

test("unlinkedIds gathers every kind, sorted", () => {
  const unlinked = {
    stocks: [{ id: 9, symbol: "INFY", name: "Infosys" }],
    funds: [{ id: 2, symbol: "F", name: "Fund" }],
    coins: [{ id: 5, symbol: "BTC", name: "Bitcoin" }],
  };
  assert.deepEqual(unlinkedIds(unlinked), [2, 5, 9]);
});

test("shouldShowLinkPrompt hides what was dismissed until a new holding appears", () => {
  assert.equal(shouldShowLinkPrompt([], []), false);
  assert.equal(shouldShowLinkPrompt([1, 2], []), true);
  assert.equal(shouldShowLinkPrompt([1, 2], [1, 2]), false);
  assert.equal(shouldShowLinkPrompt([1], [1, 2]), false); // one was linked since
  assert.equal(shouldShowLinkPrompt([1, 2, 3], [1, 2]), true);
});

test("parseDismissed ignores missing or broken values", () => {
  assert.deepEqual(parseDismissed(null), []);
  assert.deepEqual(parseDismissed("not json"), []);
  assert.deepEqual(parseDismissed('{"a":1}'), []);
  assert.deepEqual(parseDismissed('[1,"x",2.5,3]'), [1, 3]);
});

test("a pick reads as selected, not linked, until it is saved", () => {
  assert.equal(selectedLabel("Infosys Limited"), "Selected: Infosys Limited");
});

test("the empty search names what to try for each kind", () => {
  assert.equal(NO_MATCH.stock, "No match. Try the company's full name.");
  assert.equal(NO_MATCH.mutual_fund, "No match. Try the fund's full name.");
  assert.equal(NO_MATCH.crypto, "No match. Try the coin's full name.");
});

test("the sync line says what is happening, and nothing before the first sync", () => {
  assert.equal(syncStatusText({ status: "idle" }), "");
  assert.equal(syncStatusText({ status: "syncing" }), "Syncing…");
  assert.equal(syncStatusText({ status: "done" }), "Updated just now");
  assert.equal(syncStatusText({ status: "partial" }), "Some prices couldn't be fetched. Try again later.");
});

test("a sync is done only when no source failed and the request got through", () => {
  const ok = { synced_at: "2026-11-12T10:00:00Z", updated: { crypto: 2 }, failed: {} };
  assert.deepEqual(syncOutcome(ok), { status: "done" });
  assert.deepEqual(syncOutcome({ ...ok, failed: { stock: "down" } }), { status: "partial" });
  assert.deepEqual(syncOutcome(null), { status: "partial" });
});
