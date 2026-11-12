import assert from "node:assert/strict";
import { test } from "node:test";

import { FIXTURES, OWNER, RECEIVED } from "./fixtures.mjs";
import { maskSample } from "./mask.ts";
import { parseSms } from "./parse.ts";
import { senderBank } from "./senders.ts";

const AT = new Date(RECEIVED);
const MAIN = ["kind", "amount", "last4", "payee", "ref", "date"];
const EXTRA = ["balance", "dueDate", "isin", "quantity"];

// Checks every field the expectation names; the six main ones must always be named.
function assertLine(actual, expected, label) {
  for (const key of MAIN) {
    assert.ok(key in expected, `${label}: fixture must name ${key}`);
    assert.equal(actual[key], expected[key], `${label}: ${key}`);
  }
  for (const key of EXTRA) {
    if (key in expected) assert.equal(actual[key], expected[key], `${label}: ${key}`);
  }
}

function assertParsed(result, expected, label) {
  if (typeof expected === "string") {
    assert.equal(result, expected, `${label}: ${JSON.stringify(result)}`);
    return;
  }
  assert.ok(Array.isArray(result), `${label}: got ${JSON.stringify(result)}`);
  const lines = Array.isArray(expected) ? expected : [expected];
  assert.equal(result.length, lines.length, `${label}: line count`);
  lines.forEach((line, i) => assertLine(result[i], line, `${label} [${i}]`));
}

function parseOne(bank, body, at = AT) {
  const result = parseSms(bank, body, at);
  assert.ok(Array.isArray(result) && result.length === 1, `expected one line, got ${JSON.stringify(result)}`);
  return result[0];
}

// The owner's real samples

test("test_owner_boi_upi_debit", () => {
  const f = OWNER.boiUpiDebit;
  assertLine(parseOne(f.bank, f.body), f.expect, "boi");
});

test("test_owner_federal_imps_debit", () => {
  const f = OWNER.federalImpsDebit;
  assertLine(parseOne(f.bank, f.body), f.expect, "federal debit");
});

test("test_owner_federal_imps_credit", () => {
  const f = OWNER.federalImpsCredit;
  assertLine(parseOne(f.bank, f.body), f.expect, "federal credit");
});

test("test_owner_federal_card_spend", () => {
  const f = OWNER.federalCardSpend;
  const line = parseOne(f.bank, f.body);
  assertLine(line, f.expect, "federal card");
  assert.equal(line.balance, null, "an available limit is not a balance");
});

test("test_owner_hdfc_card_spend", () => {
  const f = OWNER.hdfcCardSpend;
  assertLine(parseOne(f.bank, f.body), f.expect, "hdfc card");
});

test("test_owner_cdsl_debit", () => {
  const f = OWNER.cdslDebit;
  for (const at of ["2026-09-08T09:00:00+05:30", "2027-01-05T09:00:00+05:30", RECEIVED]) {
    const result = parseSms(f.bank, f.body, new Date(at));
    assertParsed(result, f.expect, `cdsl received ${at}`);
  }
});

test("a year-less CDSL date never lands in the future", () => {
  const body = "CDSL: Debit in a/c *00418277 for 221-HINDUSTAN CO EQ RE.1 on 08SEP";
  const [line] = parseSms("cdsl", body, new Date("2026-09-07T23:00:00+05:30"));
  assert.equal(line.date, "2025-09-08");
});

// Every fixture

test("every fixture reads as expected", () => {
  for (const f of FIXTURES) {
    const at = f.receivedAt ? new Date(f.receivedAt) : AT;
    assertParsed(parseSms(f.bank, f.body, at), f.expect, f.name);
  }
});

test("fixtures cover each bank with at least two messages", () => {
  const counts = {};
  for (const f of FIXTURES) if (f.expect !== "ignore" && f.expect !== "unreadable") counts[f.bank] = (counts[f.bank] ?? 0) + 1;
  const banks = ["hdfc", "sbi", "icici", "axis", "kotak", "boi", "bob", "pnb", "canara", "union", "idfc", "yes", "indusind", "federal", "sbicard"];
  for (const bank of banks) assert.ok((counts[bank] ?? 0) >= 2, `${bank} has ${counts[bank] ?? 0}`);
  assert.ok(counts.cdsl >= 3 && counts.nsdl >= 3);
  assert.ok(FIXTURES.filter((f) => f.expect === "ignore").length >= 10);
});

