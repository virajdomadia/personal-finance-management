import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { OWNER } from "./fixtures.mjs";
import { parseSms } from "./parse.ts";
import { BATCH_SIZE, MAX_DAYS_BACK, mergeSmsSettings, startMillis, syncSms } from "./sync.ts";

const NOW = new Date("2026-11-12T10:00:00+05:30");
const DAY = 86_400_000;
const sha256 = async (text) => createHash("sha256").update(text).digest("hex");

function settings(patch = {}) {
  return { enabled: true, startDate: "2026-11-01", lastReadAt: 0, unreadable: [], banks: [], refusedIds: [], ...patch };
}

// A fake inbox like the native module: messages newer than `since`, oldest first, at most `limit`.
// Same-millisecond messages keep a stable order, as a real query would.
function inbox(messages) {
  const calls = [];
  const read = async (since, limit) => {
    calls.push(since);
    return messages
      .filter((m) => m.date > since)
      .sort((a, b) => a.date - b.date || Number(a.id) - Number(b.id))
      .slice(0, limit);
  };
  return { read, calls };
}

function recorder({ failOn, refuse } = {}) {
  const batches = [];
  const post = async (entries) => {
    batches.push(entries);
    if (failOn === batches.length) throw new Error("network down");
    if (refuse && entries.some(refuse)) throw Object.assign(new Error("API responded with 422"), { status: 422 });
  };
  return { post, batches };
}

function saver(initial) {
  const state = { current: initial };
  // Like updateSmsSettings: the update sees what is stored now.
  const save = async (update) => {
    const patch = update(state.current);
    if (patch !== null) state.current = mergeSmsSettings(state.current, patch);
  };
  return { save, state };
}

const BOI = OWNER.boiUpiDebit;

// Each gets its own amount, so each has its own hash.
function boiMessage(id, date) {
  return { id: String(id), address: BOI.sender, body: BOI.body.replace("Rs.243.00", `Rs.${1000 + Number(id)}.00`), date };
}

function demat(n, extra = {}) {
  return {
    kind: "demat", amount: null, date: "2026-11-10", last4: "8277", payee: `STOCK ${n}`, ref: "debit",
    balance: null, isin: null, quantity: String(n + 1), dueDate: null, ...extra,
  };
}

function hashesOf(batches) {
  return batches.flat().map((e) => e.hash);
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

  assert.deepEqual(parsedBodies, [bank.body]);
  assert.equal(result.sent, 1);
  assert.deepEqual(result.banks, ["boi"]);
  const sentText = JSON.stringify(batches);
  assert.ok(!sentText.includes("send me the money"), "a personal message must never be sent");
  assert.ok(!sentText.includes("Shop again"), "an unknown sender must never be sent");
  assert.ok(!sentText.includes(bank.body), "raw text never leaves the phone");
  const [entry] = batches[0];
  assert.deepEqual(Object.keys(entry).sort(), [
    "amount", "balance", "bank", "date", "due_date", "hash", "isin", "kind", "last4", "payee", "quantity", "ref", "sender",
  ]);
  assert.equal(entry.sender, BOI.sender);
  assert.equal(entry.bank, "boi");
  assert.equal(entry.amount, "1003.00");
  assert.equal(entry.due_date, null);
  assert.equal(entry.hash, await sha256(`${BOI.sender}\n${bank.date}\n${bank.body}`));
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

test("test_pages_read_every_message_once", async () => {
  const base = NOW.getTime() - 5 * DAY;
  const messages = Array.from({ length: 25 }, (_, i) => boiMessage(i, base + i * 1000));
  const { read, calls } = inbox(messages);
  const { post, batches } = recorder();
  const { save, state } = saver(settings());

  const result = await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save, pageSize: 10 });

  const hashes = hashesOf(batches);
  assert.equal(result.sent, 25);
  assert.equal(new Set(hashes).size, 25);
  assert.equal(hashes.length, 25, "none sent twice");
  assert.equal(calls.length, 3);
  assert.equal(state.current.lastReadAt, messages.at(-1).date);
});

