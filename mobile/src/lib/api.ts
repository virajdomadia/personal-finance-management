// The app always uses the deployed API, including in development.
const API_URL = "https://finance-api.virajdomadia.com";
const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail?: unknown,
  ) {
    super(`API responded with ${status}`);
  }
}

// The error body's `detail`, read once; undefined when the body isn't JSON or has none.
async function readDetail(response: Response): Promise<unknown> {
  try {
    return (await response.json())?.detail;
  } catch {
    return undefined;
  }
}

type Options = {
  method?: "GET" | "POST" | "PATCH";
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
    if (!response.ok) throw new ApiError(response.status, await readDetail(response));
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
