import * as SecureStore from "expo-secure-store";

import { istDay } from "./parse.ts";
import type { RawSms, SmsSettings } from "./sync.ts";

// The SMS settings, kept on the phone only under one key. The unreadable list holds raw message
// text, which never leaves the phone unless the owner sends a masked sample.

const KEY = "sms-settings";

function defaults(): SmsSettings {
  // Off by default; the first read starts today.
  return { enabled: false, startDate: istDay(new Date()), lastReadAt: 0, unreadable: [], banks: [] };
}

function isSms(value: unknown): value is RawSms {
  const m = value as RawSms;
  return (
    typeof m === "object" &&
    m !== null &&
    typeof m.id === "string" &&
    typeof m.address === "string" &&
    typeof m.body === "string" &&
    typeof m.date === "number"
  );
}

function clean(stored: unknown): SmsSettings {
  const base = defaults();
  if (typeof stored !== "object" || stored === null) return base;
  const s = stored as Partial<SmsSettings>;
  return {
    enabled: typeof s.enabled === "boolean" ? s.enabled : base.enabled,
    startDate: typeof s.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.startDate) ? s.startDate : base.startDate,
    lastReadAt: typeof s.lastReadAt === "number" && Number.isFinite(s.lastReadAt) ? s.lastReadAt : base.lastReadAt,
    unreadable: Array.isArray(s.unreadable) ? s.unreadable.filter(isSms) : base.unreadable,
    banks: Array.isArray(s.banks) ? s.banks.filter((b): b is string => typeof b === "string") : base.banks,
  };
}

export async function loadSmsSettings(): Promise<SmsSettings> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw === null ? defaults() : clean(JSON.parse(raw));
  } catch {
    // Unreadable storage (for example after a restore) starts over with SMS reading off.
    return defaults();
  }
}

// Writes run one after another, so the sync loop and the settings screen never overwrite each
// other's changes with a stale copy.
let queue: Promise<unknown> = Promise.resolve();

export function saveSmsSettings(patch: Partial<SmsSettings>): Promise<SmsSettings> {
  const run = queue.then(async () => {
    const next = { ...(await loadSmsSettings()), ...patch };
    await SecureStore.setItemAsync(KEY, JSON.stringify(next));
    return next;
  });
  queue = run.catch(() => undefined);
  return run;
}
