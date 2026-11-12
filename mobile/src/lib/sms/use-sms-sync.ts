import * as Crypto from "expo-crypto";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import { isAvailable, readInbox } from "../../../modules/sms-inbox";

import { loadSmsSettings, saveSmsSettings } from "./settings";
import { type SmsEntry, syncSms } from "./sync";

const MIN_GAP_MS = 30_000;
// Covers every SMS of 90 days for a heavy inbox; personal messages count too, since the sender
// check happens in JavaScript.
const READ_LIMIT = 5_000;

type EntryResult = { hash: string; status: string; reason: string | null };

// Reads new bank SMS when the app opens and whenever it comes back to the front. Never in the
// background. Does nothing while SMS reading is off or on an app build without the native reader.
export function useSmsSync(): void {
  const { token } = useSession();
  const running = useRef(false);
  const lastRun = useRef(0);

  useEffect(() => {
    if (!token || !isAvailable()) return;

    const run = async () => {
      if (running.current || Date.now() - lastRun.current < MIN_GAP_MS) return;
      running.current = true;
      try {
        const settings = await loadSmsSettings();
        if (!settings.enabled) return;
        lastRun.current = Date.now();
        await syncSms({
          read: (since) => readInbox(since, READ_LIMIT),
          post: (entries: SmsEntry[]) =>
            apiFetch<{ results: EntryResult[] }>("/sms/entries", { method: "POST", token, body: { entries } }),
          hash: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
          settings,
          now: new Date(),
          save: async (patch) => {
            await saveSmsSettings(patch);
          },
        });
      } catch (error) {
        // Quiet: whatever wasn't sent is read again next time.
        if (__DEV__) console.warn("SMS sync failed", error);
      } finally {
        running.current = false;
      }
    };

    void run();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void run();
    });
    return () => subscription.remove();
  }, [token]);
}
