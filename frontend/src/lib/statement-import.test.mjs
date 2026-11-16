import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canSave,
  categoryOptions,
  changeType,
  changedFromSuggestion,
  counts,
  errorsByLine,
  fileType,
  filterOptions,
  importButton,
  initialRows,
  missingTransfers,
  offersRemember,
  otherAccounts,
  passwordProblem,
  previewFailure,
  previewUrl,
  savePayload,
  savedMessage,
  selectAllNew,
  selectNone,
  signedAmount,
  statementAccounts,
  summaryText,
  transferLabel,
  typeOptions,
  visibleRows,
} from "./statement-import.ts";

const line = (n, extra = {}) => ({
  line: n,
  date: "2026-11-10",
  narration: `UPI/SWIGGY/${n}`,
  amount: "250.00",
  direction: "out",
  balance: null,
  payee: "Swiggy",
  type: "expense",
  category: "Food",
  other_account_id: null,
  duplicate: false,
  errors: [],
  ...extra,
});

const preview = (lines) => ({ account_id: 7, lines, new: 0, duplicates: 0, problems: 0 });

const CATEGORIES = { expense: ["Food", "Shopping"], income: ["Salary", "Interest"] };

test("new lines start ticked; saved and unreadable lines don't", () => {
  const rows = initialRows(
    preview([line(2), line(3, { duplicate: true }), line(4, { errors: ["Date: couldn't read 'tomorrow'."] }), line(5, { category: null })]),
  );
  assert.deepEqual(
    rows.map((r) => r.include),
    [true, false, false, true],
  );
  assert.equal(rows[0].category, "Food");
  assert.equal(rows[3].category, "");
  assert.equal(rows[0].remember, false);
});

test("the type choices follow the direction", () => {
  assert.deepEqual(
    typeOptions("out").map((o) => o.value),
    ["expense", "transfer"],
  );
  assert.deepEqual(
    typeOptions("in").map((o) => o.value),
    ["income", "transfer"],
  );
  assert.equal(transferLabel("out"), "To");
  assert.equal(transferLabel("in"), "From");
});

test("changing the type clears what doesn't fit, and going back restores the suggestion", () => {
  const [row] = initialRows(preview([line(2)]));
  const moved = changeType(row, "transfer");
  assert.equal(moved.category, "");
  assert.equal(moved.other, "");
  const back = changeType(moved, "expense");
  assert.equal(back.category, "Food");

  const [transfer] = initialRows(preview([line(3, { type: "transfer", category: null, other_account_id: 9 })]));
  assert.equal(transfer.other, "9");
  assert.equal(changeType(changeType(transfer, "expense"), "transfer").other, "9");
});

test("remember is offered only for a corrected line with a payee", () => {
  const [row] = initialRows(preview([line(2)]));
  assert.equal(changedFromSuggestion(row), false);
  assert.equal(offersRemember(row), false);
  const recategorised = { ...row, category: "Shopping" };
  assert.equal(offersRemember(recategorised), true);
  assert.equal(offersRemember({ ...recategorised, line: { ...row.line, payee: null } }), false);
  assert.equal(offersRemember(changeType(row, "transfer")), true);

  const [transfer] = initialRows(preview([line(3, { type: "transfer", category: null, other_account_id: 9 })]));
  assert.equal(offersRemember(transfer), false);
  assert.equal(offersRemember({ ...transfer, other: "10" }), true);
});

test("category choices are the kind's, plus a suggestion not in the list", () => {
  const [row] = initialRows(preview([line(2, { category: "Pets" })]));
  assert.deepEqual(categoryOptions(row, CATEGORIES), ["Pets", "Food", "Shopping"]);
  assert.deepEqual(categoryOptions({ ...row, category: "" }, CATEGORIES), ["Food", "Shopping"]);
  const [income] = initialRows(preview([line(3, { direction: "in", type: "income", category: "Salary" })]));
  assert.deepEqual(categoryOptions(income, CATEGORIES), ["Salary", "Interest"]);
  assert.deepEqual(categoryOptions(changeType(row, "transfer"), CATEGORIES), []);
});

test("select all new and select none", () => {
  const rows = selectNone(initialRows(preview([line(2), line(3, { duplicate: true }), line(4, { errors: ["x"] })])));
  assert.deepEqual(
    rows.map((r) => r.include),
    [false, false, false],
  );
  assert.deepEqual(
    selectAllNew(rows.map((r) => ({ ...r, include: true }))).map((r) => r.include),
    [true, false, false],
  );
});

test("the filters", () => {
  const rows = initialRows(
    preview([
      line(2),
      line(3, { category: null }),
      line(4, { type: "transfer", category: null, other_account_id: 9 }),
      line(5, { duplicate: true }),
      line(6, { category: null, errors: ["x"] }),
    ]),
  );
  assert.deepEqual(
    visibleRows(rows, "uncategorised").map((r) => r.line.line),
    [3],
  );
  assert.deepEqual(
    visibleRows(rows, "transfers").map((r) => r.line.line),
    [4],
  );
  assert.deepEqual(
    visibleRows(rows, "duplicates").map((r) => r.line.line),
    [5],
  );
  assert.equal(visibleRows(rows, "all").length, 5);
  assert.deepEqual(
    filterOptions(rows).map((o) => o.label),
    ["All (5)", "Needs a category (1)", "Transfers (1)", "Already saved (1)"],
  );
});

