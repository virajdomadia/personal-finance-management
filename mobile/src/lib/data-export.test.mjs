import assert from "node:assert/strict";
import { test } from "node:test";

import { EXPORTS, exportError, fileNameFrom } from "./data-export.ts";

test("file name comes from the attachment header", () => {
  assert.equal(fileNameFrom('attachment; filename="pfm-export-2026-11-13.zip"', "x"), "pfm-export-2026-11-13.zip");
  assert.equal(fileNameFrom(null, EXPORTS.backup.fallback), "pfm-backup.json");
  assert.equal(fileNameFrom('attachment; filename="../x.sh"', "pfm-export.zip"), "pfm-export.zip");
});

test("each export has its API path and type", () => {
  assert.deepEqual(
    [EXPORTS.csv.path, EXPORTS.csv.mimeType, EXPORTS.backup.path, EXPORTS.backup.mimeType],
    ["/export/csv", "application/zip", "/export/backup", "application/json"],
  );
});

test("errors are worded for people", () => {
  assert.match(exportError(401), /signed out/);
  assert.match(exportError(null), /connection/);
  assert.match(exportError(500), /didn't work/);
});
