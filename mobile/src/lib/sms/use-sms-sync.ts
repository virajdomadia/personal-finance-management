import { useEffect } from "react";
import { AppState } from "react-native";

import { useSession } from "@/lib/session";
import { addSmsArrivedListener, isAvailable, setReceiverEnabled } from "../../../modules/sms-inbox";

import { lastSyncStarted, runSync, syncArrived } from "./runner";
import { loadSmsSettings } from "./settings";
import type { SyncResult } from "./sync";

const MIN_GAP_MS = 30_000;

let currentToken: string | null = null;

function quiet(error: unknown): void {
  // Whatever wasn't sent is read again next time.
  if (__DEV__) console.warn("SMS sync failed", error);
}

// Reads right away, for "Read now" and for switching SMS reading on. Resolves null when reading is
// off, signed out or this app build has no SMS reader; rejects when the sync fails.
export function syncSmsNow(): Promise<SyncResult | null> {
  if (!currentToken || !isAvailable()) return Promise.resolve(null);
  return runSync(currentToken);
}

// Reads new bank SMS when the app opens, whenever it comes back to the front (at most every 30
// seconds) and as soon as a bank SMS arrives while it is in the front. In the background an arrived
// SMS is read by the headless task (background.ts) instead. Does nothing while SMS reading is off
// or on an app build without the native reader. Also keeps the arrival receiver switched on only
// while SMS reading is.
export function useSmsSync(): void {
  const { token } = useSession();

  useEffect(() => {
    currentToken = token;
    if (!token || !isAvailable()) return;

    void loadSmsSettings()
      .then((settings) => setReceiverEnabled(settings.enabled))
      .catch(() => {});

    const run = () => {
      if (Date.now() - lastSyncStarted() < MIN_GAP_MS) return;
      runSync(token).catch(quiet);
    };

    run();
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    // The same sync as in the background, so the same notifications: posted while the app is open
    // too, as a banner. Nothing is notified twice: each message is sent once and a repeat comes
    // back as a duplicate.
    const arrivals = addSmsArrivedListener(() => {
      syncArrived(token).catch(quiet);
    });
    return () => {
      appState.remove();
      arrivals?.remove();
      if (currentToken === token) currentToken = null;
    };
  }, [token]);
}
