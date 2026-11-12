import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { OWNER } from "./fixtures.mjs";
import { parseSms } from "./parse.ts";
import { BATCH_SIZE, MAX_DAYS_BACK, startMillis, syncSms } from "./sync.ts";

const NOW = new Date("2026-11-12T10:00:00+05:30");
const DAY = 86_400_000;
const sha256 = async (text) => createHash("sha256").update(text).digest("hex");

function settings(patch = {}) {
  return { enabled: true, startDate: "2026-11-01", lastReadAt: 0, unreadable: [], banks: [], ...patch };
}

// A fake inbox: keeps messages newer than `since`, newest first, like the native module.
function inbox(messages) {
  const calls = [];
  const read = async (since) => {
    calls.push(since);
    return messages.filter((m) => m.date > since).sort((a, b) => b.date - a.date);
  };
  return { read, calls };
}

function recorder({ failOn } = {}) {
  const batches = [];
  const post = async (entries) => {
    batches.push(entries);
    if (failOn === batches.length) throw new Error("network down");
  };
  return { post, batches };
}

function saver(initial) {
  const state = { current: initial };
  const save = async (patch) => {
    state.current = { ...state.current, ...patch };
  };
  return { save, state };
}

const BOI = OWNER.boiUpiDebit;

function boiMessage(id, date) {
  return { id: String(id), address: BOI.sender, body: BOI.body, date };
}

test("test_only_known_senders_are_parsed", async () => {
  const personal = { id: "1", address: "+919812345678", body: "Rs 500 debited, send me the money back", date: NOW.getTime() - 3000 };
  const shop = { id: "2", address: "VM-BIGBZR-P", body: "Rs.200 debited from your wallet. Shop again!", date: NOW.getTime() - 2000 };
  const bank = boiMessage(3, NOW.getTime() - 1000);
  const parsedBodies = [];
  const parse = (bankKey, body, at) => {
    parsedBodies.push(body);
    return parseSms(bankKey, body, at);
  };
  const { read } = inbox([personal, shop, bank]);
  const { post, batches } = recorder();
  const { save } = saver(settings());

  const result = await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, parse, save });

  assert.deepEqual(parsedBodies, [BOI.body]);
  assert.equal(result.sent, 1);
  assert.deepEqual(result.banks, ["boi"]);
  const sentText = JSON.stringify(batches);
  assert.ok(!sentText.includes("send me the money"), "a personal message must never be sent");
  assert.ok(!sentText.includes("Shop again"), "an unknown sender must never be sent");
  assert.ok(!sentText.includes(BOI.body), "raw text never leaves the phone");
  const [entry] = batches[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    "amount", "balance", "bank", "date", "due_date", "hash", "isin", "kind", "last4", "payee", "quantity", "ref", "sender",
  ]);
  assert.equal(entry.sender, BOI.sender);
  assert.equal(entry.bank, "boi");
  assert.equal(entry.amount, "243.00");
  assert.equal(entry.due_date, null);
  assert.equal(entry.hash, await sha256(`${BOI.sender}\n${bank.date}\n${BOI.body}`));
  assert.match(entry.hash, /^[0-9a-f]{64}$/);
});

test("test_last_read_advances_only_after_success", async () => {
  const base = NOW.getTime() - 10 * DAY;
  const messages = Array.from({ length: BATCH_SIZE * 2 + 5 }, (_, i) => boiMessage(i, base + i * 1000));
  const { read } = inbox(messages);
  const { post, batches } = recorder({ failOn: 2 });
  const start = settings();
  const { save, state } = saver(start);

  await assert.rejects(syncSms({ read, post, hash: sha256, settings: start, now: NOW, save }), /network down/);

  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, BATCH_SIZE);
  // Batch 1 is the oldest 50, posted first; lastReadAt stops at its newest.
  assert.equal(state.current.lastReadAt, messages[BATCH_SIZE - 1].date);

  // The next run picks up from there and resends batch 2 onward.
  const again = recorder();
  const result = await syncSms({ read, post: again.post, hash: sha256, settings: state.current, now: NOW, save });
  assert.equal(result.sent, BATCH_SIZE + 5);
  assert.equal(state.current.lastReadAt, messages.at(-1).date);
});

