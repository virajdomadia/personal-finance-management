// The two downloads on the Your data page. The server builds both files; the browser only saves them.

export type ExportKind = "backup" | "csv";

export const EXPORTS: Record<ExportKind, { path: string; fallback: string }> = {
  backup: { path: "/api/export/backup", fallback: "pfm-backup.json.gz" },
  csv: { path: "/api/export/csv", fallback: "pfm-export.zip" },
};

// The file name from a `Content-Disposition: attachment; filename="..."` header, else the fallback.
// Only a plain name is accepted, so a header can't steer the save into another folder.
export function fileNameFrom(header: string | null, fallback: string): string {
  const match = header?.match(/filename="?([^";]+)"?/i);
  const name = match?.[1]?.trim();
  return name && /^[\w.-]+$/.test(name) ? name : fallback;
}

export function downloadError(status: number): string {
  if (status === 401) return "You've been signed out. Sign in again to download.";
  return "The download didn't work. Try again in a minute.";
}
