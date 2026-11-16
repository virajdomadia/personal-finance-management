import assert from "node:assert/strict";
import { test } from "node:test";

import {
  confirmMatches,
  emptyHoldingsText,
  formatShare,
  holdingCountText,
  holdingGain,
  holdingLabel,
  isMissingProfile,
  kindLabel,
  parseProfileId,
  pathAfterSwitch,
  profileCookie,
  readProfileCookie,
  shares,
  sortHoldings,
  switcherLabel,
  typesWithMoney,
  viewedMember,
  viewingText,
} from "./family.ts";

test("parseProfileId accepts only a plain positive id", () => {
  assert.equal(parseProfileId("12"), 12);
  assert.equal(parseProfileId(" 7 "), 7);
  assert.equal(parseProfileId("2147483647"), 2147483647);
  for (const junk of [undefined, null, "", "0", "012", "-3", "1.5", "1e3", "abc", "12a", "１２", "99999999999", "2147483648", "1,2", "1\r\nX: y"]) {
    assert.equal(parseProfileId(junk), null, String(junk));
  }
});

test("readProfileCookie finds the profile among other cookies", () => {
  assert.equal(readProfileCookie("a=1; pfm_profile=42; b=2"), 42);
  assert.equal(readProfileCookie("pfm_profile=42"), 42);
  assert.equal(readProfileCookie(""), null);
  assert.equal(readProfileCookie("pfm_profile=; other=3"), null);
  assert.equal(readProfileCookie("pfm_profile=x9"), null);
  assert.equal(readProfileCookie("not_pfm_profile=5"), null);
});

test("profileCookie sets and clears the choice for the whole site", () => {
  assert.equal(profileCookie(5, false), "pfm_profile=5; Path=/; SameSite=Lax; Max-Age=31536000");
  assert.equal(profileCookie(5, true), "pfm_profile=5; Path=/; SameSite=Lax; Secure; Max-Age=31536000");
  assert.equal(profileCookie(null, false), "pfm_profile=; Path=/; SameSite=Lax; Max-Age=0");
});

test("isMissingProfile is only the API's missing-member 404 outside the family routes", () => {
  const body = JSON.stringify({ detail: "That family member wasn't found." });
  assert.equal(isMissingProfile("/accounts", 404, body), true);
  assert.equal(isMissingProfile("/investments/portfolio", 404, body), true);
  assert.equal(isMissingProfile("/family/members/3", 404, body), false);
  assert.equal(isMissingProfile("/family", 404, body), false);
  assert.equal(isMissingProfile("/accounts", 500, body), false);
  assert.equal(isMissingProfile("/accounts/9", 404, JSON.stringify({ detail: "That account wasn't found." })), false);
  assert.equal(isMissingProfile("/accounts", 404, "not json"), false);
});

test("pathAfterSwitch leaves a record's page for its list", () => {
  assert.equal(pathAfterSwitch("/"), "/");
  assert.equal(pathAfterSwitch("/transactions"), "/transactions");
  assert.equal(pathAfterSwitch("/family/manage"), "/family/manage");
  assert.equal(pathAfterSwitch("/investments/12"), "/investments");
  assert.equal(pathAfterSwitch("/investments/funds/4"), "/investments");
  assert.equal(pathAfterSwitch("/goals/3"), "/goals");
});

test("viewedMember finds the member, treats the owner as no member and flags a stale choice", () => {
  const family = { me: { id: 1, name: "Me" }, members: [{ id: 5, name: "Papa" }] };
  assert.deepEqual(viewedMember(family, 5), { member: { id: 5, name: "Papa" }, stale: false });
  assert.deepEqual(viewedMember(family, null), { member: null, stale: false });
  assert.deepEqual(viewedMember(family, 1), { member: null, stale: false });
  assert.deepEqual(viewedMember(family, 9), { member: null, stale: true });
  assert.deepEqual(viewedMember(null, 9), { member: null, stale: false });
});