test("test_messages_sharing_a_time_are_not_split_past_the_mark", async () => {
  // Two messages with the same timestamp straddle the batch boundary: a failed second batch must
  // leave the mark below that time so the second one is read again.
  const base = NOW.getTime() - DAY;
  const messages = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => boiMessage(i, base + Math.min(i, BATCH_SIZE - 1) * 1000));
  const { read } = inbox(messages);
  const { post } = recorder({ failOn: 2 });
  const start = settings();
  const { save, state } = saver(start);

  await assert.rejects(syncSms({ read, post, hash: sha256, settings: start, now: NOW, save }));

  assert.ok(state.current.lastReadAt < messages.at(-1).date);
});

test("test_start_date_bounds_first_run", async () => {
  const { read, calls } = inbox([]);
  const { post } = recorder();
  const { save } = saver(settings());

  await syncSms({ read, post, hash: sha256, settings: settings({ startDate: "2026-11-01" }), now: NOW, save });
  // Midnight 1 Nov in India is 31 Oct 18:30 UTC.
  assert.equal(calls[0], Date.parse("2026-10-31T18:30:00Z") - 1);
  assert.equal(startMillis("2026-11-01", NOW), Date.parse("2026-10-31T18:30:00Z"));

  // A later lastReadAt wins over the start date.
  const later = Date.parse("2026-11-05T00:00:00Z");
  await syncSms({ read, post, hash: sha256, settings: settings({ lastReadAt: later }), now: NOW, save });
  assert.equal(calls[1], later);

  // Never more than 90 days back, and an empty start date means today.
  await syncSms({ read, post, hash: sha256, settings: settings({ startDate: "2025-01-01" }), now: NOW, save });
  assert.equal(calls[2], startMillis("2026-08-14", NOW) - 1);
  assert.equal(MAX_DAYS_BACK, 90);
  await syncSms({ read, post, hash: sha256, settings: settings({ startDate: "" }), now: NOW, save });
  assert.equal(calls[3], Date.parse("2026-11-11T18:30:00Z") - 1);
});

test("test_unreadable_kept_on_phone_and_not_posted", async () => {
  const odd = { id: "9", address: "VM-HDFCBK-S", body: "ACME Bank: a/c XX1234 debited. Amt 1,250.00. Bal 9,000.00", date: NOW.getTime() - 5000 };
  const good = boiMessage(10, NOW.getTime() - 4000);
  const { read } = inbox([odd, good]);
  const { post, batches } = recorder();
  const kept = { id: "9", address: odd.address, body: odd.body, date: odd.date };
  const older = Array.from({ length: 50 }, (_, i) => ({ id: `old${i}`, address: "VM-HDFCBK-S", body: "x", date: i }));
  const start = settings({ unreadable: [kept, ...older] });
  const { save, state } = saver(start);

  const result = await syncSms({ read, post, hash: sha256, settings: start, now: NOW, save });

  assert.equal(result.unreadable, 1);
  assert.equal(result.sent, 1);
  assert.equal(batches.length, 1);
  assert.ok(!JSON.stringify(batches).includes("ACME"));
  const list = state.current.unreadable;
  assert.equal(list.length, 50, "at most 50 kept");
  assert.equal(list.filter((m) => m.id === "9").length, 1, "deduped by id");
  assert.deepEqual(list[0], kept, "newest first");
  assert.equal(state.current.lastReadAt, good.date);
});

test("test_cdsl_lines_get_indexed_hashes", async () => {
  const body = "CDSL: Debit in a/c *00418277 for 10-RELIANCE INDUSTRIES LTD EQ, 5-TATA CONSULTANCY SERV LT EQ RE.1/- on 10NOV";
  const message = { id: "20", address: "CDSLTX", body, date: NOW.getTime() - 1000 };
  const { read } = inbox([message]);
  const { post, batches } = recorder();
  const { save } = saver(settings());

  await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save });

  const [first, second] = batches[0];
  const base = `CDSLTX\n${message.date}\n${body}`;
  assert.equal(batches[0].length, 2);
  assert.equal(first.hash, await sha256(`${base}:0`));
  assert.equal(second.hash, await sha256(`${base}:1`));
  assert.equal(first.kind, "demat");
  assert.equal(first.quantity, "10");
  assert.equal(second.quantity, "5");
});

test("test_nothing_new_keeps_mark_and_ignored_messages_advance_it", async () => {
  const otp = { id: "30", address: "VM-HDFCBK-S", body: "123456 is your OTP for login. Do not share it with anyone.", date: NOW.getTime() - 1000 };
  const { read } = inbox([otp]);
  const { post, batches } = recorder();
  const { save, state } = saver(settings());

  const result = await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save });

  assert.equal(batches.length, 0);
  assert.equal(result.sent, 0);
  assert.equal(state.current.lastReadAt, otp.date);
});
