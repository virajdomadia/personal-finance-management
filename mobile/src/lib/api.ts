import { isProfileGone, profileHeaders } from "./family.ts";

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

// The family member the app is acting for (sent as X-Profile), or null for the signed-in owner.
// Set by ProfileProvider; read on every request.
let profileId: number | null = null;
let onProfileGone: ((id: number) => void) | null = null;

export function setRequestProfile(id: number | null): void {
  profileId = id;
}

export function setProfileGoneHandler(handler: ((id: number) => void) | null): void {
  onProfileGone = handler;
}

// The X-Profile header for a request to `path`, and the id it names (null when none is sent).
export function requestProfile(path: string): { headers: Record<string, string>; sent: number | null } {
  const headers = profileHeaders(path, profileId);
  return { headers, sent: Object.keys(headers).length > 0 ? profileId : null };
}

// Tells the app when the member a request was sent for no longer exists, so it goes back to the owner.
export function reportProfileGone(status: number, detail: unknown, sent: number | null): void {
  if (sent !== null && isProfileGone(status, detail, true)) onProfileGone?.(sent);
}

async function failure(response: Response, sent: number | null): Promise<ApiError> {
  const body = await readBody(response);
  const error = new ApiError(response.status, detailOf(body), body);
  reportProfileGone(error.status, error.detail, sent);
  return error;
}

type Options = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  token?: string;
  body?: unknown;
};

export async function apiFetch<T>(path: string, { method, token, body }: Options = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const profile = requestProfile(path);
  try {
    const response = await fetch(`${API_URL}/api${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...profile.headers,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw await failure(response, profile.sent);
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
  const profile = requestProfile(path);
  try {
    let response: Response;
    try {
      response = await fetch(`${API_URL}/api${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          ...headers,
          ...profile.headers,
          "Content-Type": contentType,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: bytes,
      });
    } catch {
      throw new ApiError(0, OFFLINE);
    }
    if (!response.ok) throw await failure(response, profile.sent);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