test("test_same_millisecond_group_cut_at_page_edge_is_read_once", async () => {
  const base = NOW.getTime() - DAY;
  // Messages 7..13 share one millisecond; a page of 10 cuts that group.
  const messages = Array.from({ length: 20 }, (_, i) => boiMessage(i, base + (i < 7 ? i : i <= 13 ? 7 : i) * 1000));
  const { read } = inbox(messages);
  const { post, batches } = recorder();
  const { save, state } = saver(settings());

  const result = await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save, pageSize: 10 });

  const hashes = hashesOf(batches);
  assert.equal(result.sent, 20);
  assert.equal(new Set(hashes).size, 20);
  assert.equal(hashes.length, 20);
  assert.equal(state.current.lastReadAt, messages.at(-1).date);
});

test("test_refused_batch_is_split_and_the_refused_message_kept_on_phone", async () => {
  const base = NOW.getTime() - DAY;
  const messages = Array.from({ length: 5 }, (_, i) => boiMessage(i, base + i * 1000));
  const poison = messages[2];
  const { read } = inbox(messages);
  const { post, batches } = recorder({ refuse: (e) => e.amount === "1002.00" });
  const { save, state } = saver(settings());

  const result = await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save });

  assert.equal(result.sent, 4);
  assert.equal(result.unreadable, 1);
  assert.equal(batches[0].length, 5, "first the whole batch");
  assert.deepEqual(batches.slice(1).map((b) => b.length), [1, 1, 1, 1, 1], "then one message at a time");
  assert.deepEqual(state.current.unreadable.map((m) => m.id), [poison.id]);
  assert.equal(state.current.lastReadAt, messages.at(-1).date, "the mark moves past the refused message");

  // The next run doesn't send it again.
  const again = recorder();
  await syncSms({ read, post: again.post, hash: sha256, settings: state.current, now: NOW, save });
  assert.equal(again.batches.length, 0);
});

test("test_every_message_refused_is_systemic_and_keeps_the_mark", async () => {
  const messages = Array.from({ length: 5 }, (_, i) => boiMessage(i, NOW.getTime() - 10_000 + i * 1000));
  const { read } = inbox(messages);
  const { post } = recorder({ refuse: () => true });
  const start = settings({ startDate: "2026-11-12" });
  const { save, state } = saver(start);

  await assert.rejects(syncSms({ read, post, hash: sha256, settings: start, now: NOW, save }), /422/);

  assert.equal(state.current.lastReadAt, 0, "nothing moved past");
  assert.deepEqual(state.current.unreadable, [], "nothing dumped into the phone list");
});

// Refuses every entry except those of the messages whose ids are listed as good.
function refuseExcept(good) {
  return recorder({ refuse: (e) => !good.includes(String(Number(e.amount) - 1000)) });
}

test("test_a_lone_refused_message_is_held_then_kept_once_a_later_one_is_accepted", async () => {
  const lone = boiMessage(0, NOW.getTime() - 10_000);
  const box = [lone];
  const { read } = inbox(box);
  const { save, state } = saver(settings());

  // Run 1: the only new message is refused. It is held: not skipped, not kept, the mark stays.
  const first = await syncSms({ read, post: refuseExcept([]).post, hash: sha256, settings: state.current, now: NOW, save });
  assert.equal(first.unreadable, 0);
  assert.equal(state.current.lastReadAt, 0, "the mark doesn't pass an undecided message");
  assert.deepEqual(state.current.unreadable, []);
  assert.deepEqual(state.current.refusedIds, ["0"]);

  // Run 2: a new message arrives and is accepted, so the lone refusal was the message's own problem.
  const next = boiMessage(1, NOW.getTime() - 5_000);
  box.push(next);
  const second = refuseExcept(["1"]);
  const result = await syncSms({ read, post: second.post, hash: sha256, settings: state.current, now: NOW, save });
  assert.equal(result.sent, 1);
  assert.equal(result.unreadable, 1);
  assert.deepEqual(state.current.unreadable.map((m) => m.id), ["0"]);
  assert.equal(state.current.lastReadAt, next.date, "the mark moves past both");
  assert.deepEqual(state.current.refusedIds, []);
});

