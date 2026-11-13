// "Export my data" on Profile: the two files the server builds, and how they're named and shared.

export type ExportKind = "csv" | "backup";

export const EXPORTS: Record<ExportKind, { path: string; fallback: string; mimeType: string; title: string }> = {
  csv: { path: "/export/csv", fallback: "pfm-export.zip", mimeType: "application/zip", title: "Spreadsheets (CSV zip)" },
  backup: { path: "/export/backup", fallback: "pfm-backup.json", mimeType: "application/json", title: "Full backup (JSON)" },
};

// The file name from a `Content-Disposition: attachment; filename="..."` header, else the fallback.
// Only a plain name is accepted, so a header can't steer the file into another folder.
export function fileNameFrom(header: string | null | undefined, fallback: string): string {
  const match = header?.match(/filename="?([^";]+)"?/i);
  const name = match?.[1]?.trim();
  return name && /^[\w.-]+$/.test(name) ? name : fallback;
}

export function exportError(status: number | null): string {
  if (status === 401) return "You've been signed out. Sign in again to export.";
  if (status === null) return "Couldn't reach the server. Check your connection and try again.";
  return "The export didn't work. Try again in a minute.";
}
