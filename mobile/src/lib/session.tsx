import * as SecureStore from "expo-secure-store";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";

import { apiFetch } from "@/lib/api";

const TOKEN_KEY = "pfm_token";

type Session = {
  token: string | null;
  logIn: (password: string) => Promise<void>;
  logOut: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

function readStoredToken(): string | null {
  try {
    return SecureStore.getItem(TOKEN_KEY);
  } catch {
    // Android can invalidate stored keys, for example after a restore. Asking for the password
    // again is the right recovery.
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState(readStoredToken);

  const logIn = useCallback(async (password: string) => {
    const result = await apiFetch<{ token: string }>("/auth/login", {
      method: "POST",
      body: { password },
    });
    await SecureStore.setItemAsync(TOKEN_KEY, result.token);
    setToken(result.token);
  }, []);

  const logOut = useCallback(async () => {
    setToken(null);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  }, []);

  const session = useMemo(() => ({ token, logIn, logOut }), [token, logIn, logOut]);

  return <SessionContext value={session}>{children}</SessionContext>;
}

export function useSession(): Session {
  const session = use(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionProvider.");
  return session;
}