test("test_ignores_otp_and_promotions", () => {
  const ignored = [
    "Your OTP is 556677 for a transaction of Rs.1,000.00 on card XX1234. Never share it.",
    "482913 is the One Time Password for your net banking login.",
    "Congratulations! You are eligible for a pre-approved loan of Rs 3,00,000. Apply now.",
    "Shop now and get up to 20% off with your credit card. T&C apply.",
    "Your txn of Rs.250.00 at SHOP was declined. Insufficient balance.",
    "Payment of Rs.99.00 to NETFLIX failed. Any amount debited will be refunded.",
    "Your a/c XX1234 balance is Rs.5,000.00 as on 11-11-26.",
    "Rs.1,499.00 will be debited on 15-11-26 for your SIP mandate.",
  ];
  for (const body of ignored) assert.equal(parseSms("acme", body, AT), "ignore", body);
  assert.notEqual(
    parseSms("union", "A/c *3579 Debited for Rs:250.00 on 11-11-2026. Never Share OTP/PIN/CVV", AT),
    "ignore",
    "an OTP warning in a real debit doesn't hide it",
  );
});

test("test_unknown_format_is_unreadable", () => {
  assert.equal(parseSms("acme", "ACME Bank: a/c XX1234 debited. Amt 1,250.00. Bal 9,000.00", AT), "unreadable");
  assert.equal(parseSms("acme", "Your a/c XX1234 credited. Avl Bal Rs 2,000.00", AT), "unreadable");
  assert.equal(parseSms("acme", "Your a/c XX1234 was debited", AT), "ignore", "no amount at all");
});

test("test_amount_keeps_paise_and_drops_commas", () => {
  const cases = [
    ["Rs.1,23,456.70 debited from A/c XX1234 on 10-11-26", "123456.70"],
    ["INR 15000 credited to A/c XX1234 on 10-11-26", "15000.00"],
    ["Rs 20.5 debited from A/c XX1234", "20.50"],
    ["₹1,000 spent on credit card XX1234 at SHOP", "1000.00"],
    ["A/C X1234 debited by 0099.10 on date 10Nov26", "99.10"],
    ["Rs.12,34,56,789.05 credited to A/c XX1234", "123456789.05"],
  ];
  for (const [body, amount] of cases) assert.equal(parseOne("acme", body).amount, amount, body);
});

test("test_cdsl_two_lines", () => {
  const body = "CDSL: Credit in a/c *00418277 for 10-RELIANCE INDUSTRIES LTD EQ; 2-ASIAN PAINTS LTD EQ RE.1 on 01NOV";
  const lines = parseSms("cdsl", body, AT);
  assert.ok(Array.isArray(lines));
  assert.deepEqual(
    lines.map((l) => [l.kind, l.ref, l.quantity, l.payee, l.date, l.amount]),
    [
      ["demat", "credit", "10", "RELIANCE INDUSTRIES LTD", "2026-11-01", null],
      ["demat", "credit", "2", "ASIAN PAINTS LTD", "2026-11-01", null],
    ],
  );
});

test("test_sender_prefix_and_suffix_stripped", () => {
  const cases = [
    ["VM-HDFCBK", "hdfc"],
    ["AX-HDFCBK-S", "hdfc"],
    ["HDFCBK", "hdfc"],
    ["jd-boiind-t", "boi"],
    ["BOISMS", "boi"],
    ["AX-FEDBNK-S", "federal"],
    ["VM-FEDFIB-P", "federal"],
    ["AD-SBIUPI-S", "sbi"],
    ["VM-ATMSBI", "sbi"],
    ["VM-CBSSBI", "sbi"],
    ["VM-SBIINB", "sbi"],
    ["VM-SBICRD", "sbicard"],
    ["JM-ICICIT-S", "icici"],
    ["JM-ICICIB", "icici"],
    ["VK-AXISBK-S", "axis"],
    ["BZ-KOTAKB", "kotak"],
    ["VM-BOBTXN", "bob"],
    ["VM-BOBSMS", "bob"],
    ["VM-PNBSMS", "pnb"],
    ["VM-CANBNK", "canara"],
    ["VM-UNIONB", "union"],
    ["VM-IDFCFB", "idfc"],
    ["VM-YESBNK", "yes"],
    ["VM-INDUSB", "indusind"],
    ["CDSLTX", "cdsl"],
    ["VM-CDSLEV-T", "cdsl"],
    ["VM-NSDLDP", "nsdl"],
    ["VM-SPAMMR", null],
  ];
  for (const [address, bank] of cases) assert.equal(senderBank(address), bank, address);
});

