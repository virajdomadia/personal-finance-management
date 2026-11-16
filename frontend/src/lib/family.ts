// Family members and the family portfolio. These mirror backend/app/api/routes/family.py; see
// docs/superpowers/specs/2026-11-16-family-portfolio-design.md.
//
// Which profile the website acts for lives in the PROFILE_COOKIE cookie (a member's user id). The
// proxy turns it into an `X-Profile` header on every API request; no cookie means the owner.

export const PROFILE_COOKIE = "pfm_profile";
export const PROFILE_HEADER = "x-profile";
// What the API answers when X-Profile names a member who is gone (removed, or another login's).
export const MEMBER_NOT_FOUND = "That family member wasn't found.";
const PROFILE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export type Person = { id: number; name: string };
export type Family = { me: Person; members: Person[] };

export type Figures = { invested: string; value: string; unrealised: string; unrealised_percent: string };
export type TypeKey = "stocks" | "funds" | "crypto" | "deposits";
export type TypeFigures = Record<TypeKey, Figures>;
export type HoldingKind = "stock" | "mutual_fund" | "crypto" | "ppf" | "rd" | "fd";
export type FamilyHolding = {
  kind: HoldingKind;
  name: string;
  symbol: string | null;
  account: string | null;
  quantity: string | null;
  invested: string;
  value: string;
};
export type PersonPortfolio = {
  id: number;
  name: string;
  is_me: boolean;
  overall: Figures;
  by_type: TypeFigures;
  holdings: FamilyHolding[];
};
export type FamilyPortfolio = { people: PersonPortfolio[]; overall: Figures; by_type: TypeFigures };

// The profile cookie

// A user id as the API accepts it: digits only, no leading zero, at most 10 of them. Anything else
// is treated as no choice at all, so a junk value never reaches the API.
export function parseProfileId(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  const id = Number(text);
  return id <= 2147483647 ? id : null;
}

// The chosen profile from a `document.cookie` string.
export function readProfileCookie(cookies: string): number | null {
  for (const part of cookies.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === PROFILE_COOKIE) return parseProfileId(decodeURIComponent(part.slice(eq + 1)));
  }
  return null;
}

// A `document.cookie` assignment that chooses a member, or (with null) goes back to the owner.
export function profileCookie(id: number | null, secure: boolean): string {
  const flags = `Path=/; SameSite=Lax${secure ? "; Secure" : ""}`;
  return id === null ? `${PROFILE_COOKIE}=; ${flags}; Max-Age=0` : `${PROFILE_COOKIE}=${id}; ${flags}; Max-Age=${PROFILE_MAX_AGE_SECONDS}`;
}

// A 404 that means the chosen member is gone, rather than a missing account or goal. The family
// routes answer the same words about the member being edited, whichever profile is chosen.
export function isMissingProfile(path: string, status: number, body: string): boolean {
  if (status !== 404 || path === "/family" || path.startsWith("/family/") || path.startsWith("/family?")) return false;
  try {
    return (JSON.parse(body) as { detail?: unknown })?.detail === MEMBER_NOT_FOUND;
  } catch {
    return false;
  }
}

// Where to land after switching: the same page, unless it is one record's page (a stock, a goal),
// which belongs to the profile being left; then its list.
export function pathAfterSwitch(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((s) => /^\d+$/.test(s))) return `/${segments[0]}`;
  return pathname.startsWith("/") ? pathname : "/";
}

// Who is being viewed: the member, or null for the owner. A cookie naming the owner counts as the
// owner. `stale` is a cookie naming nobody in the family, which the app clears.
export function viewedMember(family: Family | null, profileId: number | null): { member: Person | null; stale: boolean } {
  if (profileId === null || family === null || profileId === family.me.id) return { member: null, stale: false };
  const member = family.members.find((m) => m.id === profileId) ?? null;
  return { member, stale: member === null };
}

// Wording

export function possessive(name: string): string {
  return `${name}'s`;
}

export function viewingText(name: string | null): string {
  return name === null
    ? "Viewing a family member's profile"
    : `Viewing ${possessive(name)} profile — anything you add goes to ${name}`;
}

