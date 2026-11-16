import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROFILE_GONE,
  confirmMatches,
  hasMembers,
  holdingDetails,
  isProfileGone,
  memberNameError,
  parseProfileId,
  parseStoredProfile,
  possessive,
  profileHeaders,
  quantityText,
  sendsProfile,
  shareText,
  sharePercent,
  sortHoldings,
  sortPeople,
  storedProfileValue,
  switchToText,
  typeSplit,
  viewingLabel,
  viewingText,
} from "./family.ts";

test("profile ids are whole numbers in the server's range", () => {
  assert.equal(parseProfileId("12"), 12);
  assert.equal(parseProfileId(" 7 "), 7);
  assert.equal(parseProfileId(5), 5);
  assert.equal(parseProfileId("2147483647"), 2147483647);
  for (const bad of ["0", "-1", "1.5", "abc", "", "2147483648", "99999999999", "01", "١٢", null, undefined, 0, 1.5, {}]) {
    assert.equal(parseProfileId(bad), null, String(bad));
  }
});

test("the stored choice reads back, and anything unreadable is the owner", () => {
  const raw = storedProfileValue({ id: 4, name: "Papa" });
  assert.deepEqual(parseStoredProfile(raw), { id: 4, name: "Papa" });
  assert.equal(parseStoredProfile(null), null);
  assert.equal(parseStoredProfile("not json"), null);
  assert.equal(parseStoredProfile("null"), null);
  assert.equal(parseStoredProfile(JSON.stringify({ id: "x", name: "Papa" })), null);
  assert.equal(parseStoredProfile(JSON.stringify({ id: 4, name: "  " })), null);
  assert.equal(parseStoredProfile(JSON.stringify({ id: 4 })), null);
});

test("the header is sent for the chosen member, never for the owner-only routes", () => {
  assert.deepEqual(profileHeaders("/accounts", null), {});
  assert.deepEqual(profileHeaders("/accounts", 9), { "X-Profile": "9" });
  assert.deepEqual(profileHeaders("/portfolio?x=1", 9), { "X-Profile": "9" });
  for (const path of ["/auth/session", "/family", "/family/portfolio", "/family/members/3?confirm=Papa", "/sms/entries", "/sms/review", "/payee-rules", "/payee-rules/2"]) {
    assert.deepEqual(profileHeaders(path, 9), {}, path);
  }
  assert.equal(sendsProfile("/familyish"), true);
  assert.equal(sendsProfile("/smsx"), true);
});

test("only a 404 naming the member, on a request that named one, means it has gone", () => {
  assert.equal(isProfileGone(404, PROFILE_GONE, true), true);
  assert.equal(isProfileGone(404, PROFILE_GONE, false), false);
  assert.equal(isProfileGone(404, "Account not found.", true), false);
  assert.equal(isProfileGone(409, PROFILE_GONE, true), false);
});

test("wording", () => {
  assert.equal(viewingText("Papa"), "Viewing Papa's profile");
  assert.equal(viewingText("James"), "Viewing James' profile");
  assert.equal(possessive("Mummy"), "Mummy's");
  assert.equal(viewingLabel(null), "Viewing: Me");
  assert.equal(viewingLabel({ id: 2, name: "Papa" }), "Viewing: Papa");
  assert.equal(switchToText("Papa"), "Switch to Papa to add their investments");
});

test("removing needs the name typed, ignoring case and spaces", () => {
  assert.equal(confirmMatches(" papa ", "Papa"), true);
  assert.equal(confirmMatches("Pap", "Papa"), false);
  assert.equal(confirmMatches("", ""), false);
});

test("names follow the server's rules", () => {
  const members = [{ id: 1, name: "Papa" }];
  assert.equal(memberNameError("", members), "Enter a name.");
  assert.equal(memberNameError("me", members), '"Me" is you. Choose another name.');
  assert.equal(memberNameError("papa", members), "You already have papa.");
  assert.equal(memberNameError("papa", members, 1), null);
  assert.equal(memberNameError("Mummy", members), null);
  assert.equal(memberNameError("x".repeat(41), members), "Keep it to 40 characters.");
});

test("shares of the family's value", () => {
  assert.equal(sharePercent("25", "100"), 25);
  assert.equal(sharePercent("10", "0"), 0);
  assert.equal(sharePercent("-5", "100"), 0);
  assert.equal(sharePercent("200", "100"), 100);
  assert.equal(shareText("1", "3"), "33%");
  assert.equal(shareText("0.5", "100"), "<1%");
  assert.equal(shareText("0", "100"), "0%");
  assert.equal(shareText("5", "0"), "0%");
});

test("the owner comes first, then members by name; holdings largest first", () => {
  const people = sortPeople([
    { name: "zed", is_me: false },
    { name: "Me", is_me: true },
    { name: "Amma", is_me: false },
  ]);
  assert.deepEqual(people.map((p) => p.name), ["Me", "Amma", "zed"]);
  const h = (name, value) => ({ kind: "stock", name, symbol: null, account: null, quantity: "1", invested: "0", value });
  assert.deepEqual(sortHoldings([h("b", "10"), h("a", "10"), h("c", "50.5")]).map((x) => x.name), ["c", "a", "b"]);
});

test("holding details", () => {
  assert.equal(quantityText({ kind: "stock", quantity: "1", symbol: "TCS" }), "1 share");
  assert.equal(quantityText({ kind: "mutual_fund", quantity: "12.345", symbol: null }), "12.345 units");
  assert.equal(quantityText({ kind: "crypto", quantity: "0.5", symbol: "btc" }), "0.5 BTC");
  assert.equal(quantityText({ kind: "fd", quantity: null, symbol: null }), null);
  assert.equal(
    holdingDetails({ kind: "stock", name: "TCS", symbol: "TCS", account: null, quantity: "10", invested: "35000.00", value: "40000.00" }),
    "Stock · TCS · 10 shares · invested ₹35,000.00",
  );
  assert.equal(
    holdingDetails({ kind: "ppf", name: "SBI PPF", symbol: null, account: "SBI PPF", quantity: null, invested: "100", value: "100" }),
    "PPF",
  );
});

test("the type split leaves out empty types and puts the largest first", () => {
  const f = (value) => ({ invested: value, value, unrealised: "0", unrealised_percent: "0" });
  const split = typeSplit({ stocks: f("10"), funds: f("30"), crypto: f("0"), deposits: f("60") }, "100");
  assert.deepEqual(split.map((s) => [s.key, s.share]), [["deposits", "60%"], ["funds", "30%"], ["stocks", "10%"]]);
});

test("a family has members when anyone but the owner is listed", () => {
  const f = { invested: "0", value: "0", unrealised: "0", unrealised_percent: "0" };
  const by_type = { stocks: f, funds: f, crypto: f, deposits: f };
  const me = { id: 1, name: "Me", is_me: true, overall: f, by_type, holdings: [] };
  assert.equal(hasMembers({ people: [me], overall: f, by_type }), false);
  assert.equal(hasMembers({ people: [me, { ...me, id: 2, name: "Papa", is_me: false }], overall: f, by_type }), true);
});
