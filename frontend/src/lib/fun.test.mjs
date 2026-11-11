import assert from "node:assert/strict";
import { test } from "node:test";

import { accountEmoji, categoryEmoji, investmentEmoji, investmentSticker, streakLabel, STACK_COLORS } from "./fun.ts";

test("categoryEmoji matches by name, ignoring case, with a fallback", () => {
  assert.equal(categoryEmoji("Food and dining"), "🍔");
  assert.equal(categoryEmoji("food and dining"), "🍔");
  assert.equal(categoryEmoji("Salary"), "💼");
  assert.equal(categoryEmoji("Something custom"), "🧾");
  assert.equal(categoryEmoji(null), "🧾");
});

test("accountEmoji covers every account type", () => {
  assert.equal(accountEmoji("bank"), "🏦");
  assert.equal(accountEmoji("credit_card"), "💳");
  assert.equal(accountEmoji("cash"), "💵");
  assert.equal(accountEmoji("broker"), "📊");
  assert.equal(accountEmoji("wallet"), "👛");
  assert.equal(accountEmoji("ppf"), "🐷");
  assert.equal(accountEmoji("rd"), "🪙");
  assert.equal(accountEmoji("loan"), "🧾");
});

test("investmentEmoji", () => {
  assert.equal(investmentEmoji("stock"), "📈");
  assert.equal(investmentEmoji("mutual_fund"), "🥧");
  assert.equal(investmentEmoji("crypto"), "🪙");
});

test("investmentSticker shows from 10 percent up, floored", () => {
  assert.equal(investmentSticker("12.4"), "+12%");
  assert.equal(investmentSticker("10"), "+10%");
  assert.equal(investmentSticker("9.99"), null);
  assert.equal(investmentSticker("-15"), null);
  assert.equal(investmentSticker(null), null);
});

test("streakLabel", () => {
  assert.equal(streakLabel(0), null);
  assert.equal(streakLabel(1), "🔥 1");
  assert.equal(streakLabel(6), "🔥 6");
  assert.equal(streakLabel(7), "🔥 7+");
  assert.equal(streakLabel(29), "🔥 7+");
  assert.equal(streakLabel(30), "🔥 30+");
  assert.equal(streakLabel(100), "🔥 100+");
  assert.equal(streakLabel(365), "🔥 100+");
});

test("STACK_COLORS is a list of colours", () => {
  assert.ok(STACK_COLORS.length >= 5);
});
