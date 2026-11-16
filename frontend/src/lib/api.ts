import { isMissingProfile, profileCookie, readProfileCookie } from "./family.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`API ${status}: ${body}`);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text();
    // The chosen family member was removed (in another tab, say): back to the owner, everywhere.
    if (typeof document !== "undefined" && isMissingProfile(path, res.status, body) && readProfileCookie(document.cookie) !== null) {
      document.cookie = profileCookie(null, window.location.protocol === "https:");
      window.location.reload();
    }
    throw new ApiError(res.status, body);
  }
  return res.json() as Promise<T>;
}
