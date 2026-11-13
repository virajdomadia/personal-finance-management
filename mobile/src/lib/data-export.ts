// "Export my data" on Profile: the two files the server builds, and how they're named and shared.

export type ExportKind = "csv" | "backup";

export const EXPORTS: Record<ExportKind, { path: string; fallback: string; mimeType: string; title: string }> = {
  csv: { path: "/export/csv", fallback: "pfm-export.zip", mimeType: "application/zip", title: "Spreadsheets (CSV zip)" },
  backup: { path: "/export/backup", fallback: "pfm-backup.json.gz", mimeType: "application/gzip", title: "Full backup (JSON)" },
};

// The file name from a `Content-Disposition: attachment; filename="..."` header, else the fallback.
// Only a plain name is accepted, so a header can't steer the file into another folder.
export function fileNameFrom(header: string | null | undefined, fallback: string): string {
  const match = header?.match(/filename="?([^";]+)"?/i);
  const name = match?.[1]?.trim();
  return name && /^[\w.-]+$/.test(name) ? name : fallback;
}

// Exports are written to the cache folder. Earlier ones are removed before a new one and on log out,
// so copies of the owner's finances don't pile up on the phone.
export function isExportFile(name: string): boolean {
  return /^pfm-(export|backup)[\w.-]*\.(zip|json|json\.gz)$/.test(name);
}

// Where an export went wrong, so the message says what really happened.
export type ExportFailure =
  | { stage: "network" }
  | { stage: "server"; status: number }
  | { stage: "save" }
  | { stage: "share" }
  | { stage: "no-share" };

export function exportError(failure: ExportFailure): string {
  switch (failure.stage) {
    case "network":
      return "Couldn't reach the server. Check your connection and try again.";
    case "server":
      return failure.status === 401
        ? "You've been signed out. Sign in again to export."
        : "The server couldn't make the file. Try again in a minute.";
    case "save":
      return "The file couldn't be saved on this phone. Free up some space and try again.";
    case "share":
      return "The share sheet couldn't open the file. Try again.";
    case "no-share":
      return "Sharing isn't available on this phone.";
  }
}

export class ExportError extends Error {
  readonly failure: ExportFailure;

  constructor(failure: ExportFailure) {
    super(exportError(failure));
    this.failure = failure;
  }
}
