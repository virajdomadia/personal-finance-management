// Downloads an export with the session's token into the cache folder and opens the Android share
// sheet on it, so the owner can save it to Drive, email it, and so on.
// Both packages are loaded only when this build has their native modules (see native.ts): this file
// is reached from the session at start-up, so a static import would crash an older build outright.
import { API_URL } from "@/lib/api";
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
  try {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/api${path}`, {
        signal: controller.signal,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      throw new ExportError({ stage: "network" });
    }
    if (!response.ok) throw new ExportError({ stage: "server", status: response.status });
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

export async function shareExport(kind: ExportKind, token: string | undefined): Promise<void> {
  const found = loadFileSharing();
  if (found === null) throw new ExportError({ stage: "needs-update" });
  const { File, Paths } = found.fs;
  const Sharing = found.sharing;
  const { path, fallback, mimeType, title } = EXPORTS[kind];
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
