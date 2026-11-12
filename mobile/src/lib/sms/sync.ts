// Reads new bank SMS, parses them and sends only the parsed fields plus a hash to the server. Pure:
// the inbox, the network, hashing and storage come in as functions, so this runs under node tests.
//
// Only messages from known bank, card and depository senders are opened. Anything else is skipped
// on the sender alone; its text is never parsed, stored or sent. Raw text never leaves the phone:
// messages no parser understood stay in local storage for the owner to look at.

import { type Parsed, istDay, parseSms } from "./parse.ts";
import { senderBank } from "./senders.ts";

export const BATCH_SIZE = 50;
export const MAX_DAYS_BACK = 90;
export const MAX_UNREADABLE = 50;

const IST_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RawSms = { id: string; address: string; body: string; date: number };

export type SmsSettings = {
  enabled: boolean;
  startDate: string; // YYYY-MM-DD; empty means today
  lastReadAt: number; // epoch ms of the newest message already handled
  unreadable: RawSms[]; // newest first, phone only
  banks: string[]; // bank keys seen so far, for the settings screen
};

// The server's field names. Nothing else may be added: the server rejects extra fields.
export type SmsEntry = {
  hash: string;
  sender: string;
  bank: string;
  kind: Parsed["kind"];
  amount: string | null;
  date: string;
  last4: string | null;
  payee: string | null;
  ref: string | null;
  balance: string | null;
  isin: string | null;
  quantity: string | null;
  due_date: string | null;
};

export type SyncDeps = {
  read: (sinceMillis: number) => Promise<RawSms[]>;
  post: (entries: SmsEntry[]) => Promise<unknown>;
  hash: (text: string) => Promise<string>;
  settings: SmsSettings;
  now: Date;
  save: (patch: Partial<SmsSettings>) => Promise<void>;
  parse?: typeof parseSms;
};

export type SyncResult = { sent: number; unreadable: number; banks: string[] };

// Midnight in India at the start of `startDate`, no earlier than 90 days before `now`'s day.
// An empty or malformed start date means today.
export function startMillis(startDate: string, now: Date): number {
  const today = Date.parse(`${istDay(now)}T00:00:00Z`) - IST_MS;
  const floor = today - MAX_DAYS_BACK * DAY_MS;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!match) return today;
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - IST_MS;
  if (Number.isNaN(start)) return today;
  return Math.min(today, Math.max(floor, start));
}

function clip(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

function toEntry(hash: string, address: string, bank: string, line: Parsed, today: string, received: string): SmsEntry {
  // The server refuses a date after today, and one refused entry fails its whole batch.
  const date = line.date > today ? received : line.date;
  return {
    hash,
    sender: address.trim().slice(0, 20),
    bank: bank.slice(0, 30),
    kind: line.kind,
    amount: line.amount,
    date,
    last4: line.last4,
    payee: clip(line.payee, 120),
    ref: clip(line.ref, 40),
    balance: line.balance,
    isin: clip(line.isin, 12),
    quantity: line.quantity,
    due_date: line.dueDate,
  };
}

// `end` is the index of the batch's last message, entries or not.
type Batch = { entries: SmsEntry[]; newest: number; end: number };

export async function syncSms({ read, post, hash, settings, now, save, parse = parseSms }: SyncDeps): Promise<SyncResult> {
  const since = Math.max(settings.lastReadAt, startMillis(settings.startDate, now) - 1);
  // Oldest first, so the mark only ever moves forward over handled messages.
  const messages = (await read(since)).filter((m) => m.date > since).sort((a, b) => a.date - b.date);
  const today = istDay(now);

  const batches: Batch[] = [{ entries: [], newest: since, end: -1 }];
  const unreadable: RawSms[] = [];
  const banks = new Set<string>();

  for (const [index, message] of messages.entries()) {
    const bank = senderBank(message.address);
    let entries: SmsEntry[] = [];
    if (bank !== null) {
      banks.add(bank);
      const received = new Date(message.date);
      let result: ReturnType<typeof parseSms>;
      try {
        result = parse(bank, message.body, received);
      } catch {
        // A parser bug must not stall every later message; the owner sees it in the unreadable list.
        result = "unreadable";
      }
      if (result === "unreadable") {
        unreadable.push({ id: message.id, address: message.address, body: message.body, date: message.date });
      } else if (result !== "ignore") {
        const base = `${message.address}\n${message.date}\n${message.body}`;
        const indexed = result.length > 1 || result.some((line) => line.kind === "demat");
        entries = await Promise.all(
          result.map(async (line, i) =>
            toEntry((await hash(indexed ? `${base}:${i}` : base)).toLowerCase(), message.address, bank, line, today, istDay(received)),
          ),
        );
      }
    }
    // A message's lines always go in one batch; a full batch starts a new one.
    let current = batches[batches.length - 1];
    if (entries.length > 0 && current.entries.length > 0 && current.entries.length + entries.length > BATCH_SIZE) {
      current = { entries: [], newest: current.newest, end: current.end };
      batches.push(current);
    }
    current.entries.push(...entries);
    current.newest = message.date;
    current.end = index;
  }

  const seen = new Set<string>();
  const kept = [...unreadable.reverse(), ...settings.unreadable]
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .slice(0, MAX_UNREADABLE);
  const allBanks = [...new Set([...settings.banks, ...banks])].sort();
  await save({ unreadable: kept, banks: allBanks });

  let sent = 0;
  let mark = settings.lastReadAt;
  for (const batch of batches) {
    if (batch.entries.length > 0) await post(batch.entries);
    sent += batch.entries.length;
    // When the next batch starts at this batch's newest time, stop just below it: reading is
    // "after the mark", and the message sharing that time must be read again if its batch fails.
    // The server answers a resent message as a duplicate.
    const next = messages[batch.end + 1];
    const advance = next !== undefined && next.date <= batch.newest ? batch.newest - 1 : batch.newest;
    if (batch.end >= 0 && advance > mark) {
      mark = advance;
      await save({ lastReadAt: mark });
    }
  }

  return { sent, unreadable: unreadable.length, banks: [...banks].sort() };
}

