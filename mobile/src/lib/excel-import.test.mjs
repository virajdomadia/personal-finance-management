import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IMPORTS,
  MAX_FILE_BYTES,
  XLSX_TYPE,
  accountsLabel,
  amountLabel,
  canImport,
  dateLabel,
  fileTooBig,
  hasExtension,
  holdingLabel,
  importButton,
  importError,
  importKind,
  importedMessage,
  previewSummary,
  problemLines,
  rowCard,
  statusLabel,
  summaryCounts,
} from "./excel-import.ts";

const row = (n, status, extra = {}) => ({
  row: n,
  date: "2026-11-16",
  type: "expense",
  amount: "250",
  account: "HDFC",
  to_account: null,
  category: "Food",
  note: null,
  status,
  errors: [],
  ...extra,
});

const report = (over = {}) => ({ rows: [], ok: 0, duplicates: 0, problems: 0, imported: 0, ...over });

test("imports go to the API as raw xlsx", () => {
  assert.equal(IMPORTS.transactions.paths.preview, "/import/transactions/preview");
  assert.equal(IMPORTS.transactions.paths.import, "/import/transactions");
  assert.equal(IMPORTS.transactions.paths.template, "/import/transactions/template");
  assert.equal(IMPORTS.transactions.fallback, "pfm-transactions-template.xlsx");
  assert.equal(XLSX_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("holdings have their own template and endpoints", () => {
  assert.equal(IMPORTS.holdings.paths.template, "/import/holdings/template");
  assert.equal(IMPORTS.holdings.paths.preview, "/import/holdings/preview");
  assert.equal(IMPORTS.holdings.paths.import, "/import/holdings");
  assert.equal(IMPORTS.holdings.fallback, "pfm-holdings-template.xlsx");
});

test("the screen's kind param picks the import", () => {
  assert.equal(importKind("holdings"), "holdings");
  assert.equal(importKind("transactions"), "transactions");
  assert.equal(importKind(undefined), "transactions");
  assert.equal(importKind(["holdings"]), "transactions");
});

test("files over 4 MB are stopped before sending", () => {
  assert.equal(MAX_FILE_BYTES, 4 * 1024 * 1024);
  assert.equal(fileTooBig(MAX_FILE_BYTES), false);
  assert.equal(fileTooBig(MAX_FILE_BYTES + 1), true);
  assert.equal(fileTooBig(undefined), false);
  assert.equal(hasExtension("Statement.XLSX", [".xlsx"]), true);
  assert.equal(hasExtension("statement.xls", [".xlsx"]), false);
});

test("the counts are labelled in order", () => {
  assert.deepEqual(
    summaryCounts(report({ ok: 3, duplicates: 1, problems: 2 })).map((c) => [c.label, c.count]),
    [
      ["Ready to add", 3],
      ["Already saved", 1],
      ["Problems", 2],
    ],
  );
});

test("the summary says what happens next", () => {
  assert.match(previewSummary(report({ ok: 3, problems: 1 })), /Fix the 1 row with problems/);
  assert.match(previewSummary(report({ ok: 3, problems: 2 })), /2 rows with problems/);
  assert.equal(previewSummary(report({ ok: 1 })), "1 transaction ready to add.");
  assert.equal(previewSummary(report({ ok: 4, duplicates: 2 })), "4 transactions ready to add. 2 rows already saved will be skipped.");
  assert.match(previewSummary(report({ duplicates: 2 })), /already saved/);
  assert.match(previewSummary(report()), /nothing to add/);
});

test("importing needs no problems and something to add", () => {
  assert.equal(canImport(null), false);
  assert.equal(canImport(report({ ok: 2, problems: 1 })), false);
  assert.equal(canImport(report({ duplicates: 2 })), false);
  assert.equal(canImport(report({ ok: 2, duplicates: 1 })), true);
  assert.equal(importButton(report({ ok: 2 })), "Import 2 transactions");
  assert.equal(importButton(report({ ok: 1 })), "Import 1 transaction");
  assert.equal(importButton(report({ ok: 5, problems: 1 })), "Import 0 transactions");
  assert.equal(importButton(null), "Import 0 transactions");
});

test("the result counts what was added and skipped", () => {
  assert.equal(importedMessage(report({ ok: 3, imported: 3 })), "Added 3 transactions.");
  assert.equal(importedMessage(report({ ok: 1, imported: 1, duplicates: 2 })), "Added 1 transaction. Skipped 2 duplicates already saved.");
});

test("the wording names holdings for a holdings import", () => {
  assert.equal(previewSummary(report({ ok: 1 }), "holdings"), "1 holding ready to add.");
  assert.equal(previewSummary(report({ ok: 3, duplicates: 1 }), "holdings"), "3 holdings ready to add. 1 row already saved will be skipped.");
  assert.match(previewSummary(report({ ok: 3, problems: 1 }), "holdings"), /Fix the 1 row/);
  assert.equal(importButton(report({ ok: 2 }), "holdings"), "Import 2 holdings");
  assert.equal(importButton(report({ ok: 2, problems: 1 }), "holdings"), "Import 0 holdings");
  assert.equal(importedMessage(report({ imported: 1 }), "holdings"), "Added 1 holding.");
  assert.equal(importedMessage(report({ imported: 2, duplicates: 1 }), "holdings"), "Added 2 holdings. Skipped 1 duplicate already saved.");
});

test("rows are labelled for people", () => {
  assert.equal(statusLabel("ok"), "Ready");
  assert.equal(statusLabel("duplicate"), "Already saved");
  assert.equal(statusLabel("error"), "Problem");
  assert.equal(accountsLabel({ account: "HDFC", to_account: null }), "HDFC");
  assert.equal(accountsLabel({ account: "HDFC", to_account: "Wallet" }), "HDFC → Wallet");
  assert.equal(accountsLabel({ account: null, to_account: null }), "—");
  assert.equal(dateLabel("2026-11-16"), "16 Nov 2026");
  assert.equal(dateLabel("someday"), "someday");
  assert.equal(dateLabel(null), "—");
  assert.equal(amountLabel("125000.5"), "₹1,25,000.5");
  assert.equal(amountLabel("lots"), "lots");
  assert.equal(amountLabel(null), "—");
});

test("a holding reads as its name and symbol", () => {
  assert.equal(holdingLabel({ name: "Infosys", symbol: "INFY" }), "Infosys (INFY)");
  assert.equal(holdingLabel({ name: "BTC", symbol: "btc" }), "BTC");
  assert.equal(holdingLabel({ name: "Parag Parikh Flexi Cap", symbol: null }), "Parag Parikh Flexi Cap");
  assert.equal(holdingLabel({ name: null, symbol: "INFY" }), "INFY");
  assert.equal(holdingLabel({ name: null, symbol: null }), "—");
});

test("what to fix lists every problem by row", () => {
  const rows = [
    row(2, "ok"),
    row(3, "error", { errors: ["Account: no account called Nowhere.", "Amount: must be more than 0."] }),
    row(5, "error", { errors: ["Date: couldn't read 'soon'."] }),
  ];
  assert.deepEqual(problemLines(rows), [
    "Row 3: Account: no account called Nowhere.",
    "Row 3: Amount: must be more than 0.",
    "Row 5: Date: couldn't read 'soon'.",
  ]);
  assert.deepEqual(problemLines([row(2, "ok")]), []);
});

test("a row reads as a compact card", () => {
  assert.deepEqual(rowCard("transactions", row(2, "ok")), {
    title: "Food",
    amount: "₹250",
    meta: "16 Nov 2026 · expense · HDFC · Food",
  });
  assert.deepEqual(rowCard("transactions", row(3, "error", { date: null, category: null, amount: null, account: null })).amount, "—");
  assert.deepEqual(
    rowCard("holdings", {
      row: 2,
      status: "ok",
      errors: [],
      type: "stock",
      name: "Infosys",
      symbol: "INFY",
      account: "Zerodha",
      quantity: "10",
      invested: "15000.00",
      date: null,
    }),
    { title: "Infosys (INFY)", amount: "₹15,000.00", meta: "stock · 10 units · Zerodha" },
  );
});

test("file errors show the server's words", () => {
  assert.equal(importError(422, "This isn't an Excel file (.xlsx)."), "This isn't an Excel file (.xlsx).");
  assert.equal(importError(400, "Choose an Excel file (.xlsx)."), "Choose an Excel file (.xlsx).");
  assert.match(importError(413, undefined), /over 4 MB/);
  assert.match(importError(401, undefined), /signed out/);
  assert.match(importError(500, "oops"), /Try again/);
  assert.match(importError(422, [{ msg: "x" }]), /Try again/);
  assert.match(importError(0, "Couldn't reach the server. Check your connection and try again."), /Couldn't reach/);
});
