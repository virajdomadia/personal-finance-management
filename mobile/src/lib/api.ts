// The app always uses the deployed API, including in development.
const API_URL = "https://finance-api.virajdomadia.com";
const REQUEST_TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`API responded with ${status}`);
  }
}

type Options = {
  method?: "GET" | "POST";
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
    if (!response.ok) throw new ApiError(response.status);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}
