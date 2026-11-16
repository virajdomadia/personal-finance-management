// The app always uses the deployed API, including in development.
export const API_URL = "https://finance-api.virajdomadia.com";
const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail?: unknown,
    public readonly body?: unknown, // the whole error body, for the few that carry more than `detail`
  ) {
    super(`API responded with ${status}`);
  }
}

// The error body as JSON, read once; undefined when it isn't JSON.
async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function detailOf(body: unknown): unknown {
  return typeof body === "object" && body !== null && "detail" in body ? body.detail : undefined;
}

async function failure(response: Response): Promise<ApiError> {
  const body = await readBody(response);
  return new ApiError(response.status, detailOf(body), body);
}

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string;
  body?: unknown;
};

export async function apiFetch<T>(path: string, { method, token, body }: Options = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${API_URL}/api${path}`, {
      method,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

const UPLOAD_TIMEOUT_MS = 90_000; // a 4 MB file on a slow connection, plus the server reading it
export const OFFLINE = "Couldn't reach the server. Check your connection and try again.";

type UploadOptions = {
  token?: string;
  bytes: Uint8Array<ArrayBuffer>; // the file itself, sent as the raw request body
  contentType: string;
  headers?: Record<string, string>;
};

// POSTs a file as the raw body (the imports read it that way, not as a form). A failure is an
// ApiError like apiFetch's; one that never reached the server has status 0 and says so.
export async function apiUpload<T>(path: string, { token, bytes, contentType, headers = {} }: UploadOptions): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/api${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...headers,
          "Content-Type": contentType,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: bytes,
      });
    } catch {
      throw new ApiError(0, OFFLINE);
    }
    if (!response.ok) throw await failure(response);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
