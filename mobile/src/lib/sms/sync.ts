// Reads new bank SMS, parses them and sends only the parsed fields plus a hash to the server. Pure:
// the inbox, the network, hashing and storage come in as functions, so this runs under node tests.
//
// Only messages from known bank, card and depository senders are opened. Anything else is skipped
// on the sender alone; its text is never parsed, stored or sent. Raw text never leaves the phone:
// messages no parser understood, or that the server refused, stay in local storage for the owner.

import { type Parsed, istDay, parseSms } from "./parse.ts";
import { senderBank } from "./senders.ts";

export const BATCH_SIZE = 50;
export const PAGE_SIZE = 500;
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
  // Received SMS with date > sinceMillis, OLDEST first, at most `limit`.
  read: (sinceMillis: number, limit: number) => Promise<RawSms[]>;
  // Rejects with an error carrying `status: 422` when the server refuses the entries' shape.
  post: (entries: SmsEntry[]) => Promise<unknown>;
  hash: (text: string) => Promise<string>;
  settings: SmsSettings;
  now: Date;
  // Applies a change to the stored settings as one read-modify-write against what is stored now,
  // so a settings screen saving at the same time isn't overwritten. null means no change.
  save: (update: (current: SmsSettings) => Partial<SmsSettings> | null) => Promise<void>;
  parse?: typeof parseSms;
  pageSize?: number;
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

// Applies a settings change. Moving the start date earlier starts reading over from it; the
// server answers messages it already has as duplicates.
export function mergeSmsSettings(current: SmsSettings, patch: Partial<SmsSettings>): SmsSettings {
  const next = { ...current, ...patch };
  if (patch.startDate !== undefined && patch.startDate < current.startDate && patch.lastReadAt === undefined) {
    next.lastReadAt = 0;
  }
  return next;
}

// What the server accepts: Numeric(14,2) money, Numeric(24,8) positive quantities, ISO days.
const MONEY = /^\d{1,12}(?:\.\d{1,2})?$/;
const QUANTITY = /^\d{1,16}(?:\.\d{1,8})?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function clip(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

function moneyOk(value: string | null): boolean {
  return value === null || MONEY.test(value);
}

// The entry for one parsed line, or null when a number or date is outside what the server takes
// (the whole message then counts as unreadable). Text fields are clipped to the server's lengths.
function toEntry(hash: string, address: string, bank: string, line: Parsed, today: string, received: string): SmsEntry | null {
  if (!moneyOk(line.amount) || !moneyOk(line.balance)) return null;
  if (line.quantity !== null && (!QUANTITY.test(line.quantity) || Number(line.quantity) <= 0)) return null;
  if (!DAY.test(line.date) || (line.dueDate !== null && !DAY.test(line.dueDate))) return null;
  // The server refuses a date after today.
  const date = line.date > today ? received : line.date;
  return {
    hash,
    sender: address.trim().slice(0, 20),
    bank: bank.slice(0, 30),
    kind: line.kind,
    amount: line.amount,
    date,
    last4: line.last4 !== null && /^\d{4}$/.test(line.last4) ? line.last4 : null,
    payee: clip(line.payee, 120),
    ref: clip(line.ref, 40),
    balance: line.balance,
    isin: clip(line.isin, 12),
    quantity: line.quantity,
    due_date: line.dueDate,
  };
}

function isRefused(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: unknown }).status === 422;
}

// One message read from the inbox: its entries (none when ignored or unreadable) and the mark
// that is safe once it has been handled.
type Unit = { message: RawSms; entries: SmsEntry[]; safe: number };