test("test_personal_number_sender_is_null", () => {
  for (const address of ["+919876543210", "9876543210", "+91 98765 43210", "", "  "]) {
    assert.equal(senderBank(address), null, address);
  }
});

test("test_mask_hides_digits_and_names", () => {
  assert.equal(
    maskSample(OWNER.boiUpiDebit.body),
    "Rs.XXX.00 debited A/cXXXXXX and credited to <name> via UPI Ref No XXXXXXXXXXXX on 11Nov26. Call XXXXXXXXXXX, if not done by you. -BOI",
  );
  assert.equal(
    maskSample("Rs 1,200.00 received from rahul.k@okicici on 10-11-26"),
    "Rs 1,XXX.00 received from <name> on 10-11-26",
  );
  for (const f of FIXTURES) {
    const masked = maskSample(f.body);
    assert.doesNotMatch(masked, /\d{3,}/, f.name);
    assert.doesNotMatch(masked, /@/, f.name);
  }
  const federal = maskSample(OWNER.federalCardSpend.body);
  assert.doesNotMatch(federal, /interg/);
  const hdfc = maskSample(OWNER.hdfcCardSpend.body);
  assert.doesNotMatch(hdfc, /AMITY/);
  const debit = maskSample(OWNER.federalImpsDebit.body);
  assert.match(debit, /to <name>\.Ref X{12}/);
});

// The general reader, on variations of the shapes above from a bank it has no patterns for

const CURRENCIES = ["Rs", "Rs.", "Rs. ", "INR ", "₹", "₹ ", "RS "];
const AMOUNTS = [
  ["1,23,456.70", "123456.70"],
  ["500", "500.00"],
  ["2,500", "2500.00"],
  ["99.5", "99.50"],
  ["12345.67", "12345.67"],
];
const DATES = ["10-11-26", "10-11-2026", "10/11/26", "10/11/2026", "10Nov26", "10-Nov-26", "10NOV2026", "10 Nov 2026", "2026-11-10"];
const MASKS = ["A/c XX1234", "a/c *1234", "Acct XX1234", "A/C X1234", "a/c no. XXXXXXXX1234", "account ending with 1234", "Ac no XX1234", "A/c **1234"];

const TEMPLATES = [
  {
    kind: "debit",
    text: (c, a, d, m) => `${c}${a} debited from ${m} on ${d} to SHOP NAME. UPI Ref 123456789012. Avl Bal Rs 1,000.00. Not you? Call 18001234567.`,
    ref: "123456789012", balance: "1000.00",
  },
  {
    kind: "debit",
    text: (c, a, d, m) => `Your ${m} has been debited with ${c}${a} on ${d}; paid to SHOP NAME (Ref No 123456789012). Helpline 18001234567`,
    ref: "123456789012", balance: null,
  },
  {
    kind: "credit",
    text: (c, a, d, m) => `Dear Customer, ${c}${a} credited to your ${m} on ${d} from SHOP NAME. RRN 123456789012. Avbl Bal: ${c}9,999.00 -ACME Bank`,
    ref: "123456789012", balance: "9999.00",
  },
  {
    kind: "debit",
    text: (c, a, d, m) => `Alert! ${m} debited for ${c}${a} on ${d} trf to SHOP NAME. Ref no 123456789012. If not done by you, call 18001234567`,
    ref: "123456789012", balance: null,
  },
];

test("the general reader handles variations", () => {
  let count = 0;
  for (const t of TEMPLATES) {
    for (const c of CURRENCIES) {
      for (const [a, amount] of AMOUNTS) {
        for (const d of DATES) {
          for (const m of MASKS) {
            const body = t.text(c, a, d, m);
            const result = parseSms("madeupbank", body, AT);
            assert.ok(Array.isArray(result) && result.length === 1, `${body} → ${JSON.stringify(result)}`);
            const [line] = result;
            assert.deepEqual(
              [line.kind, line.amount, line.last4, line.payee, line.ref, line.date, line.balance],
              [t.kind, amount, "1234", "SHOP NAME", t.ref, "2026-11-10", t.balance],
              body,
            );
            count += 1;
          }
        }
      }
    }
  }
  assert.ok(count > 1000);
});

