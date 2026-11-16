// Picks one file with the system picker and reads its bytes, for the imports. The picker copies the
// file into the cache; that copy is deleted once read, so statements don't stay on the phone.
// Both packages are loaded only when this build has their native modules (see native.ts).
import { MAX_FILE_BYTES, TOO_BIG, fileTooBig, hasExtension } from "@/lib/excel-import";
import { NEEDS_UPDATE, loadFilePicking } from "@/lib/native";

export type PickedFile = { name: string; mimeType: string | null; bytes: Uint8Array<ArrayBuffer> };

// A pick that can't go on; the message is for people.
export class PickError extends Error {}

// Resolves to null when the owner backs out of the picker.
export async function pickFile(types: string[], extensions: string[], wrongType: string): Promise<PickedFile | null> {
  const found = loadFilePicking();
  if (found === null) throw new PickError(NEEDS_UPDATE);
  const result = await found.picker.getDocumentAsync({ type: types, copyToCacheDirectory: true, multiple: false });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  const file = new found.fs.File(asset.uri);
  try {
    if (!hasExtension(asset.name, extensions)) throw new PickError(wrongType);
    if (fileTooBig(asset.size)) throw new PickError(TOO_BIG);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new PickError("The file couldn't be read. Try choosing it again.");
    }
    if (bytes.length > MAX_FILE_BYTES) throw new PickError(TOO_BIG);
    if (bytes.length === 0) throw new PickError("That file is empty.");
    return { name: asset.name, mimeType: asset.mimeType ?? null, bytes };
  } finally {
    try {
      // Only ever the picker's copy in the cache, never the owner's own file.
      if (asset.uri.startsWith(found.fs.Paths.cache.uri)) file.delete();
    } catch {
      // The system clears its cache too; nothing to tell the owner.
    }
  }
}

export function pickErrorMessage(err: unknown): string {
  return err instanceof PickError ? err.message : "The file couldn't be opened. Try choosing it again.";
}