test("test_one_refused_per_run_over_three_runs_is_systemic", async () => {
  const box = [];
  const { read } = inbox(box);
  const { save, state } = saver(settings());
  const { post } = refuseExcept([]);

  // A contract mismatch: every open brings one new bank SMS, and the server refuses each.
  for (let run = 0; run < 2; run += 1) {
    box.push(boiMessage(run, NOW.getTime() - 10_000 + run * 1000));
    await syncSms({ read, post, hash: sha256, settings: state.current, now: NOW, save });
    assert.equal(state.current.lastReadAt, 0);
    assert.deepEqual(state.current.unreadable, []);
  }
  assert.deepEqual(state.current.refusedIds, ["0", "1"], "a retried message counts once");

  box.push(boiMessage(2, NOW.getTime() - 8_000));
  await assert.rejects(syncSms({ read, post, hash: sha256, settings: state.current, now: NOW, save }), /422/);
  assert.equal(state.current.lastReadAt, 0, "mark unchanged");
  assert.deepEqual(state.current.unreadable, [], "nothing drained into the phone list");

  // Still systemic on later opens, until the server accepts something.
  await assert.rejects(syncSms({ read, post, hash: sha256, settings: state.current, now: NOW, save }), /422/);
  assert.deepEqual(state.current.unreadable, []);
});

test("test_refused_refused_then_accepted_across_runs_keeps_both", async () => {
  const box = [boiMessage(0, NOW.getTime() - 10_000), boiMessage(1, NOW.getTime() - 9_000)];
  const { read } = inbox(box);
  const { save, state } = saver(settings());

  await syncSms({ read, post: refuseExcept([]).post, hash: sha256, settings: state.current, now: NOW, save });
  assert.deepEqual(state.current.refusedIds, ["0", "1"]);
  assert.equal(state.current.lastReadAt, 0);
  assert.deepEqual(state.current.unreadable, []);

  // An ignored message (an OTP) in between neither resets nor adds to the streak.
  const otp = { id: "5", address: "VM-HDFCBK-S", body: "123456 is your OTP for login. Do not share it with anyone.", date: NOW.getTime() - 8_000 };
  const good = boiMessage(2, NOW.getTime() - 7_000);
  box.push(otp, good);
  const result = await syncSms({ read, post: refuseExcept(["2"]).post, hash: sha256, settings: state.current, now: NOW, save });

  assert.equal(result.sent, 1);
  assert.deepEqual(state.current.unreadable.map((m) => m.id).sort(), ["0", "1"]);
  assert.equal(state.current.lastReadAt, good.date);
  assert.deepEqual(state.current.refusedIds, [], "the streak is back to 0");
});

test("test_ignored_messages_between_refusals_do_not_reset_the_streak", async () => {
  const otp = (id, date) => ({ id, address: "VM-HDFCBK-S", body: "123456 is your OTP for login. Do not share it with anyone.", date });
  const t = NOW.getTime() - 10_000;
  const box = [boiMessage(0, t), otp("10", t + 1000), boiMessage(1, t + 2000), otp("11", t + 3000), boiMessage(2, t + 4000)];
  const { read } = inbox(box);
  const { save, state } = saver(settings());

  await assert.rejects(syncSms({ read, post: refuseExcept([]).post, hash: sha256, settings: state.current, now: NOW, save }), /422/);
  assert.equal(state.current.lastReadAt, 0, "the ignored messages wait behind the held refusal");
  assert.deepEqual(state.current.unreadable, []);
});

test("test_three_refused_none_accepted_is_systemic", async () => {
  const messages = Array.from({ length: 3 }, (_, i) => boiMessage(i, NOW.getTime() - 10_000 + i * 1000));
  const { read } = inbox(messages);
  const { post } = recorder({ refuse: () => true });
  const { save, state } = saver(settings());

  await assert.rejects(syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save }), /422/);
  assert.equal(state.current.lastReadAt, 0);
  assert.deepEqual(state.current.unreadable, []);
});

test("test_three_refused_in_a_row_is_systemic_after_earlier_successes", async () => {
  const messages = Array.from({ length: 6 }, (_, i) => boiMessage(i, NOW.getTime() - 10_000 + i * 1000));
  const { read } = inbox(messages);
  // Messages 0 and 1 go through; from 2 on the server refuses everything.
  const { post } = recorder({ refuse: (e) => Number(e.amount) >= 1002 });
  const { save, state } = saver(settings());

  await assert.rejects(syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save }), /422/);

  assert.equal(state.current.lastReadAt, messages[1].date);
  assert.deepEqual(state.current.unreadable, []);
});

