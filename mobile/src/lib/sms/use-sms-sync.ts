import * as Crypto from "expo-crypto";
import { useEffect } from "react";
import { AppState } from "react-native";

import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import { isAvailable, readInbox } from "../../../modules/sms-inbox";

import { loadSmsSettings, saveSmsSettings } from "./settings";
import { type SmsEntry, type SyncResult, syncSms } from "./sync";

const MIN_GAP_MS = 30_000;

type EntryResult = { hash: string; status: string; reason: string | null };

// One sync at a time for the whole app, shared by the hook and syncSmsNow.
let inFlight: Promise<SyncResult | null> | null = null;
let lastRun = 0;
let currentToken: string | null = null;

function runSync(token: string): Promise<SyncResult | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const settings = await loadSmsSettings();
      if (!settings.enabled) return null;
      lastRun = Date.now();
      return await syncSms({
        read: (since, limit) => readInbox(since, limit),
        post: (entries: SmsEntry[]) =>
          apiFetch<{ results: EntryResult[] }>("/sms/entries", { method: "POST", token, body: { entries } }),
        hash: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
        settings,
        now: new Date(),
        save: async (patch) => {
          await saveSmsSettings(patch);
        },
      });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Reads right away, for "Read now" and for switching SMS reading on. Resolves null when reading is
// off, signed out or this app build has no SMS reader; rejects when the sync fails.
export function syncSmsNow(): Promise<SyncResult | null> {
  if (!currentToken || !isAvailable()) return Promise.resolve(null);
  return runSync(currentToken);
}

// Reads new bank SMS when the app opens and whenever it comes back to the front, at most every
// 30 seconds. Never in the background. Does nothing while SMS reading is off or on an app build
// without the native reader.
export function useSmsSync(): void {
  const { token } = useSession();

  useEffect(() => {
    currentToken = token;
    if (!token || !isAvailable()) return;

    const run = () => {
      if (Date.now() - lastRun < MIN_GAP_MS) return;
      runSync(token).catch((error: unknown) => {
        // Quiet: whatever wasn't sent is read again next time.
        if (__DEV__) console.warn("SMS sync failed", error);
      });
    };

    run();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") run();
    });
    return () => {
      subscription.remove();
      if (currentToken === token) currentToken = null;
    };
  }, [token]);
}
