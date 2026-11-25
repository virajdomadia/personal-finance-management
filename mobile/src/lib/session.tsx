import * as SecureStore from "expo-secure-store";
import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";

import { ApiError, apiFetch } from "@/lib/api";
import { clearExports } from "@/lib/export-share";
import { getGoogleIdToken, signOutOfGoogle } from "@/lib/google";
import { TOKEN_KEY, readStoredToken } from "@/lib/stored-token";

type Session = {
  token: string | null;
  logIn: () => Promise<void>;
  logOut: () => Promise<void>;
  // Signs every browser and phone out, this one too. Rejects when the server couldn't do it.
  logOutEverywhere: () => Promise<void>;
};

const SessionContext = createContext<Session | null>(null);

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
    // Ends this phone's session on the server too, without waiting: signing out works offline, and
    // on a 401 (the usual reason to be here) the session has already ended.
    if (token) void apiFetch("/auth/logout", { method: "POST", token, asOwner: true }).catch(() => {});
    setToken(null);
    clearExports(); // exported files hold the whole financial history
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    } finally {
      await signOutOfGoogle();
    }
  }, [token]);

  const logOutEverywhere = useCallback(async () => {
    if (token) {
      try {
        await apiFetch("/auth/logout-everywhere", { method: "POST", token, asOwner: true });
      } catch (error) {
        // A 401 means this session had already ended; anything else, the others may still be in.
        if (!(error instanceof ApiError && error.status === 401)) throw error;
      }
    }
    await logOut();
  }, [token, logOut]);

  const session = useMemo(
    () => ({ token, logIn, logOut, logOutEverywhere }),
    [token, logIn, logOut, logOutEverywhere],
  );

  return <SessionContext value={session}>{children}</SessionContext>;
}

export function useSession(): Session {
  const session = use(SessionContext);
  if (!session) throw new Error("useSession must be used inside SessionProvider.");
  return session;
}
