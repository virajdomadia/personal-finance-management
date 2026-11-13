import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CATEGORY_PALETTE,
  categoryErrors,
  categoryFormBlank,
  categoryFormFrom,
  categoryPayload,
  categorySections,
  colourOf,
  iconName,
  inkOn,
  mergeTargets,
  mergedText,
  nest,
  parentOptions,
  pickerGroups,
  restrictGroups,
  sameName,
  usageText,
} from "./categories.ts";

let nextId = 1;
const cat = (o = {}) => ({
  id: nextId++,
  kind: "expense",
  name: "Groceries",
  parent_id: null,
  icon: "groceries",
  colour: "#4cb944",
  archived: false,
  fixed: false,
  transaction_count: 0,
  ...o,
});

// Food (with Restaurants, Snacks), Transport, Old (archived), Pets (archived, with Vet archived).
function tree() {
  const food = cat({ id: 1, name: "Food" });
  const restaurants = cat({ id: 2, name: "Restaurants", parent_id: 1 });
  const snacks = cat({ id: 3, name: "Snacks", parent_id: 1, archived: true });
  const transport = cat({ id: 4, name: "Transport" });
  const old = cat({ id: 5, name: "Old", archived: true });
  const insurance = cat({ id: 6, name: "Insurance", fixed: true });
  return [food, restaurants, snacks, transport, old, insurance];
}

test("iconName maps the server's keys and falls back to a tag", () => {
  assert.equal(iconName("food"), "silverware-fork-knife");
  assert.equal(iconName("savings"), "piggy-bank");
  assert.equal(iconName("rocket"), "tag");
  assert.equal(iconName(null), "tag");
  assert.equal(iconName(undefined), "tag");
});

test("colourOf keeps a valid hex and falls back to grey", () => {
  assert.equal(colourOf("#F3A712"), "#f3a712");
  assert.equal(colourOf(null), "#8a8a8a");
  assert.equal(colourOf("red"), "#8a8a8a");
});

test("inkOn picks ink on light colours and white on dark ones", () => {
  assert.equal(inkOn("#f3a712"), true);
  assert.equal(inkOn("#ffffff"), true);
  assert.equal(inkOn("#29335c"), false);
  assert.equal(inkOn("#000000"), false);
});

