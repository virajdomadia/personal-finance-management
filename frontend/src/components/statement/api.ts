import { ApiError, apiFetch } from "@/lib/api";
import {
  PASSWORD_HEADER,
  type PreviewFailure,
  SAVE_PATH,
  type SaveLine,
  type SaveResult,
  type StatementPreview,
  fileType,
  previewFailure,
  previewUrl,
} from "@/lib/statement-import";

export class PreviewFailed extends Error {
  constructor(
    readonly status: number,
    readonly failure: PreviewFailure,
  ) {
    super(failure.message);
  }
}

// The statement goes as the raw request body, in its own type, through the /api proxy. A locked
// PDF's password goes in a header, never the URL.
export async function previewStatement(accountId: number, file: File, password: string): Promise<StatementPreview> {
  const headers: Record<string, string> = { "Content-Type": fileType(file) };
  if (password) headers[PASSWORD_HEADER] = password;
  let res: Response;
  try {
    res = await fetch(previewUrl(accountId), { method: "POST", body: file, headers, cache: "no-store" });
  } catch {
    throw new PreviewFailed(0, { kind: "error", message: "Couldn't reach the server. Check your connection and try again." });
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new PreviewFailed(res.status, previewFailure(res.status, body));
  }
  return (await res.json()) as StatementPreview;
}

export function saveStatement(payload: { account_id: number; lines: SaveLine[] }): Promise<SaveResult> {
  return apiFetch<SaveResult>(SAVE_PATH, { method: "POST", body: JSON.stringify(payload) });
}

export function isUnauthorized(err: unknown): boolean {
  return (err instanceof ApiError || err instanceof PreviewFailed) && err.status === 401;
}
