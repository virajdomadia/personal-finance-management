import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checklistSteps,
  loadingShown,
  parseSetupState,
  progressText,
  setupKey,
  shownAs,
  statusText,
  userIdFromToken,
  withNone,
} from "./setup.ts";

const server = (done = []) =>
  ["bank", "cards", "loans", "recurring", "investments"].map((key) => ({
    key,
    done: done.includes(key),
    count: done.includes(key) ? 2 : 0,
  }));

test("a stored state that is missing or junk starts open with nothing skipped", () => {
  const fresh = { mode: "open", none: [], last: "open" };
  assert.deepEqual(parseSetupState(null), fresh);
  assert.deepEqual(parseSetupState("{oops"), fresh);
  assert.deepEqual(parseSetupState("null"), fresh);
  assert.deepEqual(parseSetupState('{"mode":1,"none":{}}'), fresh);
});

test("a stored state keeps its mode and only known skipped steps", () => {
  assert.deepEqual(parseSetupState('{"mode":"later","none":["sms","nope","cards"],"last":"nothing"}'), {
    mode: "later",
    none: ["cards", "sms"],
    last: "nothing",
  });
});

test("the SMS step comes last and only when the app can read SMS", () => {
  assert.deepEqual(
    checklistSteps(server(), false, []).map((s) => s.key),
    ["bank", "cards", "loans", "recurring", "investments", "sms"],
  );
  assert.equal(checklistSteps(server(), null, []).length, 5);
});

test("each step opens the right screen, and only the bank can't be skipped", () => {
  const steps = checklistSteps(server(), false, []);
  assert.deepEqual(
    steps.map((s) => [s.key, s.target, s.canSkip]),
    [
      ["bank", { pathname: "/account-form", params: { type: "bank" } }, false],
      ["cards", { pathname: "/account-form", params: { type: "credit_card" } }, true],
      ["loans", { pathname: "/account-form", params: { type: "loan" } }, true],
      ["recurring", { pathname: "/template-form" }, true],
      ["investments", { pathname: "/investments" }, true],
      ["sms", { pathname: "/sms-settings" }, true],
    ],
  );
});

test("SMS reading turned on ticks the SMS step", () => {
  const sms = checklistSteps(server(), true, []).at(-1);
  assert.equal(sms.status, "done");
  assert.equal(statusText(sms), "On");
});

test("done beats not for me, and progress counts both", () => {
  const steps = checklistSteps(server(["bank", "cards"]), false, ["cards", "loans", "sms"]);
  assert.deepEqual(
    steps.map((s) => s.status),
    ["done", "done", "none", "todo", "todo", "none"],
  );
  assert.equal(progressText(steps), "4 of 6 done");
});

test("the checklist disappears once complete or hidden, and keeps its mode otherwise", () => {
  const partial = checklistSteps(server(["bank"]), false, []);
  assert.equal(shownAs(partial, "open"), "open");
  assert.equal(shownAs(partial, "later"), "later");
  assert.equal(shownAs(partial, "hidden"), "nothing");
  const complete = checklistSteps(server(["bank", "cards", "loans"]), true, ["recurring", "investments"]);
  assert.equal(shownAs(complete, "open"), "nothing");
});

test("row text: how many were added, skipped, or why it's worth doing", () => {
  const [bank, cards] = checklistSteps(
    [
      { key: "bank", done: true, count: 1 },
      { key: "cards", done: false, count: 0 },
    ],
    null,
    [],
  );
  assert.equal(statusText(bank), "1 added");
  assert.equal(statusText(cards), "See each bill and due date in time.");
  assert.equal(statusText({ ...cards, status: "none" }), "Skipped");
});

test("marking and unmarking a step as not for me", () => {
  const on = withNone({ mode: "later", none: ["sms"], last: "later" }, "loans", true);
  assert.deepEqual(on, { mode: "later", none: ["sms", "loans"], last: "later" });
  assert.deepEqual(withNone(on, "sms", false).none, ["loans"]);
});

test("each signed-in user has their own stored state, keyed by the id in their token", () => {
  assert.equal(setupKey(7), "gullak.setup.7");
  assert.equal(userIdFromToken("42.3.1790000000.c2lnbmF0dXJl"), 42);
  assert.equal(userIdFromToken(null), null);
  assert.equal(userIdFromToken("garbage"), null);
  assert.equal(userIdFromToken("0.1.2.3"), null);
});

test("while loading, space is held unless the checklist was gone last time or is hidden", () => {
  assert.equal(loadingShown(parseSetupState(null)), "placeholder");
  assert.equal(loadingShown({ mode: "later", none: [], last: "later" }), "placeholder");
  assert.equal(loadingShown({ mode: "open", none: [], last: "nothing" }), "nothing");
  assert.equal(loadingShown({ mode: "hidden", none: [], last: "open" }), "nothing");
});
