import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankFundTradeForm,
  blankSipForm,
  dueText,
  formatNav,
  formatUnits,
  fundTradeFormFrom,
  fundTradePayload,
  sipFormFrom,
  sipPayload,
  sipTradeForm,
  stampDuty,
  suggestedUnits,
  unitsMismatch,
} from "./funds.ts";

const sip = {
  id: 7,
  fund_id: 3,
  symbol: "PPFAS",
  fund_name: "Parag Parikh Flexi Cap – Regular Growth",
  account_id: 2,
  account_name: "HDFC",
  amount: "3000.00",
  day: 5,
  start_date: "2026-05-05",
  active: true,
  instalments: 5,
  due: ["2026-11-05"],
  due_date: "2026-11-05",
};

const buy = {
  fund_id: "3",
  account_id: "2",
  mode: "buy",
  date: "2026-11-08",
  units: "35.552",
  nav: "84.3793",
  charges: "0.15",
  amount: "3000.00",
  sip_id: "",
  note: "",
};

test("stampDuty is 0.005% of the amount, half up", () => {
  assert.equal(stampDuty("3000"), "0.15");
  assert.equal(stampDuty("2000.00"), "0.10");
  assert.equal(stampDuty("abc"), null);
  assert.equal(stampDuty(""), null);
});

test("suggestedUnits is exact and rounds half up to 3 decimals", () => {
  assert.equal(suggestedUnits("3000.00", "0.15", "84.3793"), "35.552");
  assert.equal(suggestedUnits("2000.00", "0.10", "635.0943"), "3.149");
  assert.equal(suggestedUnits("3000", "", "100"), "30.000");
  assert.equal(suggestedUnits("3000.00", "0.15", "0"), null);
  assert.equal(suggestedUnits("3000.00", "0.15", "1.23456"), null);
  assert.equal(suggestedUnits("x", "0", "10"), null);
  assert.equal(suggestedUnits("10", "10", "10"), null);
});

test("unitsMismatch applies the Rs 1.00 rule to purchases only", () => {
  assert.equal(unitsMismatch(buy), false);
  assert.equal(unitsMismatch({ ...buy, units: "36.000" }), true);
  assert.equal(unitsMismatch({ ...buy, mode: "sell", units: "36.000" }), false);
  assert.equal(unitsMismatch({ ...buy, mode: "opening", units: "36.000" }), false);
  assert.equal(unitsMismatch({ ...buy, mode: "sip", units: "36.000" }), true);
  assert.equal(unitsMismatch({ ...buy, units: "" }), false);
  // 35.552 x 84.3793 = 2999.9857...; a unit more than 1.00 away is flagged, within is not.
  assert.equal(unitsMismatch({ ...buy, units: "35.545" }), false);
  assert.equal(unitsMismatch({ ...buy, units: "35.540" }), true);
});

test("formatUnits and formatNav group the Indian way", () => {
  assert.equal(formatUnits("1234.567"), "1,234.567");
  assert.equal(formatUnits("12345678.500"), "1,23,45,678.500");
  assert.equal(formatUnits("5.000"), "5.000");
  assert.equal(formatNav("84.3793"), "₹84.3793");
  assert.equal(formatNav("123456.7000"), "₹1,23,456.7000");
});

test("dueText names the fund, amount and first due date", () => {
  assert.equal(
    dueText(sip),
    "Parag Parikh Flexi Cap – Regular Growth: ₹3,000 SIP due since 5 Nov. Record it.",
  );
  assert.equal(
    dueText({ ...sip, amount: "1500.50", due: ["2026-10-05", "2026-11-05"], due_date: "2026-10-05" }),
    "Parag Parikh Flexi Cap – Regular Growth: ₹1,500.50 SIP due since 5 Oct (2 months). Record it.",
  );
});

test("blank and SIP forms", () => {
  const blank = blankFundTradeForm("buy", "2026-11-08");
  assert.deepEqual(blank, {
    fund_id: "", account_id: "", mode: "buy", date: "2026-11-08",
    units: "", nav: "", charges: "", amount: "", sip_id: "", note: "",
  });
  assert.deepEqual(sipTradeForm(sip, "2026-11-05"), {
    fund_id: "3", account_id: "2", mode: "sip", date: "2026-11-05",
    units: "", nav: "", charges: "0.15", amount: "3000.00", sip_id: "7", note: "",
  });
});

test("fundTradeFormFrom picks the mode", () => {
  const trade = {
    id: 1, fund_id: 3, symbol: "PPFAS", account_id: 2, account_name: "HDFC", side: "buy",
    date: "2026-11-08", units: "35.552", nav: "84.3793", charges: "0.15", amount: "3000.00",
    opening: false, sip_id: null, note: null, realised: null,
  };
  assert.deepEqual(fundTradeFormFrom(trade), buy);
  assert.equal(fundTradeFormFrom({ ...trade, sip_id: 7 }).mode, "sip");
  assert.equal(fundTradeFormFrom({ ...trade, sip_id: 7 }).sip_id, "7");
  assert.equal(fundTradeFormFrom({ ...trade, side: "sell" }).mode, "sell");
  assert.equal(fundTradeFormFrom({ ...trade, opening: true }).mode, "opening");
});

test("fundTradePayload sends text units and NAV, and respects create vs edit", () => {
  assert.deepEqual(fundTradePayload({ ...buy, units: " 35.552 ", amount: "₹3,000.00", note: " hi " }, "create"), {
    fund_id: 3, account_id: 2, side: "buy", date: "2026-11-08", units: "35.552", nav: "84.3793",
    charges: "0.15", amount: "3000.00", opening: false, sip_id: null, note: "hi",
  });
  assert.deepEqual(fundTradePayload({ ...buy, charges: "" }, "edit"), {
    fund_id: 3, account_id: 2, date: "2026-11-08", units: "35.552", nav: "84.3793",
    charges: "0", amount: "3000.00", sip_id: null, note: null,
  });
  assert.deepEqual(fundTradePayload({ ...buy, mode: "sell" }, "create").side, "sell");
  const sipPay = fundTradePayload({ ...buy, mode: "sip", sip_id: "7" }, "create");
  assert.equal(sipPay.sip_id, 7);
  assert.equal(sipPay.side, "buy");
  const opening = fundTradePayload({ ...buy, mode: "opening" }, "create");
  assert.equal(opening.opening, true);
  assert.equal(opening.side, "buy");
  assert.equal("nav" in opening, false);
  assert.equal("nav" in fundTradePayload({ ...buy, mode: "opening" }, "edit"), false);
});

test("SIP forms and payloads", () => {
  const blank = blankSipForm("2026-11-08");
  assert.deepEqual(blank, {
    fund_id: "", account_id: "", amount: "", day: "", start_date: "2026-11-08", active: true,
  });
  const form = { fund_id: "3", account_id: "2", amount: "₹3,000", day: "5", start_date: "2026-05-05", active: false };
  assert.deepEqual(sipPayload(form, "create"), {
    fund_id: 3, account_id: 2, amount: "3000", day: 5, start_date: "2026-05-05",
  });
  assert.deepEqual(sipPayload(form, "edit"), { account_id: 2, amount: "3000", day: 5, active: false });
  assert.deepEqual(sipFormFrom(sip), {
    fund_id: "3", account_id: "2", amount: "3000.00", day: "5", start_date: "2026-05-05", active: true,
  });
});
