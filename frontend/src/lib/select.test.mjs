import assert from "node:assert/strict";
import { test } from "node:test";

import { filterOptions, moveActive, popupPosition, typeaheadMatch } from "./select.ts";

const options = [
  { value: "1", label: "HDFC Savings" },
  { value: "2", label: "Regalia Card" },
  { value: "3", label: "Rent Wallet" },
];

test("moveActive stops at both ends instead of wrapping", () => {
  assert.equal(moveActive(0, 1, 3), 1);
  assert.equal(moveActive(2, 1, 3), 2);
  assert.equal(moveActive(0, -1, 3), 0);
});

test("moveActive enters from nothing highlighted", () => {
  assert.equal(moveActive(-1, 1, 3), 0);
  assert.equal(moveActive(-1, -1, 3), 2);
});

test("moveActive has nowhere to go in an empty list", () => {
  assert.equal(moveActive(-1, 1, 0), -1);
});

test("typeaheadMatch finds a label by its start, ignoring case", () => {
  assert.equal(typeaheadMatch(options, "reg", 0), 1);
  assert.equal(typeaheadMatch(options, "HDFC", 2), 0);
});

test("typeaheadMatch searches onward from the current option", () => {
  assert.equal(typeaheadMatch(options, "r", 0), 1);
  assert.equal(typeaheadMatch(options, "r", 1), 2);
  assert.equal(typeaheadMatch(options, "r", 2), 1);
});

test("typeaheadMatch returns -1 when nothing starts that way", () => {
  assert.equal(typeaheadMatch(options, "z", 0), -1);
});

test("filterOptions keeps labels containing the text", () => {
  assert.deepEqual(filterOptions(options, "card").map((o) => o.value), ["2"]);
  assert.deepEqual(filterOptions(options, "  WALLET ").map((o) => o.value), ["3"]);
});

test("filterOptions shows everything for empty text or an exact match", () => {
  assert.equal(filterOptions(options, "").length, 3);
  assert.equal(filterOptions(options, "regalia card").length, 3);
});

const viewport = { width: 1000, height: 800 };
const trigger = { top: 100, bottom: 140, left: 50, width: 300 };

test("popupPosition opens below the trigger when there's room", () => {
  assert.deepEqual(popupPosition({ trigger, popupHeight: 200, viewport }), {
    top: 144,
    left: 50,
    width: 300,
    maxHeight: 240,
  });
});

test("popupPosition flips above when below is too short and above has more room", () => {
  const low = { ...trigger, top: 700, bottom: 740 };
  const position = popupPosition({ trigger: low, popupHeight: 200, viewport });
  assert.equal(position.top, 496);
});

test("popupPosition shrinks to the space available rather than running off screen", () => {
  const short = { width: 1000, height: 300 };
  const position = popupPosition({ trigger, popupHeight: 400, viewport: short });
  assert.equal(position.top, 144);
  assert.equal(position.maxHeight, 148);
});

test("popupPosition keeps the list inside narrow screens", () => {
  const position = popupPosition({ trigger: { ...trigger, left: 200 }, popupHeight: 100, viewport: { width: 390, height: 800 } });
  assert.equal(position.left, 82);
});
