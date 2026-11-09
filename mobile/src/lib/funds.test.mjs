import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankFundTradeForm,
  blankSipForm,
  dueText,
  formatNav,
  changedFundTrade,
  formatUnits,
  fundTradeDeleteText,
  fundTradeErrors,
  fundTradeFormFrom,
  fundTradePayload,
  fundTradeTitle,
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

test("stampDuty and suggestedUnits round exact half-paise and half-thousandths up", () => {
  // 100.00 x 0.00005 is exactly 0.005, which goes up; a paisa less is just under.
  assert.equal(stampDuty("100.00"), "0.01");
  assert.equal(stampDuty("99.99"), "0.00");
  assert.equal(stampDuty("300.00"), "0.02");
  // 1.00 / 2000 is exactly 0.0005 units, which goes up; 0.99 / 2000 is 0.000495.
  assert.equal(suggestedUnits("1.00", "", "2000"), "0.001");
  assert.equal(suggestedUnits("0.99", "", "2000"), "0.000");
  assert.equal(suggestedUnits("3.00", "", "2000"), "0.002");
});

const trade = {
  id: 1, fund_id: 3, symbol: "PPFCRG", account_id: 2, account_name: "HDFC", side: "buy",
  date: "2026-11-08", units: "35.552", nav: "84.3793", charges: "0.15", amount: "3000.00",
  opening: false, sip_id: null, note: null, realised: null,
};
const TODAY = "2026-11-09";

test("fundTradeErrors is empty for a good form and uses the server's messages", () => {
  assert.deepEqual(fundTradeErrors(buy, TODAY), {});
  assert.deepEqual(fundTradeErrors({ ...buy, mode: "opening", nav: "" }, TODAY), {});
  assert.deepEqual(fundTradeErrors({ ...buy, mode: "sell", charges: "" }, TODAY), {});
  assert.deepEqual(fundTradeErrors({ ...buy, charges: "₹1,000" }, TODAY), {});
  assert.deepEqual(
    fundTradeErrors({ ...buy, fund_id: "", account_id: "", date: "", units: "", nav: "", amount: "" }, TODAY),
    {
      fund_id: "Choose a fund.",
      account_id: "Choose a bank account.",
      date: "Choose a date.",
      units: "Enter units above 0, with up to 3 decimals, like 35.552.",
      nav: "Enter a NAV above 0, with up to 4 decimals, like 84.3793.",
      amount: "Enter the amount.",
    },
  );
});

test("fundTradeErrors units and NAV rules", () => {
  const units = (value) => fundTradeErrors({ ...buy, units: value }, TODAY).units;
  const rule = "Enter units above 0, with up to 3 decimals, like 35.552.";
  assert.equal(units("0"), rule);
  assert.equal(units("0.000"), rule);
  assert.equal(units("-1"), rule);
  assert.equal(units("1.2345"), rule);
  assert.equal(units("1,000"), rule);
  assert.equal(units("1.500"), undefined);
  assert.equal(units("999999999999999.999"), undefined);
  assert.equal(units("1000000000000000"), rule);
  const nav = (value) => fundTradeErrors({ ...buy, nav: value }, TODAY).nav;
  const navRule = "Enter a NAV above 0, with up to 4 decimals, like 84.3793.";
  assert.equal(nav("0"), navRule);
  assert.equal(nav("1.23456"), navRule);
  assert.equal(nav("10000000000"), navRule);
  assert.equal(nav("9999999999.9999"), undefined);
  // A NAV is not needed (or checked) for existing units.
  assert.equal(fundTradeErrors({ ...buy, mode: "opening", nav: "junk" }, TODAY).nav, undefined);
});

test("fundTradeErrors amount, charges and date rules", () => {
  const err = (patch) => fundTradeErrors({ ...buy, ...patch }, TODAY);
  assert.equal(err({ amount: "abc" }).amount, "Enter an amount, like 1234.50.");
  assert.equal(err({ amount: "1.234" }).amount, "Enter an amount, like 1234.50.");
  assert.equal(err({ amount: "0" }).amount, "Amount must be greater than 0.");
  assert.equal(err({ amount: "1000000000000" }).amount, "Amount must be under ₹10,00,00,00,00,000.");
  assert.equal(err({ charges: "x" }).charges, "Enter an amount, like 1234.50.");
  assert.equal(err({ charges: "-1" }).charges, "Charges can't be negative.");
  assert.equal(err({ charges: "3000" }).charges, "Charges can't be more than the amount.");
  assert.equal(err({ charges: "2999.99" }).charges, undefined);
  assert.equal(err({ date: "2026-11-10" }).date, "The date can't be in the future.");
  assert.equal(err({ date: "2026-11-09" }).date, undefined);
  assert.equal(err({ date: "2026-02-31" }).date, "Enter a date like 2026-11-08.");
});

test("changedFundTrade sends only what changed", () => {
  const form = fundTradeFormFrom(trade);
  assert.deepEqual(changedFundTrade(form, trade), {});
  assert.deepEqual(changedFundTrade({ ...form, units: "36.000", note: "x" }, trade), { units: "36.000", note: "x" });
  assert.deepEqual(changedFundTrade({ ...form, charges: "" }, trade), { charges: "0" });
  const out = changedFundTrade({ ...form, units: "1.000", date: "2026-11-01", account_id: "5" }, trade);
  assert.equal("side" in out, false);
  assert.equal("opening" in out, false);
});

test("changedFundTrade keeps sip_id for a SIP-linked trade and never sends nav for existing units", () => {
  const linked = { ...trade, sip_id: 7 };
  const form = fundTradeFormFrom(linked);
  assert.equal(form.sip_id, "7");
  assert.deepEqual(changedFundTrade(form, linked), {});
  assert.deepEqual(changedFundTrade({ ...form, units: "36.000" }, linked), { units: "36.000" });
  // The edit payload itself carries the link, so the server keeps the instalment settled.
  assert.equal(fundTradePayload(form, "edit").sip_id, 7);
  // Unlinking is a real change and is sent.
  assert.deepEqual(changedFundTrade({ ...form, mode: "buy", sip_id: "" }, linked), { sip_id: null });
  const opening = { ...trade, opening: true, nav: "90.0000" };
  const openForm = fundTradeFormFrom(opening);
  assert.deepEqual(changedFundTrade({ ...openForm, nav: "95.0000", units: "10.000" }, opening), { units: "10.000" });
});

test("fundTradeTitle", () => {
  assert.equal(fundTradeTitle(trade), "Purchased 35.552 PPFCRG");
  assert.equal(fundTradeTitle({ ...trade, side: "sell" }), "Redeemed 35.552 PPFCRG");
  assert.equal(fundTradeTitle({ ...trade, opening: true }), "Existing 35.552 PPFCRG");
  assert.equal(fundTradeTitle({ ...trade, sip_id: 7 }), "SIP 35.552 PPFCRG");
});

test("fundTradeDeleteText", () => {
  assert.deepEqual(fundTradeDeleteText(trade), {
    title: "Delete Purchased 35.552 PPFCRG on 8 Nov 2026?",
    body: "It's removed for good, and HDFC's cash moves back. This can't be undone.",
  });
  assert.deepEqual(fundTradeDeleteText({ ...trade, opening: true }), {
    title: "Delete Existing 35.552 PPFCRG on 8 Nov 2026?",
    body: "It's removed for good, and the holding shrinks. This can't be undone.",
  });
  assert.equal(
    fundTradeDeleteText({ ...trade, sip_id: 7 }).body,
    "It's removed for good, and HDFC's cash moves back. That SIP month becomes due again. This can't be undone.",
  );
});