test("wording for the bar, the switcher and the confirm", () => {
  assert.equal(viewingText("Papa"), "Viewing Papa's profile — anything you add goes to Papa");
  assert.equal(viewingText(null), "Viewing a family member's profile");
  assert.equal(switcherLabel(null), "Viewing: Me");
  assert.equal(switcherLabel({ id: 5, name: "Papa" }), "Viewing: Papa");
  assert.equal(confirmMatches(" papa ", "Papa"), true);
  assert.equal(confirmMatches("Pap", "Papa"), false);
  assert.equal(confirmMatches("", ""), false);
});

test("emptyHoldingsText for me and for a member", () => {
  assert.equal(emptyHoldingsText({ name: "Me", is_me: true }), "Nothing yet. Add your investments on the Investments page.");
  assert.equal(emptyHoldingsText({ name: "Papa", is_me: false }), "Nothing yet. Switch to Papa to add their investments.");
});

const holding = (over) => ({
  kind: "stock",
  name: "Infosys",
  symbol: "INFY",
  account: null,
  quantity: "10",
  invested: "1000.00",
  value: "1500.00",
  ...over,
});

test("holding labels by kind", () => {
  assert.equal(kindLabel("stock"), "Stock");
  assert.equal(kindLabel("mutual_fund"), "Mutual fund");
  assert.equal(kindLabel("ppf"), "PPF");
  assert.equal(kindLabel("other"), "other");
  assert.deepEqual(holdingLabel(holding({})), { title: "INFY", detail: "Infosys" });
  assert.deepEqual(holdingLabel(holding({ kind: "crypto", symbol: "BTC", name: "BTC" })), { title: "BTC", detail: null });
  assert.deepEqual(holdingLabel(holding({ kind: "mutual_fund", name: "Parag Parikh Flexi Cap", symbol: "122639" })), {
    title: "Parag Parikh Flexi Cap",
    detail: null,
  });
  assert.deepEqual(holdingLabel(holding({ kind: "ppf", name: "SBI PPF", symbol: null, account: "SBI PPF", quantity: null })), {
    title: "SBI PPF",
    detail: null,
  });
  assert.equal(holdingCountText(1), "1 holding");
  assert.equal(holdingCountText(3), "3 holdings");
});

test("holdingGain works in paise", () => {
  assert.equal(holdingGain({ invested: "1000.10", value: "1500.30" }), "500.20");
  assert.equal(holdingGain({ invested: "0.30", value: "0.10" }), "-0.20");
  assert.equal(holdingGain({ invested: "100", value: "100" }), "0.00");
});

test("sortHoldings puts the biggest first, ties by title", () => {
  const sorted = sortHoldings([
    holding({ symbol: "B", value: "100.00" }),
    holding({ symbol: "A", value: "100.00" }),
    holding({ symbol: "C", value: "900.50" }),
  ]);
  assert.deepEqual(
    sorted.map((h) => h.symbol),
    ["C", "A", "B"],
  );
});

test("shares are percentages of the sum, never below zero", () => {
  assert.deepEqual(shares(["300", "100"]), [75, 25]);
  assert.deepEqual(shares(["1", "2"]), [33.3, 66.7]);
  assert.deepEqual(shares(["0", "0"]), [0, 0]);
  assert.deepEqual(shares(["-50", "100"]), [0, 100]);
  assert.equal(formatShare(33.3), "33.3%");
  assert.equal(formatShare(100), "100.0%");
});

test("typesWithMoney keeps the usual order and drops empty types", () => {
  const f = (value) => ({ invested: value, value, unrealised: "0.00", unrealised_percent: "0.00" });
  const rows = typesWithMoney({ stocks: f("10.00"), funds: f("0.00"), crypto: f("0"), deposits: f("5.00") });
  assert.deepEqual(
    rows.map((r) => r.label),
    ["Stocks", "Deposits"],
  );
});