export async function syncSms({
  read,
  post,
  hash,
  settings,
  now,
  save,
  parse = parseSms,
  pageSize = PAGE_SIZE,
}: SyncDeps): Promise<SyncResult> {
  const today = istDay(now);
  let cursor = Math.max(settings.lastReadAt, startMillis(settings.startDate, now) - 1);
  let mark = settings.lastReadAt;
  const seen = new Set<string>();
  const banks = new Set<string>();
  let sent = 0;
  let unreadableCount = 0;

  const keep = async (messages: RawSms[]) => {
    if (messages.length === 0) return;
    unreadableCount += messages.length;
    await save((current) => {
      const ids = new Set<string>();
      const unreadable = [...[...messages].reverse(), ...current.unreadable]
        .filter((m) => (ids.has(m.id) ? false : (ids.add(m.id), true)))
        .slice(0, MAX_UNREADABLE);
      return { unreadable };
    });
  };
  // The mark is written only while the start date is the one this sync began with: moving it
  // earlier resets the mark, and a sync already running must not undo that.
  const advance = async (to: number) => {
    if (to <= mark) return;
    mark = to;
    await save((current) => (current.startDate === settings.startDate ? { lastReadAt: to } : null));
  };
  // Posts one message's lines, at most a batch per request.
  const postLines = async (entries: SmsEntry[]) => {
    for (let i = 0; i < entries.length; i += BATCH_SIZE) await post(entries.slice(i, i + BATCH_SIZE));
  };

  for (;;) {
    const page = (await read(cursor, pageSize)).filter((m) => m.date > cursor).sort((a, b) => a.date - b.date);
    if (page.length === 0) break;
    const full = page.length >= pageSize;
    const last = page[page.length - 1].date;
    // A full page may stop partway through a millisecond: read again from just below its last
    // time and skip the ids already handled. Only a page that is one single millisecond can't be
    // split that way, and then reading moves on past it.
    const allSame = page[0].date === last;
    const nextCursor = full && !allSame ? last - 1 : last;

    const fresh = page.filter((m) => !seen.has(m.id));
    fresh.forEach((m) => seen.add(m.id));

    const units: Unit[] = [];
    const unreadable: RawSms[] = [];
    for (const [i, message] of fresh.entries()) {
      const following = fresh[i + 1];
      const safe =
        following !== undefined
          ? following.date <= message.date
            ? message.date - 1
            : message.date
          : Math.min(message.date, nextCursor);
      const bank = senderBank(message.address);
      let entries: SmsEntry[] = [];
      if (bank !== null) {
        banks.add(bank);
        const received = new Date(message.date);
        let result: ReturnType<typeof parseSms>;
        try {
          result = parse(bank, message.body, received);
        } catch {
          // A parser bug must not stall every later message; the owner sees it in the list.
          result = "unreadable";
        }
        if (result !== "unreadable" && result !== "ignore") {
          const base = `${message.address}\n${message.date}\n${message.body}`;
          const indexed = result.length > 1 || result.some((line) => line.kind === "demat");
          const built = await Promise.all(
            result.map(async (line, n) =>
              toEntry((await hash(indexed ? `${base}:${n}` : base)).toLowerCase(), message.address, bank, line, today, istDay(received)),
            ),
          );
          if (built.every((e): e is SmsEntry => e !== null)) entries = built;
          else result = "unreadable";
        }
        if (result === "unreadable") unreadable.push({ ...message });
      }
      units.push({ message, entries, safe });
    }

    await save((current) => {
      const all = [...new Set([...current.banks, ...banks])].sort();
      return all.length === current.banks.length ? null : { banks: all };
    });
    await keep(unreadable);

    // Whole messages per request, up to a batch of lines; a message with more lines goes alone.
    const batches: Unit[][] = [[]];
    for (const unit of units) {
      let current = batches[batches.length - 1];
      const lines = current.reduce((n, u) => n + u.entries.length, 0);
      if (unit.entries.length > 0 && lines > 0 && lines + unit.entries.length > BATCH_SIZE) {
        current = [];
        batches.push(current);
      }
      current.push(unit);
    }

    for (const batch of batches) {
      if (batch.length === 0) continue;
      const entries = batch.flatMap((u) => u.entries);
      try {
        if (entries.length > BATCH_SIZE) await postLines(entries);
        else if (entries.length > 0) await post(entries);
        sent += entries.length;
      } catch (error) {
        if (!isRefused(error)) throw error;
        // The server refused something in this batch: send each message on its own. One or two
        // refused messages are their own problem; they are kept on the phone so they don't block
        // everything after them. Three refused in a row means the server is refusing everything
        // (say, a contract change the phone hasn't caught up with): stop without moving past them
        // or keeping them, and try again next time. Refusals are held until that is known.
        let refusedInARow = 0;
        let held: { unit: Unit; refused: boolean }[] = [];
        const settle = async () => {
          await keep(held.filter((h) => h.refused).map((h) => ({ ...h.unit.message })));
          if (held.length > 0) await advance(held[held.length - 1].unit.safe);
          held = [];
        };
        for (const unit of batch) {
          if (unit.entries.length > 0) {
            try {
              await postLines(unit.entries);
            } catch (single) {
              if (!isRefused(single)) throw single;
              refusedInARow += 1;
              if (refusedInARow >= 3) throw single;
              held.push({ unit, refused: true });
              continue;
            }
            sent += unit.entries.length;
            refusedInARow = 0;
            await settle();
            await advance(unit.safe);
          } else if (held.length > 0) {
            held.push({ unit, refused: false });
          } else {
            await advance(unit.safe);
          }
        }
        await settle();
      }
      await advance(batch[batch.length - 1].safe);
    }

    if (!full) break;
    cursor = nextCursor;
  }

  return { sent, unreadable: unreadableCount, banks: [...banks].sort() };
}