export function switcherLabel(member: Person | null): string {
  return `Viewing: ${member === null ? "Me" : member.name}`;
}

export function removeBody(name: string): string {
  return `This deletes ${name} and everything recorded for them: accounts, transactions, investments, goals and the rest. It can't be undone.`;
}

// The remove button unlocks once the typed name matches, ignoring case and spaces at the ends, as
// the API checks it.
export function confirmMatches(typed: string, name: string): boolean {
  return typed.trim().toLowerCase() === name.trim().toLowerCase() && name.trim() !== "";
}

// What an empty holdings list says for a person.
export function emptyHoldingsText(person: { name: string; is_me: boolean }): string {
  return person.is_me
    ? "Nothing yet. Add your investments on the Investments page."
    : `Nothing yet. Switch to ${person.name} to add their investments.`;
}

export const HOW_IT_WORKS =
  "Add the people whose money you look after, like a parent or a child. Each one gets their own profile: switch to them from the top of the sidebar and add their accounts and investments as usual. Their money never mixes into yours; this page adds everyone's investments together.";

// Holdings

const KIND_LABEL: Record<HoldingKind, string> = {
  stock: "Stock",
  mutual_fund: "Mutual fund",
  crypto: "Crypto",
  ppf: "PPF",
  rd: "RD",
  fd: "FD",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind as HoldingKind] ?? kind;
}

export const TYPE_ORDER: { key: TypeKey; label: string }[] = [
  { key: "stocks", label: "Stocks" },
  { key: "funds", label: "Mutual funds" },
  { key: "crypto", label: "Crypto" },
  { key: "deposits", label: "Deposits" },
];

// A holding's main line and the line under it. Stocks and coins go by their symbol, with the name
// under it; a fund by its name (its code means nothing to people); a deposit by its account.
export function holdingLabel(h: FamilyHolding): { title: string; detail: string | null } {
  if ((h.kind === "stock" || h.kind === "crypto") && h.symbol) {
    return { title: h.symbol, detail: h.name && h.name !== h.symbol ? h.name : null };
  }
  return { title: h.account ?? h.name, detail: null };
}

// Money as whole paise, so differences never go through a float.
function toPaise(value: string): bigint {
  const text = value.trim();
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^[-+]/, "").split(".");
  const paise = BigInt(whole || "0") * BigInt(100) + BigInt(`${fraction}00`.slice(0, 2));
  return negative ? -paise : paise;
}

function fromPaise(paise: bigint): string {
  const negative = paise < BigInt(0);
  const abs = negative ? -paise : paise;
  const fraction = (abs % BigInt(100)).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${abs / BigInt(100)}.${fraction}`;
}

// Value less invested, as a money string.
export function holdingGain(h: { invested: string; value: string }): string {
  return fromPaise(toPaise(h.value) - toPaise(h.invested));
}

// Biggest first; ties by title, so the order never jumps between loads.
export function sortHoldings(holdings: FamilyHolding[]): FamilyHolding[] {
  return [...holdings].sort((a, b) => {
    const diff = toPaise(b.value) - toPaise(a.value);
    if (diff !== BigInt(0)) return diff > BigInt(0) ? 1 : -1;
    return holdingLabel(a).title.localeCompare(holdingLabel(b).title);
  });
}

// Each value's share of their sum, as percentages with one decimal. Nothing counts below zero,
// and with nothing at all every share is zero.
export function shares(values: string[]): number[] {
  const numbers = values.map((v) => Math.max(0, Number(v) || 0));
  const total = numbers.reduce((sum, n) => sum + n, 0);
  return numbers.map((n) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0));
}

export function formatShare(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

// The types with anything in them, in the usual order.
export function typesWithMoney(byType: TypeFigures): { key: TypeKey; label: string; figures: Figures }[] {
  return TYPE_ORDER.map((t) => ({ ...t, figures: byType[t.key] })).filter(
    (t) => toPaise(t.figures.value) !== BigInt(0) || toPaise(t.figures.invested) !== BigInt(0),
  );
}

export function holdingCountText(count: number): string {
  return count === 1 ? "1 holding" : `${count} holdings`;
}
