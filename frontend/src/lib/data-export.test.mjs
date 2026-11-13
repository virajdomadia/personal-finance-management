import assert from "node:assert/strict";
import { test } from "node:test";

import { EXPORTS, downloadError, fileNameFrom } from "./data-export.ts";

test("file name comes from the attachment header", () => {
  assert.equal(fileNameFrom('attachment; filename="pfm-export-2026-11-13.zip"', "x.zip"), "pfm-export-2026-11-13.zip");
  assert.equal(fileNameFrom("attachment; filename=pfm-backup-2026-11-13.json", "x.json"), "pfm-backup-2026-11-13.json");
});

test("a missing or odd name falls back", () => {
  assert.equal(fileNameFrom(null, EXPORTS.csv.fallback), "pfm-export.zip");
  assert.equal(fileNameFrom('attachment; filename="../../evil.sh"', "pfm-backup.json"), "pfm-backup.json");
});

test("downloads go through the /api proxy", () => {
  assert.equal(EXPORTS.backup.path, "/api/export/backup");
  assert.equal(EXPORTS.csv.path, "/api/export/csv");
});

test("errors are worded for people", () => {
  assert.match(downloadError(401), /signed out/);
  assert.match(downloadError(500), /didn't work/);
});
