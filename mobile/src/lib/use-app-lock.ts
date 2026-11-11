import * as LocalAuthentication from "expo-local-authentication";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";

import { shouldLock } from "@/lib/app-lock";

// This is a lock on the screen, not on the stored token: the token stays in SecureStore.
export function useAppLock(enabled: boolean): {
  locked: boolean;
  covered: boolean;
  unlock: () => Promise<void>;
} {
  // A cold start with a session starts locked, which keeps the content hidden until the cold-start check has run.
  const [locked, setLocked] = useState(enabled);
  const [covered, setCovered] = useState(false);
  const backgroundedAt = useRef<number | null>(null);
  const prompting = useRef(false);
  // Bumped on logout so a prompt started before it can no longer change state.
  const generation = useRef(0);
  const [wasEnabled, setWasEnabled] = useState(enabled);

  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    // A fresh login has just been verified by Google, so it starts unlocked. A cold start with a
    // stored session keeps the initial locked state.
    if (!enabled) {
      setLocked(false);
      setCovered(false);
    }
  }

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    const started = generation.current;
    try {
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      if (generation.current !== started) return;
      if (level === LocalAuthentication.SecurityLevel.NONE) {
        // Without any device security there is nothing to ask for, and locking would trap the user.
        setLocked(false);
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Gullak",
      });
      if (generation.current !== started) return;
      if (result.success) {
        setLocked(false);
      } else if (result.error === "not_enrolled" || result.error === "passcode_not_set") {
        setLocked(false);
      }
    } catch {
      // Stay locked. The lock screen offers a retry and a way to log out.
    } finally {
      prompting.current = false;
    }
  }, []);

  useEffect(() => {
    if (enabled) return;
    generation.current += 1;
    backgroundedAt.current = null;
    // Resolves the pending prompt as cancelled, so it ends and clears `prompting`. It does
    // nothing when there is no prompt, and a rejection must not go unhandled.
    LocalAuthentication.cancelAuthenticate().catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        // The system prompt can send the app to the background on some devices. That must
        // neither lock it nor restart the measure, so only the first background counts.
        if (prompting.current || backgroundedAt.current !== null) return;
        backgroundedAt.current = Date.now();
        setCovered(true);
      } else if (state === "active") {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (since !== null && shouldLock(since, Date.now())) setLocked(true);
        setCovered(false);
      }
    });
    return () => subscription.remove();
  }, [enabled]);

  return { locked: enabled && locked, covered: enabled && covered, unlock };
}