test("the palette is a dozen or so distinct lowercase colours", () => {
  assert.ok(CATEGORY_PALETTE.length >= 12);
  assert.equal(new Set(CATEGORY_PALETTE).size, CATEGORY_PALETTE.length);
  for (const c of CATEGORY_PALETTE) assert.match(c, /^#[0-9a-f]{6}$/);
});

test("nest puts subcategories under their parent and an orphan on its own", () => {
  const groups = nest([cat({ id: 10, name: "A" }), cat({ id: 11, name: "A1", parent_id: 10 }), cat({ id: 12, name: "B1", parent_id: 99 })]);
  assert.deepEqual(
    groups.map((g) => [g.parent.name, g.children.map((c) => c.name)]),
    [
      ["A", ["A1"]],
      ["B1", []],
    ],
  );
});

test("pickerGroups leaves archived categories out", () => {
  const groups = pickerGroups(tree());
  assert.deepEqual(
    groups.map((g) => [g.parent.name, g.children.map((c) => c.name)]),
    [
      ["Food", ["Restaurants"]],
      ["Transport", []],
      ["Insurance", []],
    ],
  );
});

test("restrictGroups keeps only allowed names and adds unknown ones", () => {
  const groups = pickerGroups(tree());
  assert.deepEqual(
    restrictGroups(groups, ["transport"]).map((g) => g.parent.name),
    ["Transport"],
  );
  // A subcategory without its parent stands alone.
  assert.deepEqual(
    restrictGroups(groups, ["Restaurants"]).map((g) => [g.parent.name, g.children.length]),
    [["Restaurants", 0]],
  );
  const added = restrictGroups([], ["Interest", "interest"]);
  assert.equal(added.length, 1);
  assert.equal(added[0].parent.name, "Interest");
  assert.equal(added[0].parent.id, -1);
});

test("sameName ignores case and spaces", () => {
  assert.equal(sameName(" food ", "Food"), true);
  assert.equal(sameName("Food", "Fuel"), false);
});

test("categorySections splits live and archived", () => {
  const { live, archived } = categorySections(tree());
  assert.deepEqual(live.map((g) => g.parent.name), ["Food", "Transport", "Insurance"]);
  assert.deepEqual(archived.map((c) => c.name), ["Snacks", "Old"]);
});

test("usageText", () => {
  assert.equal(usageText(0), "Not used yet");
  assert.equal(usageText(1), "1 transaction");
  assert.equal(usageText(12), "12 transactions");
});

test("parentOptions offers live top-level categories of the kind, not itself", () => {
  const list = [...tree(), cat({ id: 7, name: "Salary", kind: "income" })];
  const transport = list.find((c) => c.id === 4);
  assert.deepEqual(parentOptions(list, transport, "expense").map((c) => c.name), ["Food", "Insurance"]);
  assert.deepEqual(parentOptions(list, null, "income").map((c) => c.name), ["Salary"]);
  // A category with subcategories of its own stays top level.
  const food = list.find((c) => c.id === 1);
  assert.deepEqual(parentOptions(list, food, "expense"), []);
});

test("mergeTargets leaves out itself, archived ones and its own subcategories", () => {
  const list = tree();
  const food = list.find((c) => c.id === 1);
  assert.deepEqual(mergeTargets(list, food).map((c) => c.name), ["Transport", "Insurance"]);
  const transport = list.find((c) => c.id === 4);
  assert.deepEqual(mergeTargets(list, transport).map((c) => c.name), ["Food", "Restaurants", "Insurance"]);
});

test("mergedText words the moved counts", () => {
  const into = cat({ name: "Food" });
  assert.equal(
    mergedText({ category: into, moved_transactions: 12, moved_templates: 1, moved_rules: 2 }),
    "Moved 12 transactions, 1 reminder and 2 payee rules into Food.",
  );
  assert.equal(
    mergedText({ category: into, moved_transactions: 1, moved_templates: 0, moved_rules: 0 }),
    "Moved 1 transaction into Food.",
  );
  assert.equal(
    mergedText({ category: into, moved_transactions: 0, moved_templates: 0, moved_rules: 0 }),
    "Nothing needed moving into Food.",
  );
});

test("categoryPayload sends a new category's set fields", () => {
  const form = { ...categoryFormBlank("income"), name: " Bonus ", colour: "#2e9e5b" };
  assert.deepEqual(categoryPayload(form, null), { kind: "income", name: "Bonus", colour: "#2e9e5b" });
  assert.deepEqual(categoryPayload(categoryFormBlank("expense"), null), { kind: "expense", name: null });
});

test("categoryPayload sends only what changed on an edit", () => {
  const original = cat({ id: 20, name: "Fuel", icon: "fuel", colour: "#e4572e", parent_id: null });
  const form = categoryFormFrom(original);
  assert.deepEqual(categoryPayload(form, original), {});
  assert.deepEqual(categoryPayload({ ...form, name: "Petrol", parent_id: 4 }, original), { name: "Petrol", parent_id: 4 });
  assert.deepEqual(categoryPayload({ ...form, icon: null }, original), { icon: null });
  // Taking it out of its parent sends an explicit null.
  const nested = cat({ id: 21, parent_id: 4 });
  assert.deepEqual(categoryPayload({ ...categoryFormFrom(nested), parent_id: null }, nested), { parent_id: null });
});

test("categoryPayload never renames a fixed category", () => {
  const fixed = cat({ name: "Insurance", fixed: true });
  assert.deepEqual(categoryPayload({ ...categoryFormFrom(fixed), name: "Cover", colour: "#000000" }, fixed), {
    colour: "#000000",
  });
});

test("categoryErrors", () => {
  assert.deepEqual(categoryErrors({ ...categoryFormBlank("expense"), name: "  " }), { name: "Enter a name." });
  assert.deepEqual(categoryErrors({ ...categoryFormBlank("expense"), name: "x".repeat(41) }), {
    name: "Use 40 characters or fewer.",
  });
  assert.deepEqual(categoryErrors({ ...categoryFormBlank("expense"), name: "Pets" }), {});
});
