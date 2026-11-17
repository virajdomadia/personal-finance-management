// Runs the SMS sync against the phone's inbox and the API, one at a time for the whole JS runtime,
// and posts notifications for what it recorded. Shared by the app (use-sms-sync.ts) and the
// background task that runs when an SMS arrives (background.ts), so a sync started by either is
// never doubled by the other.

import { apiFetch } from "@/lib/api";
import { loadCrypto } from "@/lib/native";
import { refreshReminders } from "@/lib/reminder-schedule";
import { readInbox } from "../../../modules/sms-inbox";

import { postNotices } from "./notifications";
import { planNotices, wasRecorded } from "./notify";
import { loadSmsSettings, updateSmsSettings } from "./settings";
import { type SmsEntry, type SyncResult, syncSms } from "./sync";

// The inbox may not have the SMS yet when the arrival is heard (the SMS app writes it): read again
// after a short wait, a few times, while nothing from a bank was read.
const ARRIVAL_TRIES = 3;
const ARRIVAL_WAIT_MS = 4_000;

let inFlight: Promise<SyncResult | null> | null = null;
let lastRun = 0;

// Epoch ms the last sync started, 0 for never.
export function lastSyncStarted(): number {
  return lastRun;
}

// Reads and sends new bank SMS, then notifies about any that just arrived (when the owner wants
// that). A sync already running is joined, not repeated. Resolves null when SMS reading is off or
// this build can't hash; rejects when the sync fails. SMS calls always act for the signed-in owner:
// /sms is never sent with X-Profile (see family.ts).
export function runSync(token: string): Promise<SyncResult | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const settings = await loadSmsSettings();
      if (!settings.enabled) return null;
      // Loaded here, not at the top: a build without expo-crypto would otherwise crash at start-up.
      const Crypto = loadCrypto();
      if (Crypto === null) return null;
      lastRun = Date.now();
      const result = await syncSms({
        read: (since, limit) => readInbox(since, limit),
        post: (entries: SmsEntry[]) => apiFetch<unknown>("/sms/entries", { method: "POST", token, body: { entries } }),
        hash: (text) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
        settings,
        now: new Date(),
        save: async (update) => {
          await updateSmsSettings(update);
        },
      });
      // Read again: the switch may have changed while the sync ran.
      if ((await loadSmsSettings()).notify) await postNotices(planNotices(result.outcomes, Date.now()));
      // A recorded payment may settle a due reminder or push a budget past a line.
      if (result.outcomes.some(wasRecorded)) await refreshReminders(token);
      return result;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// For an SMS that just arrived. A sync already running may have read the inbox before it came, so
// that one is waited out and a fresh one runs; then reads again briefly while no bank message has
// shown up. Rejects when a sync fails.
export async function syncArrived(token: string): Promise<void> {
  if (inFlight) await inFlight.catch(() => null);
  for (let attempt = 1; ; attempt += 1) {
    const result = await runSync(token);
    if (result === null || result.banks.length > 0 || attempt >= ARRIVAL_TRIES) return;
    await wait(ARRIVAL_WAIT_MS);
  }
}
