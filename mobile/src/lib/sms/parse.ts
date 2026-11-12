// Reads a bank, card or depository SMS into the fields the server takes. Pure text work: no Expo
// API, no network. Bank-specific patterns are tried first, then a general reader that looks for the
// usual words (an amount after Rs/INR/₹, debited/credited/spent, an A/c or Card mask, a payee after
// to/at/from, a reference, a balance) wherever they sit in the message.
//
// Amounts stay text: commas are dropped and paise padded to two places, never via floating point.
// Dates are read from the message when it has one, else the day it arrived in India.

export type SmsKind = "debit" | "credit" | "card_spend" | "card_payment" | "card_statement" | "demat";

export type Parsed = {
  kind: SmsKind;
  amount: string | null;
  date: string; // YYYY-MM-DD
  last4: string | null;
  payee: string | null;
  ref: string | null; // for demat lines, the direction: "debit" or "credit"
  balance: string | null;
  isin: string | null;
  quantity: string | null;
  dueDate: string | null;
};

export type ParseResult = Parsed[] | "unreadable" | "ignore";

const NUM = String.raw`[0-9][0-9,]*(?:\.[0-9]+)?`;
const CUR = String.raw`(?<![a-z])(?:rs\.?|inr|₹)`;
const CARD_KINDS = new Set<SmsKind>(["card_spend", "card_payment", "card_statement"]);
const IST_MS = 330 * 60_000;

// Text from here on is the bank's sign-off: helplines, "Not you?", blocking instructions.
const TRAILER =
  /\b(?:not\s+(?:you|u)\b|not\s+done\s+by|if\s+not\s+(?:done|made|initiated|you|u)\b|call\s*(?:us|on|at)?\s*[:-]?\s*\+?\d|dial\s*\d|to\s+block|sms\s+block|report\s+(?:fraud|at|to)|for\s+dispute|helpline|customer\s+care|in\s+case\s+of|never\s+share|do\s+not\s+share)/i;

// Money

/** "1,23,456.7" → "123456.70"; null for zero or anything that isn't a number. */
export function money(raw: string): string | null {
  const match = /^0*(\d+)(?:\.(\d*))?$/.exec(raw.replace(/,/g, ""));
  if (!match) return null;
  const whole = match[1];
  const paise = `${match[2] ?? ""}00`.slice(0, 2);
  if (/^0+$/.test(whole) && paise === "00") return null;
  return `${whole}.${paise}`;
}

// An amount right after these words is a balance, a limit or a due, not what moved.
const NOT_MOVED = /(?:bal(?:ance)?|limit|lmt|due|outstanding|o\/s|av(?:l|lbl|bl|ailable)\.?\s*amt)\W*(?:is\W*|of\W*)?$/i;
const CUR_AMOUNT = new RegExp(String.raw`${CUR}\s*:?\s*(${NUM})`, "gi");
const AMOUNT_CUR = /(?<![\d,.])(\d[\d,]*\.\d{1,2})\s*(?:inr|rs)\b/gi;
// SBI writes "debited by 20.0" with no currency.
const BARE_AMOUNT = new RegExp(
  String.raw`\b(?:debited|credited|withdrawn|deducted|debit|credit)\s+(?:by|for|with|of)\s+(?:an?\s+amount\s+of\s+)?(${NUM})(?![\d/:-])(?!\s*(?:reward\s+)?(?:points?|pts|miles|coins)\b)`,
  "gi",
);

function firstAmount(text: string, pattern: RegExp, skip: RegExp): string | null {
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index);
    if (skip.test(before)) continue;
    const value = money(match[1]);
    if (value) return value;
  }
  return null;
}

function amountOf(text: string, skip: RegExp = NOT_MOVED): string | null {
  return firstAmount(text, CUR_AMOUNT, skip) ?? firstAmount(text, AMOUNT_CUR, skip) ?? firstAmount(text, BARE_AMOUNT, skip);
}

function mentionsAmount(text: string): boolean {
  return new RegExp(CUR_AMOUNT.source, "i").test(text) || /\d[\d,]*\.\d{2}(?!\d)/.test(text);
}

const BALANCE = new RegExp(
  String.raw`(?<![a-z])(?:avl|avbl|avlbl|avail(?:able)?\.?|total|net|new|clr|closing)?\s*bal(?:ance)?(?!\s*(?:limit|lmt))\s*(?:is|of)?[\s:.-]*(?:(?:rs\.?|inr|₹)\s*:?\s*)?(${NUM})`,
  "i",
);

