import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checklistSteps,
  parseSetupState,
  progressText,
  setupKey,
  shownAs,
  statusText,
  withNone,
} from "./setup.ts";

const server = (done = []) =>
  ["bank", "cards", "loans", "recurring", "investments"].map((key) => ({
    key,
    done: done.includes(key),
    count: done.includes(key) ? 2 : 0,
  }));

test("a stored state that is missing or junk starts open with nothing skipped", () => {
  const fresh = { mode: "open", none: [] };
  assert.deepEqual(parseSetupState(null), fresh);
  assert.deepEqual(parseSetupState("not json"), fresh);
  assert.deepEqual(parseSetupState("42"), fresh);
  assert.deepEqual(parseSetupState('{"mode":"weird","none":"cards"}'), fresh);
});

test("a stored state keeps its mode and only known skipped steps", () => {
  assert.deepEqual(parseSetupState('{"mode":"later","none":["loans","sms","cards"]}'), {
    mode: "later",
    none: ["cards", "loans"],
  });
  assert.equal(parseSetupState('{"mode":"hidden"}').mode, "hidden");
});

test("steps keep the server's order, link to the add dialogs and only the bank can't be skipped", () => {
  const steps = checklistSteps(server(["bank"]), ["loans"]);
  assert.deepEqual(
    steps.map((s) => [s.key, s.status, s.canSkip, s.href]),
    [
      ["bank", "done", false, "/accounts?add=bank"],
      ["cards", "todo", true, "/accounts?add=credit_card"],
      ["loans", "none", true, "/accounts?add=loan"],
      ["recurring", "todo", true, "/recurring?add=1"],
      ["investments", "todo", true, "/investments"],
    ],
  );
});

test("a step done after saying 'I don't have one' shows as done", () => {
  assert.equal(checklistSteps(server(["cards"]), ["cards"])[1].status, "done");
});

test("progress counts done and skipped steps", () => {
  assert.equal(progressText(checklistSteps(server(["bank", "cards"]), ["loans"])), "3 of 5 done");
  assert.equal(progressText(checklistSteps(server(), [])), "0 of 5 done");
});

test("the checklist disappears once complete or hidden, and keeps its mode otherwise", () => {
  const partial = checklistSteps(server(["bank"]), []);
  assert.equal(shownAs(partial, "open"), "open");
  assert.equal(shownAs(partial, "later"), "later");
  assert.equal(shownAs(partial, "hidden"), "nothing");
  const complete = checklistSteps(server(["bank", "cards", "investments"]), ["loans", "recurring"]);
  assert.equal(shownAs(complete, "open"), "nothing");
  assert.equal(shownAs([], "open"), "nothing");
});

test("each row says how many were added, that it's skipped, or why it's worth doing", () => {
  const [bank, cards, loans] = checklistSteps(
    [
      { key: "bank", done: true, count: 1 },
      { key: "cards", done: true, count: 3 },
      { key: "loans", done: false, count: 0 },
    ],
    [],
  );
  assert.equal(statusText(bank), "1 added");
  assert.equal(statusText(cards), "3 added");
  assert.equal(statusText(loans), "Keep track of EMIs and how much is left to pay.");
  assert.equal(statusText({ ...loans, status: "none" }), "Skipped. Undo if that changes.");
});

test("marking and unmarking a step as not for me", () => {
  const on = withNone({ mode: "open", none: ["cards"] }, "loans", true);
  assert.deepEqual(on, { mode: "open", none: ["cards", "loans"] });
  assert.deepEqual(withNone(on, "loans", true).none, ["cards", "loans"]);
  assert.deepEqual(withNone(on, "cards", false), { mode: "open", none: ["loans"] });
});

test("each signed-in user has their own stored state", () => {
  assert.equal(setupKey(7), "gullak.setup.7");
  assert.notEqual(setupKey(7), setupKey(8));
});
