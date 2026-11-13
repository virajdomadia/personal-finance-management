import assert from "node:assert/strict";
import { test } from "node:test";

import { EXPORTS, ExportError, exportError, fileNameFrom, isExportFile } from "./data-export.ts";

test("file name comes from the attachment header", () => {
  assert.equal(fileNameFrom('attachment; filename="pfm-export-2026-11-13.zip"', "x"), "pfm-export-2026-11-13.zip");
  assert.equal(fileNameFrom('attachment; filename="pfm-backup-2026-11-13.json.gz"', "x"), "pfm-backup-2026-11-13.json.gz");
  assert.equal(fileNameFrom(null, EXPORTS.backup.fallback), "pfm-backup.json.gz");
  assert.equal(fileNameFrom('attachment; filename="../x.sh"', "pfm-export.zip"), "pfm-export.zip");
});

test("each export has its API path and type", () => {
  assert.deepEqual(
    [EXPORTS.csv.path, EXPORTS.csv.mimeType, EXPORTS.backup.path, EXPORTS.backup.mimeType],
    ["/export/csv", "application/zip", "/export/backup", "application/gzip"],
  );
});

test("only earlier exports are cleared from the cache", () => {
  assert.ok(isExportFile("pfm-export-2026-11-13.zip"));
  assert.ok(isExportFile("pfm-backup-2026-11-13.json.gz"));
  assert.ok(isExportFile("pfm-backup.json"));
  assert.ok(!isExportFile("ImagePicker.jpg"));
  assert.ok(!isExportFile("pfm-notes.txt"));
});

test("errors say what really went wrong", () => {
  assert.match(exportError({ stage: "server", status: 401 }), /signed out/);
  assert.match(exportError({ stage: "server", status: 500 }), /server couldn't make/);
  assert.match(exportError({ stage: "network" }), /connection/);
  assert.match(exportError({ stage: "save" }), /couldn't be saved/);
  assert.match(exportError({ stage: "share" }), /share sheet/);
  assert.match(exportError({ stage: "no-share" }), /isn't available/);
  assert.equal(new ExportError({ stage: "save" }).message, exportError({ stage: "save" }));
});