test("the general reader handles card variations", () => {
  const cards = ["credit card ending 1234", "Credit Card XX1234", "credit card ending with 1234", "Credit Card no. XXXX XXXX 1234", "CC *1234"];
  for (const card of cards) {
    for (const c of CURRENCIES) {
      for (const [a, amount] of AMOUNTS) {
        for (const d of DATES) {
          const bodies = [
            `Alert: You have spent ${c}${a} on your ACME ${card} at SHOP NAME on ${d}. Avl limit ${c}50,000.00. Not you? SMS BLOCK to 9999999999`,
            `${c}${a} spent on ${card} at SHOP NAME on ${d}. Available Limit: ${c}50,000.00`,
            `Transaction of ${c}${a} done on ${card} at SHOP NAME on ${d}.`,
          ];
          for (const body of bodies) {
            const line = parseOne("madeupbank", body);
            assert.deepEqual(
              [line.kind, line.amount, line.last4, line.payee, line.date, line.balance],
              ["card_spend", amount, "1234", "SHOP NAME", "2026-11-10", null],
              body,
            );
          }
        }
      }
    }
  }
});

test("a card payment and a statement from a made-up bank", () => {
  const paid = parseOne("madeupbank", "Thank you for your payment of Rs.3,000.00 towards your credit card ending 1234 received on 10-11-26.");
  assert.deepEqual([paid.kind, paid.amount, paid.last4, paid.date], ["card_payment", "3000.00", "1234", "2026-11-10"]);
  const statement = parseOne(
    "madeupbank",
    "Statement for your ACME credit card XX1234: Min amt due Rs.500.00, Total amount due Rs.10,000.00, due by 05DEC.",
  );
  assert.deepEqual(
    [statement.kind, statement.amount, statement.last4, statement.date, statement.dueDate],
    ["card_statement", "10000.00", "1234", "2026-11-12", "2026-12-05"],
  );
});

test("helpline and phone numbers are never amounts or refs", () => {
  const line = parseOne("madeupbank", "Rs 75 debited from A/c XX1234 to TEA STALL. Call 18001031906 or SMS BLOCK to 9876543210 if not you");
  assert.equal(line.amount, "75.00");
  assert.equal(line.ref, null);
  assert.equal(line.payee, "TEA STALL");
});

test("a date with no message date falls back to the IST day it arrived", () => {
  // 20:00 UTC on 11 Nov is 01:30 on 12 Nov in India.
  const line = parseOne("madeupbank", "Rs 75 debited from A/c XX1234 to TEA STALL", new Date("2026-11-11T20:00:00Z"));
  assert.equal(line.date, "2026-11-12");
});

test("a message date after its arrival is not used", () => {
  const line = parseOne("madeupbank", "Rs 75 debited from A/c XX1234 on 20-11-26 to TEA STALL", AT);
  assert.equal(line.date, "2026-11-12");
});

test("an account mask with three digits gives no last4, a payee mask stays as text", () => {
  const line = parseOne("madeupbank", "Rs 500.00 debited from A/c XX123 to A/c XX6120 via IMPS on 10-11-26");
  assert.equal(line.last4, null);
  assert.equal(line.payee, "A/c XX6120");
});

test("a debit card spend is a bank debit, matched by the card's last four", () => {
  const line = parseOne("madeupbank", "Rs.420.00 spent on your Debit Card ending 5566 at CAFE on 10-11-26. Avl Bal Rs 3,000.00");
  assert.deepEqual([line.kind, line.last4, line.payee, line.balance], ["debit", "5566", "CAFE", "3000.00"]);
});

