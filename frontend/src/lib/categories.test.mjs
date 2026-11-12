import assert from "node:assert/strict";
import { test } from "node:test";

import { categoryPayload, iconEmoji, mergeTargets, mergeText, parentOptions, splitArchived } from "./categories.ts";

const cat = (id, name, extra = {}) => ({
  id,
  kind: "expense",
  name,
  parent_id: null,
  icon: null,
  colour: null,
  archived: false,
  fixed: false,
  transaction_count: 0,
  ...extra,
});

const food = cat(1, "Food");
const dining = cat(2, "Dining", { parent_id: 1 });
const fuel = cat(3, "Fuel");
const old = cat(4, "Old", { archived: true });
const list = [food, dining, fuel, old];

test("iconEmoji falls back to a tag", () => {
  assert.equal(iconEmoji("food"), "🍔");
  assert.equal(iconEmoji(null), "🏷️");
  assert.equal(iconEmoji("rocket"), "🏷️");
});

test("parentOptions are live top-level ones other than itself", () => {
  assert.deepEqual(
    parentOptions(list, fuel).map((c) => c.name),
    ["Food"],
  );
  assert.deepEqual(
    parentOptions(list, null).map((c) => c.name),
    ["Food", "Fuel"],
  );
});

test("mergeTargets follow the server's rules", () => {
  assert.deepEqual(
    mergeTargets(list, food).map((c) => c.name),
    ["Fuel"],
  );
  assert.deepEqual(
    mergeTargets(list, fuel).map((c) => c.name),
    ["Food", "Dining"],
  );
});

test("mergeText", () => {
  assert.equal(
    mergeText({ category: food, moved_transactions: 12, moved_templates: 1, moved_rules: 2 }),
    "Moved 12 transactions, 1 reminder and 2 payee rules into Food.",
  );
});

test("splitArchived", () => {
  const { live, archived } = splitArchived(list);
  assert.equal(live.length, 3);
  assert.deepEqual(
    archived.map((c) => c.name),
    ["Old"],
  );
});

test("categoryPayload sends everything on create and only changes on edit", () => {
  const form = { name: " Snacks ", parent_id: "1", icon: "food", colour: "" };
  assert.deepEqual(categoryPayload(form, null, "expense"), {
    kind: "expense",
    name: "Snacks",
    parent_id: 1,
    icon: "food",
    colour: null,
  });
  assert.deepEqual(categoryPayload({ name: "Dining", parent_id: "", icon: "", colour: "#4cb944" }, dining, "expense"), {
    parent_id: null,
    colour: "#4cb944",
  });
});
