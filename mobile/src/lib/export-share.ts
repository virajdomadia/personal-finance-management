// Downloads an export with the session's token into the cache folder and opens the Android share
// sheet on it, so the owner can save it to Drive, email it, and so on.
// Both packages are loaded only when this build has their native modules (see native.ts): this file
// is reached from the session at start-up, so a static import would crash an older build outright.
import { API_URL, reportProfileGone, requestProfile } from "@/lib/api";
import { EXPORTS, ExportError, type ExportKind, fileNameFrom, isExportFile } from "@/lib/data-export";
import { loadFileSharing } from "@/lib/native";

const TIMEOUT_MS = 60_000;

// Removes exports left in the cache by earlier runs. Never throws: a stale file isn't worth an error.
export function clearExports(): void {
  const found = loadFileSharing();
  if (found === null) return; // a build without these modules never wrote an export
  const { File, Paths } = found.fs;
  try {
    for (const entry of Paths.cache.list()) {
      if (entry instanceof File && isExportFile(entry.name)) entry.delete();
    }
  } catch {
    // The system may clear its cache too; nothing to tell the owner.
  }
}

async function download(path: string, token: string | undefined): Promise<{ bytes: Uint8Array; name: string | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const profile = requestProfile(path); // an export is the chosen profile's, like everything else
  try {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/api${path}`, {
        signal: controller.signal,
        headers: { ...profile.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
    } catch {
      throw new ExportError({ stage: "network" });
    }
    if (!response.ok) {
      if (response.status === 404) {
        let detail: unknown;
        try {
          detail = ((await response.json()) as { detail?: unknown }).detail;
        } catch {
          detail = undefined;
        }
        reportProfileGone(404, detail, profile.sent);
      }
      throw new ExportError({ stage: "server", status: response.status });
    }
    try {
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        name: response.headers.get("content-disposition"),
      };
    } catch {
      throw new ExportError({ stage: "network" });
    }
  } finally {
    clearTimeout(timeout);
  }
}

export function shareExport(kind: ExportKind, token: string | undefined): Promise<void> {
  return shareDownload(EXPORTS[kind], token);
}

// Any file the server builds for the owner to keep, such as an import template: downloaded, then
// handed to the share sheet so it can be saved or opened in Excel or Sheets.
export async function shareDownload(
  { path, fallback, mimeType, title }: { path: string; fallback: string; mimeType: string; title: string },
  token: string | undefined,
): Promise<void> {
  const found = loadFileSharing();
  if (found === null) throw new ExportError({ stage: "needs-update" });
  const { File, Paths } = found.fs;
  const Sharing = found.sharing;
  const { bytes, name } = await download(path, token);

  clearExports();
  const file = new File(Paths.cache, fileNameFrom(name, fallback));
  try {
    file.create({ overwrite: true });
    await file.write(bytes);
  } catch {
    throw new ExportError({ stage: "save" });
  }

  if (!(await Sharing.isAvailableAsync())) throw new ExportError({ stage: "no-share" });
  try {
    await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: title });
  } catch {
    throw new ExportError({ stage: "share" });
  }
}