test("more shapes the general reader understands", () => {
  const cases = [
    // [body, kind, amount, last4, payee, ref]
    ["INR 500 sent to John Doe on 10-11-26 from A/c XX1234", "debit", "500.00", "1234", "John Doe", null],
    ["Dear Customer, Rs.10,000.00 is credited to your account XX1234 by NEFT from EMPLOYER PVT LTD on 10-11-2026. -Bank", "credit", "10000.00", "1234", "EMPLOYER PVT LTD", null],
    ["UPDATE: INR 1,234.00 debited from HDFC Bank XX1234 on 10-NOV-26. Info: UPI-SWIGGY-123456789012. Avl bal:INR 5,000.00", "debit", "1234.00", "1234", "SWIGGY", "123456789012"],
    ["Your A/c XX1234 credited INR 2,000.00 on 10/11/26 -Deposit by transfer from RAMESH K. Avl Bal INR 7,000.00", "credit", "2000.00", "1234", "RAMESH K", null],
    ["Acct XX1234 debited with INR 300.00 on 10-Nov-26 & credited to VPA abc@ybl. UPI Ref 123456789012", "debit", "300.00", "1234", "abc@ybl", "123456789012"],
    ["Rs 250 paid to Zomato via your Paytm Payments Bank a/c XX1234 on 10 Nov 2026. Ref 123456789012", "debit", "250.00", "1234", "Zomato", "123456789012"],
    ["EMI of Rs 2,345 for loan a/c XX9988 debited from a/c XX1234 on 10-11-26", "debit", "2345.00", "1234", null, null],
    ["Charges of Rs 59.00 debited from A/c XX1234 for insufficient balance on 10-11-26", "debit", "59.00", "1234", null, null],
    ["INR 1,234.50 spent using ACME Bank Card XX9012 on 10-Nov-26 on AMAZON. Avl Limit: INR 45,000.00", "card_spend", "1234.50", "9012", "AMAZON", null],
  ];
  for (const [body, kind, amount, last4, payee, ref] of cases) {
    const line = parseOne("madeupbank", body);
    assert.deepEqual([line.kind, line.amount, line.last4, line.payee, line.ref, line.date], [kind, amount, last4, payee, ref, "2026-11-10"], body);
  }
});

// Review fix round 1

test("a refund, reversal or cashback onto a credit card is a credit, not a card payment", () => {
  const refund = parseOne("hdfc", "Refund of Rs 799.00 from AMAZON credited to HDFC Bank Credit Card XX1234 on 10-11-26");
  assert.deepEqual([refund.kind, refund.amount, refund.last4, refund.payee], ["credit", "799.00", "1234", "AMAZON"]);
  const reversal = parseOne("madeupbank", "Reversal of Rs 500 credited to your Credit Card ending 1234");
  assert.deepEqual([reversal.kind, reversal.amount, reversal.last4], ["credit", "500.00", "1234"]);
  const cashback = parseOne("madeupbank", "Rs.250 cashback credited to your credit card XX1234");
  assert.deepEqual([cashback.kind, cashback.amount, cashback.last4], ["credit", "250.00", "1234"]);
  // Payment wording still makes a card payment.
  const paid = parseOne("madeupbank", "Payment of Rs 3,000.00 credited towards your credit card XX1234 on 10-11-26");
  assert.deepEqual([paid.kind, paid.amount, paid.last4], ["card_payment", "3000.00", "1234"]);
});

test("reward points are not rupees", () => {
  for (const body of [
    "Your A/c XX1234 has been credited with 250 reward points",
    "Your card XX1234 has been credited with 500 reward points worth Rs.125",
    "1,200 miles credited to your card XX1234",
  ]) {
    assert.equal(parseSms("madeupbank", body, AT), "ignore", body);
  }
});

test("a UPI money request is not a credit", () => {
  for (const body of [
    "Request to pay Rs 300 received from ramesh@upi. Approve in app",
    "You have received a money request of Rs 300 from ramesh@upi. Approve on iMobile",
  ]) {
    assert.equal(parseSms("madeupbank", body, AT), "ignore", body);
  }
});

test("an earlier debit reversed is a credit to the owner's account", () => {
  for (const body of [
    "Rs.500 debited from A/c XX1234 has been reversed on 10-11-26",
    "Your UPI txn of Rs 500 debited on 10-11-26 has been reversed to A/c XX1234",
    "Txn of Rs 500 debited from A/c XX1234 is reversed and credited back",
  ]) {
    const line = parseOne("madeupbank", body);
    assert.deepEqual([line.kind, line.amount, line.last4, line.payee], ["credit", "500.00", "1234", null], body);
  }
});

test("the mask hides a name after 'by' but keeps 'by you'", () => {
  assert.equal(maskSample("Rs 500 credited by RAHUL SHARMA on 10-11-26"), "Rs XXX credited by <name> on 10-11-26");
  assert.match(maskSample("if not done by you"), /by you/);
});

test("a statement's due date may follow the card it names", () => {
  const line = parseOne("hdfc", "Rs.2000 payment due on HDFC Card XX1234 on 15-11-26");
  assert.deepEqual([line.kind, line.amount, line.last4, line.dueDate], ["card_statement", "2000.00", "1234", "2026-11-15"]);
});