function balanceOf(text: string): string | null {
  const match = BALANCE.exec(text);
  return match ? money(match[1]) : null;
}

// Dates

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MON = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const YMD = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
const DMY = /(?<![\d/-])(\d{1,2})[-/](\d{1,2})[-/](\d{4}|\d{2})(?![\d/-])/g;
const D_MON_Y = new RegExp(String.raw`(?<!\d)(\d{1,2})[\s/-]?${MON}(?![a-z])\.?(?:[\s/,'-]*(\d{4}|\d{2})(?![\d:]))?`, "gi");

type DateHit = { year: number | null; month: number; day: number; index: number; end: number };

/** The day `when` falls on in India, as YYYY-MM-DD. */
export function istDay(when: Date): string {
  return new Date(when.getTime() + IST_MS).toISOString().slice(0, 10);
}

function ymd(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function fullYear(text: string): number {
  return text.length === 2 ? 2000 + Number(text) : Number(text);
}

function dateHits(text: string): DateHit[] {
  const hits: DateHit[] = [];
  const add = (m: RegExpMatchArray, year: number | null, month: number, day: number) =>
    hits.push({ year, month, day, index: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
  for (const m of text.matchAll(YMD)) add(m, Number(m[1]), Number(m[2]), Number(m[3]));
  for (const m of text.matchAll(DMY)) add(m, fullYear(m[3]), Number(m[2]), Number(m[1]));
  for (const m of text.matchAll(D_MON_Y)) {
    add(m, m[3] ? fullYear(m[3]) : null, MONTH_NAMES.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, Number(m[1]));
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** A message date, never after the day it arrived; with no year, the latest such day not after it. */
function pastDay(hit: DateHit, received: string): string | null {
  if (hit.year === null) {
    const year = Number(received.slice(0, 4));
    for (let y = year; y > year - 8; y -= 1) {
      const day = ymd(y, hit.month, hit.day);
      if (day && day <= received) return day;
    }
    return null;
  }
  const day = ymd(hit.year, hit.month, hit.day);
  if (!day) return null;
  return day > received ? received : day;
}

/** A due date, which is usually ahead; with no year, the next such day from about now. */
function dueDay(hit: DateHit, received: string): string | null {
  if (hit.year !== null) return ymd(hit.year, hit.month, hit.day);
  const year = Number(received.slice(0, 4));
  const day = ymd(year, hit.month, hit.day);
  const twoMonthsAgo = new Date(Date.parse(received) - 60 * 86_400_000).toISOString().slice(0, 10);
  if (day && day >= twoMonthsAgo) return day;
  return ymd(year + 1, hit.month, hit.day);
}

function dateIn(text: string, received: string): string | null {
  for (const hit of dateHits(text)) {
    const day = pastDay(hit, received);
    if (day) return day;
  }
  return null;
}

// Accounts and cards

// "A/c XX1234", "a/c *1234", "Acct XX123", "Card ending with 1234", "account no. XXXXXXXX1234",
// "Card Account 4xxx9012", "a/c ...6789", "demat a/c IN30xxxxxx4321".
const ACCOUNT = new RegExp(
  String.raw`\b(?:account|acct|a\/c|ac(?=[\s.:*x\d])|cc(?=[\s.:*x\d])|card)(?:\s*(?:no|number|num)\b\.?)?(?:\s*(?:ending|ends)(?:\s*(?:with|in))?)?[\s:.#-]*(?:(?:IN)?\d{0,6}[x*•][x*•.\s-]*)?(\d{3,})(?!\d)`,
  "gi",
);
const BARE_MASK = /(?<![\w/])[x*]{2,}(\d{4})(?!\d)/gi;

function toLast4(digits: string): string | null {
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/** The owner's account or card. In a debit, a mask after "to" is the payee's, so it's passed over. */
function last4Of(text: string, kind: SmsKind): string | null {
  const payeeSide = kind === "debit" || kind === "card_spend";
  for (const pattern of [ACCOUNT, BARE_MASK]) {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index);
      if (payeeSide && /\bto\s*$/i.test(before)) continue;
      if (/\bloan\s*$/i.test(before)) continue; // "EMI for loan a/c XX9988 debited from a/c XX1234"
      return toLast4(match[1]);
    }
  }
  return null;
}

// Payees

const NAME_END = String.raw`(?=\s+(?:via|on|credited|debited|ref(?:no)?|rrn|upi|imps|neft|rtgs|using|for|from|with|avl|avbl|avail(?:able)?|bal|info|dated|thru|through|is|has|was|and|by|towards|at|txn|transaction)\b|\s*\.(?:\s|$)|\.(?=(?:ref|rrn|avl|avbl|bal|upi|not|call|if|info|total|txn)\b)|\s*[,;(|]|\s+-|$)`;
const UPI_PATH = new RegExp(String.raw`\bUPI(?:\/[A-Z0-9]{2,5})?\/(\d{6,})\/(.+?)(?=\/|${NAME_END.slice(3)}`, "i");
const VPA = /\bVPA[:\s]+([\w.-]+@[\w.-]+)/i;
const INFO = /\binfo[:\s]+(.+?)(?=\s*[.;]|$)/i;
const STARTS_WITH_DATE = new RegExp(String.raw`^\d{1,2}[\s/-]?${MON}(?![a-z])`, "i");
const CHANNEL = /^(?:upi|imps|neft|rtgs|nach|ecs|mob(?:ile)?\s*b(?:an)?k(?:ing)?|net\s*banking|internet\s*banking|cash|cheque|clearing)$/i;

/** Tidies a payee, or null when it is no payee at all ("your A/c", a phone number, "UPI"). */
export function cleanPayee(raw: string): string | null {
  const text = raw
    .replace(/\s+/g, " ")
    .replace(/^(?:\d{6,}\s*)+/, "") // a card terminal's number before the merchant's name
    .replace(/^vpa\s+/i, "")
    .replace(/^[\s:'"-]+|[\s.,:;'"-]+$/g, "");
  if (!text) return null;
  if (/^(?:your|you|ur|self|date|a\/c\s+linked|block|dispute|report)\b/i.test(text)) return null;
  if (/^(?:rs\.?|inr|₹)\s*\d/i.test(text)) return null;
  if (/^\d[\d\s:/-]*$/.test(text) || /^\d{1,2}[-/]\d/.test(text) || STARTS_WITH_DATE.test(text)) return null;
  if (CHANNEL.test(text)) return null;
  return text.slice(0, 120);
}

function firstAfter(words: string, text: string): string | null {
  const pattern = new RegExp(String.raw`\b(?:${words})\s+(?![,;(|.])(.+?)${NAME_END}`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const payee = cleanPayee(match[1]);
    if (payee) return payee;
    pattern.lastIndex = match.index + 1;
  }
  return null;
}

function payeeOf(kind: SmsKind, text: string): string | null {
  const path = UPI_PATH.exec(text);
  if (path) {
    const payee = cleanPayee(path[2]);
    if (payee) return payee;
  }
  const vpa = VPA.exec(text);
  if (vpa) return cleanPayee(vpa[1]);
  const info = INFO.exec(text);
  if (info) {
    // "Info: UPI-SWIGGY-123456789012" → "SWIGGY": the channel and the reference aren't the payee.
    const words = info[1].split(/[-/]/).filter((part) => !CHANNEL.test(part.trim()) && !/^\s*(?:\d+|P2[AM])\s*$/i.test(part));
    const payee = cleanPayee(words.join(" "));
    if (payee) return payee;
  }
  if (kind === "debit") return firstAfter("to", text) ?? firstAfter("at", text);
  if (kind === "credit") return firstAfter("from", text) ?? firstAfter("by", text);
  if (kind === "card_spend") return firstAfter("at", text) ?? firstAfter("to", text) ?? firstAfter("on", text);
  return null;
}

// References

const REF = new RegExp(
  String.raw`\b(?:upi\s*ref(?:erence)?(?:\s*no)?|imps\s*ref(?:\s*no)?|ref(?:erence)?(?:\s*(?:no|number|id))?|rrn(?:\s*no)?|utr(?:\s*no)?|txn\s*(?:id|no|ref)|transaction\s*(?:id|no|number|ref)|upi)\b\.?[\s:.#/-]*((?=[a-z]*\d)[a-z0-9]{6,40})(?![a-z0-9])`,
  "i",
);

function refOf(text: string): string | null {
  const path = UPI_PATH.exec(text);
  if (path) return path[1];
  const ref = REF.exec(text)?.[1];
  if (ref) return ref;
  return /[-/](\d{6,40})\b/.exec(INFO.exec(text)?.[1] ?? "")?.[1] ?? null;
}

// Kinds

const DEBIT =
  /\b(?:debited|debit(?=\s+(?:of|for|alert|txn|transaction)\b)|withdrawn|withdrawal|sent|paid|deducted|dr\.?(?=\s+(?:from|to|in|of)\b))/i;
const CREDIT =
  /\b(?:credited|credit(?=\s+(?:of|for|alert|txn|transaction)\b)|received|deposited|refunded|refund|reversed|cr\.?(?=\s+(?:to|in|from)\b))/i;
const SPEND = /\b(?:spent|purchased?\s+(?:of|for|at|worth)|used\s+for)\b/i;
const WEAK_SPEND = /\b(?:txn|transaction|trxn)\s+(?:of|for|worth)\b/i;
const BANK_ACCOUNT = /\b(?:a\/c|acct|account)\b|\bac(?=[\s.:*x\d])/i;

function creditCard(text: string): boolean {
  return /credit\s*card|\bcc\b/i.test(text);
}

function anyCard(text: string): boolean {
  return creditCard(text) || (/\bcard\b/i.test(text) && !/\b(?:debit|atm)\s*card\b/i.test(text));
}

/** The kind the earliest money word gives; the first word wins ("debited ... and credited to X"). */
function kindOf(text: string): SmsKind | null {
  const found = [
    { kind: "debit", index: text.search(DEBIT) },
    { kind: "credit", index: text.search(CREDIT) },
    { kind: "spend", index: text.search(SPEND) },
  ].filter((f) => f.index >= 0);
  found.sort((a, b) => a.index - b.index);
  const word = found[0]?.kind ?? (WEAK_SPEND.test(text) ? "spend" : null);
  if (word === null) return null;
  const cardOnly = creditCard(text) && !BANK_ACCOUNT.test(text);
  if (word === "spend") return anyCard(text) ? "card_spend" : "debit";
  if (word === "debit") return cardOnly ? "card_spend" : "debit";
  // Money onto a card is a credit (a refund, reversal or cashback). Only payment wording, caught
  // before this, makes it a card_payment.
  return "credit";
}

// Messages that are not a transaction

const PAST = /\b(?:debited|credited|spent|withdrawn|sent|received|deposited|paid|deducted)\b/i;
const OTP = /\b(?:otp|one[\s-]*time[\s-]*pass(?:word|code)|verification\s+code|passcode|tpin)\b/i;
const PROMO =
  /\b(?:pre-?approved|apply\s+now|offers?\b|limited\s+period|hurry|click\b|t\s*&\s*c|upgrade\s+now|you\s+are\s+eligible|congratulations|instant\s+loan|loan\s+of\s+up\s*to|get\s+up\s*to|shop\s+now|to\s+avail|avail\s+now)/i;
const FAILED =
  /\b(?:declined|failed|failure|unsuccessful|not\s+successful|could\s+not\s+be\s+(?:processed|completed)|rejected|bounced|dishonou?red)\b/i;
const SHORT_OF_FUNDS = /\binsufficient\s+(?:funds|bal(?:ance)?)\b/i;
const NOT_YET =
  /\b(?:will|to)\s+be\s+(?:auto-?)?(?:debited|credited|deducted|charged)\b|\brequested\s+(?:money|payment)\b|\bcollect\s+request\b|\bpayment\s+request\b|\bis\s+scheduled\b|\bupcoming\b/i;
// A UPI request asks for money; nothing has moved.
const REQUEST = /\brequest\b/i;
const REQUEST_ACTION = /\b(?:approve|accept|decline|reject|collect|pay)\b/i;
// Points, miles or coins credited are not rupees.
const POINTS_MOVED =
  /\b(?:credited|debited|redeemed)\b(?:\s+(?:with|by|for|of))?\s+\d[\d,]*(?:\.\d+)?\s*(?:reward\s+)?(?:points?|pts|miles|coins)\b/i;
// "Rs.500 debited from A/c XX1234 has been reversed": the earlier debit came back.
const REVERSED = /\b(?:has\s+been|have\s+been|is|was|been)\s+reversed\b|\breversed\s+(?:to|and|into)\b|\bcredited\s+back\b/i;

function ignorable(text: string, region: string): boolean {
  if (OTP.test(text) && !PAST.test(text)) return true;
  if (PROMO.test(region)) return true;
  if (NOT_YET.test(text)) return true;
  if (REQUEST.test(text) && REQUEST_ACTION.test(text)) return true;
  if (POINTS_MOVED.test(text)) return true;
  // A failed payment is ignored, but money put back after one is a credit.
  if (FAILED.test(text) && !(/\bcredited\b/i.test(text) && /\b(?:revers|refund)/i.test(text))) return true;
  // A bounce is ignored, but the bank's fee for it is a real debit.
  if (SHORT_OF_FUNDS.test(text) && !(/\b(?:charges?|fee|penalty)\b/i.test(text) && PAST.test(text))) return true;
  return false;
}

// Card payments and statements

const CARD_PAYMENT =
  /\b(?:payment|pymt|paymt)\b.{0,60}?\b(?:received|credited|successful(?:ly)?|processed|posted)\b|\breceived\b.{0,40}?\bpayment\b|\bthank\s*(?:you|u)\s+for\s+(?:your\s+|the\s+)?payment\b/i;
const STATEMENT =
  /\b(?:tot(?:al|\.)?\s*(?:amt\.?|amount)?\s*(?:due|payable|outstanding)|min(?:imum)?\.?\s*(?:amt\.?|amount)?\s*(?:due|payable)|due\s+(?:date|by|on)|pay(?:able)?\s+by|statement)\b/i;
const TOTAL_DUE = new RegExp(
  String.raw`\btot(?:al|\.)?\s*(?:amt\.?|amount)?\s*(?:due|payable|outstanding)\b[^0-9]{0,20}?(${NUM})`,
  "i",
);
const DUE_WORDS = /\b(?:due\s*(?:date|by|on)?|pay(?:able)?\s+(?:by|before))\b\s*(?:is\b|:|-)?\s*(?:on\b|by\b)?\s*/gi;
const NOT_TOTAL = /(?:min(?:imum)?\.?\s*(?:amt\.?|amount)?\s*(?:due|payable)?|limit|lmt|bal(?:ance)?)\W*$/i;

function blank(line: Partial<Parsed> & { kind: SmsKind; date: string }): Parsed {
  return {
    amount: null,
    last4: null,
    payee: null,
    ref: null,
    balance: null,
    isin: null,
    quantity: null,
    dueDate: null,
    ...line,
  };
}

const CARD_BEFORE_DATE = /^[a-z\s]{0,30}\bcard\b[\s\w*.•]{0,25}?\b(?:on|by)\s*$/i;

function statement(text: string, received: string): ParseResult {
  const total = TOTAL_DUE.exec(text);
  const amount = (total && money(total[1])) || amountOf(text, NOT_TOTAL);
  if (!amount) return "ignore";
  let dueDate: string | null = null;
  let rest = text;
  for (const words of text.matchAll(DUE_WORDS)) {
    const from = (words.index ?? 0) + words[0].length;
    const after = text.slice(from, from + 60);
    // The date right after the due words, or after a card named in between ("due on HDFC Card
    // XX1234 on 15-11-26").
    const hit = dateHits(after).find((h) => h.index === 0 || CARD_BEFORE_DATE.test(after.slice(0, h.index)));
    const day = hit && dueDay(hit, received);
    if (hit && day) {
      dueDate = day;
      rest = text.slice(0, from) + " ".repeat(hit.end) + text.slice(from + hit.end);
      break;
    }
  }
  return [
    blank({
      kind: "card_statement",
      amount,
      date: dateIn(rest, received) ?? received,
      last4: last4Of(text, "card_statement"),
      dueDate,
    }),
  ];
}

// Bank-specific patterns, tried before the general reader. Named groups fill those fields; the
// general reader fills the rest.

type BankPattern = { kind: SmsKind; re: RegExp };

function pattern(source: string): RegExp {
  return new RegExp(source.replaceAll("NUM", NUM), "i");
}

const BANK_PATTERNS: Record<string, BankPattern[]> = {
  boi: [
    {
      kind: "debit",
      re: pattern(
        String.raw`^Rs\.?\s*(?<amount>NUM) debited A\/c\s*[X*]*(?<acct>\d{3,}) and credited to (?<payee>.+?) via UPI Ref No (?<ref>\d+) on (?<date>\d{1,2}[a-z]{3}\d{2,4})`,
      ),
    },
  ],
  federal: [
    {
      kind: "debit",
      re: pattern(
        String.raw`^Debited (?:Rs\.?|INR) ?(?<amount>NUM) from a\/c [X*]*(?<acct>\d{3,}) on (?<date>\S+?)(?: [\d:]+)? via \w+ to (?<payee>.+?)\.\s*Ref (?<ref>\w+)`,
      ),
    },
    {
      kind: "credit",
      re: pattern(String.raw`^(?:Rs\.?|INR) ?(?<amount>NUM) credited to your A\/c [X*]*(?<acct>\d{3,}) via \w+ on (?<date>\S+)`),
    },
    {
      kind: "card_spend",
      re: pattern(
        String.raw`^INR (?<amount>NUM) spent on your credit card ending with (?<acct>\d{4}) at (?<payee>.+?) on (?<date>\d{2}-\d{2}-\d{4})`,
      ),
    },
  ],
  hdfc: [
    {
      kind: "card_spend",
      re: pattern(
        String.raw`^Spent (?:Rs\.?|INR) ?(?<amount>NUM) On HDFC Bank Card (?<acct>\d{4}) At (?<payee>.+?) On (?<date>\d{4}-\d{2}-\d{2})`,
      ),
    },
  ],
  icici: [
    {
      kind: "debit",
      re: pattern(
        String.raw`Acct [X*]*(?<acct>\d{3,}) debited for (?:Rs\.?|INR) ?(?<amount>NUM) on (?<date>\S+?); (?<payee>.+?) credited`,
      ),
    },
    {
      kind: "card_spend",
      re: pattern(
        String.raw`(?:INR|Rs\.?) ?(?<amount>NUM) spent using ICICI Bank Card [X*]*(?<acct>\d{4}) on (?<date>\S+?) on (?<payee>.+?)\.(?:\s|$)`,
      ),
    },
  ],
  axis: [
    {
      kind: "card_spend",
      re: pattern(
        String.raw`^Spent (?:INR|Rs\.?) ?(?<amount>NUM); Axis Bank Card no\. [X*]*(?<acct>\d{4}); (?<date>\S+?),? [\d:]+(?: IST)?; (?<payee>[^;]+);`,
      ),
    },
  ],
};

function line(kind: SmsKind, text: string, region: string, received: string, known: Partial<Parsed> = {}): Parsed {
  return blank({
    kind,
    amount: amountOf(region) ?? amountOf(text),
    date: dateIn(region, received) ?? dateIn(text, received) ?? received,
    last4: last4Of(region, kind),
    payee: payeeOf(kind, region),
    ref: refOf(region),
    balance: CARD_KINDS.has(kind) ? null : balanceOf(text),
    ...known,
  });
}

function bankSpecific(bank: string, text: string, region: string, received: string): Parsed | null {
  for (const { kind, re } of BANK_PATTERNS[bank] ?? []) {
    const groups = re.exec(text)?.groups;
    const amount = groups?.amount ? money(groups.amount) : null;
    if (!groups || !amount) continue;
    const known: Partial<Parsed> = { amount };
    if (groups.acct !== undefined) known.last4 = toLast4(groups.acct);
    if (groups.payee !== undefined) known.payee = cleanPayee(groups.payee);
    if (groups.ref !== undefined) known.ref = groups.ref;
    const date = groups.date === undefined ? null : dateIn(groups.date, received);
    if (date) known.date = date;
    return line(kind, text, region, received, known);
  }
  return null;
}

// Depositories: one line per security moved.

const ISIN = /^IN[A-Z][A-Z0-9]{8}\d$/;
const QTY = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const QTY_THEN_ISIN = new RegExp(
  String.raw`${QTY}\s*(?:shares?|units?|securities|qty)?\s*(?:of\s+)?(?:ISIN\s*:?\s*)?(IN[A-Z0-9]{10})(?:\s*\(([^)]+)\))?`,
  "gi",
);
const ISIN_THEN_QTY = new RegExp(
  String.raw`(?:ISIN\s*:?\s*)?(IN[A-Z0-9]{10})(?:\s*\(([^)]+)\))?\s*,?\s*(?:qty|quantity)\s*:?\s*${QTY}`,
  "gi",
);

type Holding = { quantity: string; name: string | null; isin: string | null };

function securityName(text: string): string | null {
  const name = text
    .replace(/[\s-]+(?:EQ|BE|SM)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return name ? name.slice(0, 120) : null;
}

function holdings(text: string): Holding[] {
  // CDSL: "for 10-RELIANCE INDUSTRIES LTD EQ, 5-TCS LTD EQ on 08SEP"
  const list = /\bfor\s+(.+?)\s+on\s+(?=\d)/i.exec(text) ?? /\bfor\s+(.+)$/i.exec(text);
  if (list) {
    const found: Holding[] = [];
    for (const item of list[1].split(/\s*[,;]\s*(?=\d)/)) {
      const match = /^(\d[\d,]*(?:\.\d+)?)\s*-\s*(.+)$/.exec(item.trim());
      if (!match) continue;
      const isin = /\bIN[A-Z][A-Z0-9]{8}\d\b/.exec(match[2])?.[0] ?? null;
      const rest = isin ? match[2].replace(isin, "").replace(/^[\s:-]+/, "") : match[2];
      found.push({ quantity: match[1].replace(/,/g, ""), name: securityName(rest), isin });
    }
    if (found.length) return found;
  }
  // NSDL-style: "15 shares of ISIN INE009A01021 (INFOSYS LTD)" or "INE009A01021 (INFOSYS) Qty 15"
  const found: Holding[] = [];
  for (const m of text.matchAll(ISIN_THEN_QTY)) {
    if (ISIN.test(m[1])) found.push({ quantity: m[3].replace(/,/g, ""), name: m[2]?.trim() || null, isin: m[1] });
  }
  if (found.length) return found;
  for (const m of text.matchAll(QTY_THEN_ISIN)) {
    if (ISIN.test(m[2])) found.push({ quantity: m[1].replace(/,/g, ""), name: m[3]?.trim() || null, isin: m[2] });
  }
  return found;
}

function demat(text: string, received: string): ParseResult {
  if (OTP.test(text) || PROMO.test(text)) return "ignore";
  const debit = text.search(/\b(?:debit(?:ed)?|dr)\b/i);
  const credit = text.search(/\b(?:credit(?:ed)?|cr)\b/i);
  if (debit < 0 && credit < 0) return "ignore";
  const direction = credit < 0 || (debit >= 0 && debit < credit) ? "debit" : "credit";
  const found = holdings(text);
  if (!found.length) return "unreadable";
  const date = dateIn(text, received) ?? received;
  const last4 = last4Of(text, "demat");
  return found.map((h) =>
    blank({ kind: "demat", date, last4, payee: h.name, ref: direction, isin: h.isin, quantity: h.quantity }),
  );
}

// Reading a message

function normalise(body: string): string {
  return body
    .replace(/\s*[\r\n]+\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseSms(bank: string, body: string, receivedAt: Date): ParseResult {
  const text = normalise(body);
  const received = istDay(receivedAt);
  const key = bank.toLowerCase();
  if (key === "cdsl" || key === "nsdl" || /^(?:CDSL|NSDL)\b/i.test(text)) return demat(text, received);

  const cut = text.search(TRAILER);
  const region = cut > 0 ? text.slice(0, cut) : text;
  if (ignorable(text, region)) return "ignore";

  const card = /card/i.test(text);
  if (card && CARD_PAYMENT.test(text) && !DEBIT.test(region)) {
    const amount = amountOf(region) ?? amountOf(text);
    return amount ? [line("card_payment", text, region, received, { amount, payee: null })] : "ignore";
  }
  if (card && STATEMENT.test(text) && !/\b(?:spent|debited|withdrawn|sent)\b/i.test(text)) {
    return statement(text, received);
  }

  const known = bankSpecific(key, text, region, received);
  if (known) return [known];

  const kind = kindOf(region) ?? kindOf(text);
  if (!kind) return "ignore";
  // An earlier debit put back is money in, and the account it names is the owner's, not a payee.
  const parsed =
    kind === "debit" && REVERSED.test(region)
      ? line("credit", text, region, received, { payee: null })
      : line(kind, text, region, received);
  if (!parsed.amount) return mentionsAmount(text) ? "unreadable" : "ignore";
  return [parsed];
}
