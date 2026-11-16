import * as SecureStore from "expo-secure-store";

// The API token, kept in secure storage. Read here rather than through the session so code that
// runs with no screen (the SMS arrival task) can use it too.
export const TOKEN_KEY = "pfm_token";

export function readStoredToken(): string | null {
  try {
    return SecureStore.getItem(TOKEN_KEY);
  } catch {
    // Android can invalidate stored keys, for example after a restore. Signing in again is the
    // right recovery.
    return null;
  }
}