test("test_start_date_reset_during_a_sync_is_not_undone", async () => {
  const messages = Array.from({ length: 3 }, (_, i) => boiMessage(i, NOW.getTime() - 10_000 + i * 1000));
  const { read } = inbox(messages);
  const start = settings({ startDate: "2026-11-10", lastReadAt: 5 });
  const { save, state } = saver(start);
  let resetDone = false;
  const post = async () => {
    // The owner moves the start date earlier while the upload is in flight.
    if (!resetDone) await save(() => ({ startDate: "2026-11-01" }));
    resetDone = true;
  };

  await syncSms({ read, post, hash: sha256, settings: start, now: NOW, save });

  assert.equal(state.current.startDate, "2026-11-01");
  assert.equal(state.current.lastReadAt, 0, "the reset stands");
});

test("test_network_failure_while_splitting_still_stops", async () => {
  const messages = Array.from({ length: 3 }, (_, i) => boiMessage(i, NOW.getTime() - 10_000 + i * 1000));
  const { read } = inbox(messages);
  let calls = 0;
  const post = async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("422"), { status: 422 });
    if (calls === 3) throw Object.assign(new Error("502"), { status: 502 });
  };
  const { save, state } = saver(settings());

  await assert.rejects(syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save }), /502/);
  assert.equal(state.current.lastReadAt, messages[0].date);
  assert.deepEqual(state.current.unreadable, []);
});

test("test_big_cdsl_message_is_split_across_requests", async () => {
  const message = { id: "40", address: "CDSLTX", body: "CDSL: many holdings", date: NOW.getTime() - 1000 };
  const parse = () => Array.from({ length: 120 }, (_, n) => demat(n));
  const { read } = inbox([message]);
  const { post, batches } = recorder();
  const { save, state } = saver(settings());

  const result = await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save, parse });

  assert.deepEqual(batches.map((b) => b.length), [50, 50, 20]);
  assert.equal(result.sent, 120);
  const base = `CDSLTX\n${message.date}\n${message.body}`;
  assert.equal(batches[2][19].hash, await sha256(`${base}:119`));
  assert.equal(state.current.lastReadAt, message.date);
});

test("test_out_of_range_numbers_are_unreadable_and_text_is_clipped", async () => {
  const bad = [
    { amount: "1000000000000.00" },
    { amount: "12.345" },
    { balance: "9999999999999" },
    { quantity: "0" },
    { quantity: "1.123456789" },
  ];
  const messages = [...bad, {}].map((_, i) => ({ id: String(50 + i), address: "CDSLTX", body: `case ${i}`, date: NOW.getTime() - 10_000 + i }));
  const parse = (_bank, body) => {
    const i = Number(body.split(" ")[1]);
    return i < bad.length
      ? [demat(i, bad[i])]
      : [demat(i, { payee: "P".repeat(200), ref: "R".repeat(60), amount: "999999999999.99", quantity: "0.00000001" })];
  };
  const { read } = inbox(messages);
  const { post, batches } = recorder();
  const { save, state } = saver(settings());

  const result = await syncSms({ read, post, hash: sha256, settings: settings(), now: NOW, save, parse });

  assert.equal(result.unreadable, bad.length);
  assert.equal(result.sent, 1);
  const [entry] = batches[0];
  assert.equal(entry.payee.length, 120);
  assert.equal(entry.ref.length, 40);
  assert.equal(entry.amount, "999999999999.99");
  assert.equal(state.current.unreadable.length, bad.length);
  assert.equal(state.current.lastReadAt, messages.at(-1).date);
});

test("test_moving_start_date_earlier_resets_last_read", () => {
  const current = settings({ startDate: "2026-11-05", lastReadAt: 12345 });
  assert.equal(mergeSmsSettings(current, { startDate: "2026-10-01" }).lastReadAt, 0);
  assert.equal(mergeSmsSettings(current, { startDate: "2026-11-08" }).lastReadAt, 12345);
  assert.equal(mergeSmsSettings(current, { startDate: "2026-11-05" }).lastReadAt, 12345);
  assert.equal(mergeSmsSettings(current, { enabled: false }).lastReadAt, 12345);
});
