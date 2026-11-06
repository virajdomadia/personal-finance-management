import * as SecureStore from "expo-secure-store";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";

import { apiFetch } from "@/lib/api";
import { getGoogleIdToken, signOutOfGoogle } from "@/lib/google";

const TOKEN_KEY = "pfm_token";

type Session = {
  token: string | null;
  logIn: () => Promise<void>;
  logOut: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

function readStoredToken(): string | null {
  try {
    return SecureStore.getItem(TOKEN_KEY);
  } catch {
    // Android can invalidate stored keys, for example after a restore. Signing in again is the
    // right recovery.
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(readStoredToken);

  const logIn = useCallback(async () => {
    const idToken = await getGoogleIdToken();
    if (idToken === null) return;
    const result = await apiFetch<{ token: string }>("/auth/google", {
      method: "POST",
      body: { id_token: idToken },
    });
    await SecureStore.setItemAsync(TOKEN_KEY, result.token);
    setToken(result.token);
  }, []);

  const logOut = useCallback(async () => {
    setToken(null);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await signOutOfGoogle();
  }, []);

  const session = useMemo(() => ({ token, logIn, logOut }), [token, logIn, logOut]);

  return <SessionContext value={session}>{children}</SessionContext>;
}

export function useSession(): Session {
  const session = use(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionProvider.");
  return session;
}