test("the summary counts every line once", () => {
  const rows = initialRows(preview([line(2), line(3), line(4, { duplicate: true }), line(5, { errors: ["x"] })]));
  rows[1].include = false;
  const c = counts(rows);
  assert.deepEqual(c, { toImport: 1, alreadySaved: 1, skipped: 2 });
  assert.equal(summaryText(c), "1 to import · 1 already saved · 2 skipped");
  assert.equal(importButton(c), "Import 1 transaction");
  assert.equal(importButton({ toImport: 3, alreadySaved: 0, skipped: 0 }), "Import 3 transactions");
  rows[2].include = true; // keeping a duplicate anyway
  assert.deepEqual(counts(rows), { toImport: 2, alreadySaved: 0, skipped: 2 });
});

test("saving needs something ticked and every transfer's account", () => {
  const rows = initialRows(preview([line(2), line(3, { type: "transfer", category: null })]));
  assert.equal(missingTransfers(rows), 1);
  assert.equal(canSave(rows), false);
  rows[1].other = "9";
  assert.equal(canSave(rows), true);
  assert.equal(canSave(selectNone(rows)), false);
});

test("the payload is the ticked lines as edited", () => {
  const rows = initialRows(
    preview([
      line(2),
      line(3, { duplicate: true }),
      line(4, { errors: ["x"] }),
      line(5, { direction: "in", type: "income", category: "Refund", payee: "Amazon", narration: "NEFT AMAZON", amount: "99.50" }),
    ]),
  );
  rows[0] = { ...changeType(rows[0], "transfer"), other: "9", remember: true };
  rows[2].include = true; // unreadable: never sent
  rows[3] = { ...rows[3], category: "", remember: true }; // clearing the suggested category is a change too
  assert.deepEqual(savePayload(7, rows), {
    account_id: 7,
    lines: [
      {
        line: 2,
        date: "2026-11-10",
        narration: "UPI/SWIGGY/2",
        amount: "250.00",
        direction: "out",
        type: "transfer",
        category: null,
        other_account_id: 9,
        payee: "Swiggy",
        remember: true,
      },
      {
        line: 5,
        date: "2026-11-10",
        narration: "NEFT AMAZON",
        amount: "99.50",
        direction: "in",
        type: "income",
        category: null,
        other_account_id: null,
        payee: "Amazon",
        remember: true,
      },
    ],
  });
});

test("remember is sent only where it is offered", () => {
  const rows = initialRows(preview([line(2)]));
  rows[0].remember = true; // left over from a change since undone
  assert.equal(savePayload(7, rows).lines[0].remember, false);
});

test("after saving", () => {
  assert.equal(savedMessage({ imported: 12, rules_saved: 0, errors: [] }), "Added 12 transactions.");
  assert.equal(savedMessage({ imported: 1, rules_saved: 2, errors: [] }), "Added 1 transaction. Saved 2 payee rules.");
  assert.equal(savedMessage({ imported: 3, rules_saved: 1, errors: [] }), "Added 3 transactions. Saved 1 payee rule.");
  const byLine = errorsByLine({ imported: 0, rules_saved: 0, errors: [{ line: 4, errors: ["Category: too long."] }] });
  assert.deepEqual(byLine.get(4), ["Category: too long."]);
  assert.equal(byLine.get(5), undefined);
});

test("amounts are signed by direction", () => {
  assert.equal(signedAmount({ amount: "1250.00", direction: "out" }), "-₹1,250.00");
  assert.equal(signedAmount({ amount: "125000.50", direction: "in" }), "+₹1,25,000.50");
});

test("statement accounts and transfer accounts", () => {
  const acct = (id, type, archived = false) => ({ id, type, name: `A${id}`, archived });
  const all = [acct(1, "bank"), acct(2, "credit_card"), acct(3, "fd"), acct(4, "loan"), acct(5, "wallet", true), acct(6, "broker"), acct(7, "cash")];
  assert.deepEqual(
    statementAccounts(all).map((a) => a.id),
    [1, 2, 6, 7],
  );
  assert.deepEqual(
    otherAccounts(all, 1).map((a) => a.id),
    [2, 3, 4, 6, 7],
  );
});

test("the file is sent as itself", () => {
  assert.equal(previewUrl(12), "/api/import/statement/preview?account_id=12");
  assert.equal(fileType({ type: "text/csv" }), "text/csv");
  assert.equal(fileType({ type: "" }), "application/octet-stream");
});

test("a locked PDF asks for its password", () => {
  const locked = previewFailure(422, JSON.stringify({ detail: "This PDF is locked.", needs_password: true, wrong_password: false }));
  assert.deepEqual(locked, { kind: "password", wrong: false, message: "This PDF is locked." });
  const wrong = previewFailure(422, JSON.stringify({ detail: "Wrong password.", needs_password: true, wrong_password: true }));
  assert.equal(wrong.kind, "password");
  assert.equal(wrong.wrong, true);
  assert.match(wrong.message, /didn't open/);
});

test("other preview failures show the server's words", () => {
  assert.deepEqual(previewFailure(422, JSON.stringify({ detail: "No transactions found in this file." })), {
    kind: "error",
    message: "No transactions found in this file.",
  });
  assert.match(previewFailure(404, JSON.stringify({ detail: "Account not found." })).message, /account wasn't found/);
  assert.match(previewFailure(413, "<html>").message, /over 4 MB/);
  assert.match(previewFailure(401, "").message, /signed out/);
  assert.match(previewFailure(500, "oops").message, /Try again/);
});

test("a password must fit in a header", () => {
  assert.equal(passwordProblem("01011990"), null);
  assert.equal(passwordProblem("ABCD1234@x"), null);
  assert.match(passwordProblem(""), /Type the file's password/);
  assert.match(passwordProblem("pässword"), /plain letters/);
});
