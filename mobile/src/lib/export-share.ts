// Downloads an export with the session's token into the cache folder and opens the Android share
// sheet on it, so the owner can save it to Drive, email it, and so on.
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { API_URL, ApiError } from "@/lib/api";
import { EXPORTS, type ExportKind, fileNameFrom } from "@/lib/data-export";

const TIMEOUT_MS = 60_000;

export async function shareExport(kind: ExportKind, token: string | undefined): Promise<void> {
  const { path, fallback, mimeType, title } = EXPORTS[kind];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let bytes: Uint8Array;
  let name: string;
  try {
    const response = await fetch(`${API_URL}/api${path}`, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new ApiError(response.status);
    bytes = new Uint8Array(await response.arrayBuffer());
    name = fileNameFrom(response.headers.get("content-disposition"), fallback);
  } finally {
    clearTimeout(timeout);
  }
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: title });
}
