import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IMPORTS,
  IMPORT_PATHS,
  XLSX_TYPE,
  accountsLabel,
  amountLabel,
  canImport,
  dateLabel,
  holdingLabel,
  importButton,
  importError,
  importedMessage,
  previewSummary,
  statusLabel,
  summaryCounts,
  visibleRows,
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

test("imports go through the /api proxy as raw xlsx", () => {
  assert.equal(IMPORT_PATHS.preview, "/api/import/transactions/preview");
  assert.equal(IMPORT_PATHS.import, "/api/import/transactions");
  assert.equal(IMPORT_PATHS.template, "/api/import/transactions/template");
  assert.equal(XLSX_TYPE, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("the counts are labelled in order", () => {
  assert.deepEqual(
    summaryCounts(report({ ok: 3, duplicates: 1, problems: 2 })).map((c) => [c.label, c.count]),
    [
      ["Ready to add", 3],
      ["Already saved, skipped", 1],
      ["With problems", 2],
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

test("the filter keeps just the problem rows", () => {
  const rows = [row(2, "ok"), row(3, "error", { errors: ["Account: no account called Nowhere."] }), row(4, "duplicate")];
  assert.equal(visibleRows(rows, "all").length, 3);
  assert.deepEqual(
    visibleRows(rows, "problems").map((r) => r.row),
    [3],
  );
});

test("file errors show the server's words", () => {
  assert.equal(importError(422, JSON.stringify({ detail: "This isn't an Excel file (.xlsx)." })), "This isn't an Excel file (.xlsx).");
  assert.equal(importError(400, JSON.stringify({ detail: "Choose an Excel file (.xlsx)." })), "Choose an Excel file (.xlsx).");
  assert.match(importError(413, "<html>too big</html>"), /over 4 MB/);
  assert.match(importError(401, ""), /signed out/);
  assert.match(importError(500, "oops"), /Try again/);
  assert.match(importError(422, JSON.stringify({ detail: [{ msg: "x" }] })), /Try again/);
});

test("holdings have their own template and endpoints", () => {
  assert.equal(IMPORTS.holdings.paths.template, "/api/import/holdings/template");
  assert.equal(IMPORTS.holdings.paths.preview, "/api/import/holdings/preview");
  assert.equal(IMPORTS.holdings.paths.import, "/api/import/holdings");
  assert.equal(IMPORTS.holdings.fallback, "pfm-holdings-template.xlsx");
  assert.deepEqual(IMPORTS.transactions.paths, IMPORT_PATHS);
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

test("a holding reads as its name and symbol", () => {
  assert.equal(holdingLabel({ name: "Infosys", symbol: "INFY" }), "Infosys (INFY)");
  assert.equal(holdingLabel({ name: "BTC", symbol: "btc" }), "BTC");
  assert.equal(holdingLabel({ name: "Parag Parikh Flexi Cap", symbol: null }), "Parag Parikh Flexi Cap");
  assert.equal(holdingLabel({ name: null, symbol: "INFY" }), "INFY");
  assert.equal(holdingLabel({ name: null, symbol: null }), "—");
});

test("the problem filter works on holding rows too", () => {
  const rows = [
    { row: 2, status: "ok", errors: [] },
    { row: 3, status: "error", errors: ["Account: Stocks need a broker account."] },
  ];
  assert.deepEqual(visibleRows(rows, "problems").map((r) => r.row), [3]);
});
