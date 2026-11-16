import { formatRupees } from "./accounts.ts";

// Family members and the family portfolio. See
// docs/superpowers/specs/2026-11-16-family-portfolio-design.md. The chosen profile is sent as
// `X-Profile: <id>`; with none, every request is the signed-in owner's.

// These mirror the response models in backend/app/api/routes/family.py.
export type Person = { id: number; name: string };
export type Family = { me: Person; members: Person[] };

export type Figures = { invested: string; value: string; unrealised: string; unrealised_percent: string };
export type TypeKey = "stocks" | "funds" | "crypto" | "deposits";
export type TypeFigures = Record<TypeKey, Figures>;
export type HoldingKind = "stock" | "mutual_fund" | "crypto" | "ppf" | "rd" | "fd";
export type FamilyHolding = {
  kind: HoldingKind | string;
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

// The chosen profile, as remembered on the phone: a member's id and name (the name for the bar,
// before the list has loaded). Null is the owner.
export type Profile = { id: number; name: string };

export const PROFILE_KEY = "pfm_profile";
export const PROFILE_HEADER = "X-Profile";
// The server's answer when the chosen member no longer exists (removed on another device).
export const PROFILE_GONE = "That family member wasn't found.";
export const MAX_MEMBERS = 10;
export const NAME_MAX = 40;
const MAX_ID = 2147483647; // the largest id the server accepts

// A member id: a whole number from 1 to the largest id, as digits or a number.
export function parseProfileId(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^[1-9]\d{0,9}$/.test(text)) return null;
  const id = Number(text);
  return id <= MAX_ID ? id : null;
}

// The stored choice, or null for the owner (also for anything unreadable).
export function parseStoredProfile(raw: string | null): Profile | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { id, name } = value as { id?: unknown; name?: unknown };
    const parsed = parseProfileId(id);
    if (parsed === null || typeof name !== "string" || name.trim() === "") return null;
    return { id: parsed, name: name.trim().slice(0, NAME_MAX) };
  } catch {
    return null;
  }
}

export function storedProfileValue(profile: Profile): string {
  return JSON.stringify({ id: profile.id, name: profile.name });
}

// Always the signed-in owner's, whatever the header says, so it isn't sent to them. A 404 from
// one of these is then never mistaken for the chosen member having gone.
const OWNER_ONLY = ["/auth", "/family", "/sms", "/payee-rules"];

export function sendsProfile(path: string): boolean {
  const bare = path.split(/[?#]/)[0];
  return !OWNER_ONLY.some((prefix) => bare === prefix || bare.startsWith(`${prefix}/`));
}

// The header to add to a request for `path`, or none for the owner.
export function profileHeaders(path: string, profileId: number | null): Record<string, string> {
  if (profileId === null || !sendsProfile(path)) return {};
  return { [PROFILE_HEADER]: String(profileId) };
}

// True when a failed request says the member it was sent for no longer exists.
export function isProfileGone(status: number, detail: unknown, sentProfile: boolean): boolean {
  return sentProfile && status === 404 && detail === PROFILE_GONE;
}

// "Papa's", "James'".
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

export function viewingText(name: string): string {
  return `Viewing ${possessive(name)} profile`;
}

export function viewingLabel(profile: Profile | null): string {
  return `Viewing: ${profile === null ? "Me" : profile.name}`;
}

export function switchToText(name: string): string {
  return `Switch to ${name} to add their investments`;
}

export const SMS_OWN_PROFILE = "SMS review is for your own profile.";

export function removeWarning(name: string): string {
  return `This deletes ${name} and all their data: accounts, transactions, investments, goals and everything else recorded for them. It can't be undone. Type ${name} to confirm.`;
}

// The typed name matches the member's, ignoring case and spaces at the ends (as the server does).
export function confirmMatches(typed: string, name: string): boolean {
  return typed.trim().toLowerCase() === name.trim().toLowerCase() && name.trim() !== "";
}

// The server's checks on a name, before sending it; null when it would be accepted.
export function memberNameError(name: string, members: Person[], exceptId: number | null = null): string | null {
  const clean = name.trim();
  if (clean === "") return "Enter a name.";
  if (clean.length > NAME_MAX) return `Keep it to ${NAME_MAX} characters.`;
  if (clean.toLowerCase() === "me") return '"Me" is you. Choose another name.';
  if (members.some((m) => m.id !== exceptId && m.name.toLowerCase() === clean.toLowerCase())) {
    return `You already have ${clean}.`;
  }
  return null;
}

// The owner first, then members by name, as the server sends them.
export function sortPeople<T extends { name: string; is_me?: boolean }>(people: T[]): T[] {
  return [...people].sort((a, b) => {
    if (Boolean(a.is_me) !== Boolean(b.is_me)) return a.is_me ? -1 : 1;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  });
}

function amount(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Largest value first; the same value by name.
export function sortHoldings(holdings: FamilyHolding[]): FamilyHolding[] {
  return [...holdings].sort((a, b) => amount(b.value) - amount(a.value) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}

// A part's share of the whole, 0 to 100; 0 when there is no whole (or the part is negative).
export function sharePercent(part: string, whole: string): number {
  const p = amount(part);
  const w = amount(whole);
  if (!(w > 0) || !(p > 0)) return 0;
  return Math.min((p / w) * 100, 100);
}

// "42%", "<1%" for a sliver, "0%" for nothing.
export function shareText(part: string, whole: string): string {
  const percent = sharePercent(part, whole);
  if (percent === 0) return "0%";
  if (percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

export const TYPE_ORDER: TypeKey[] = ["stocks", "funds", "crypto", "deposits"];
export const TYPE_LABELS: Record<TypeKey, string> = {
  stocks: "Stocks",
  funds: "Mutual funds",
  crypto: "Crypto",
  deposits: "Deposits",
};
export const TYPE_EMOJI: Record<TypeKey, string> = { stocks: "📈", funds: "🥧", crypto: "🪙", deposits: "🐷" };

export const KIND_LABELS: Record<HoldingKind, string> = {
  stock: "Stock",
  mutual_fund: "Mutual fund",
  crypto: "Crypto",
  ppf: "PPF",
  rd: "RD",
  fd: "FD",
};

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind as HoldingKind] ?? kind;
}

const KIND_EMOJI: Record<HoldingKind, string> = { stock: "📈", mutual_fund: "🥧", crypto: "🪙", ppf: "🏦", rd: "🪙", fd: "🔒" };

export function kindEmoji(kind: string): string {
  return KIND_EMOJI[kind as HoldingKind] ?? "💼";
}

// "10 shares", "12.345 units", "0.5 BTC"; null for a deposit.
export function quantityText(holding: Pick<FamilyHolding, "kind" | "quantity" | "symbol">): string | null {
  const q = holding.quantity;
  if (q === null || q.trim() === "") return null;
  if (holding.kind === "stock") return `${q} ${q === "1" ? "share" : "shares"}`;
  if (holding.kind === "mutual_fund") return `${q} units`;
  if (holding.kind === "crypto") return holding.symbol ? `${q} ${holding.symbol.toUpperCase()}` : q;
  return q;
}

// The detail line under a holding's name: kind, symbol, quantity and what went in.
export function holdingDetails(holding: FamilyHolding): string {
  const parts = [kindLabel(holding.kind)];
  if (holding.symbol && holding.kind !== "crypto") parts.push(holding.symbol);
  const quantity = quantityText(holding);
  if (quantity) parts.push(quantity);
  if (holding.kind !== "ppf" && holding.kind !== "rd" && holding.kind !== "fd") {
    parts.push(`invested ${formatRupees(holding.invested)}`);
  }
  return parts.join(" · ");
}

export function holdingsCountText(count: number): string {
  return count === 1 ? "1 holding" : `${count} holdings`;
}

// The types a person or the family has something in, largest first, with each one's share.
export function typeSplit(byType: TypeFigures, total: string): { key: TypeKey; label: string; figures: Figures; share: string }[] {
  return TYPE_ORDER.filter((key) => amount(byType[key].value) > 0 || amount(byType[key].invested) > 0)
    .map((key) => ({ key, label: TYPE_LABELS[key], figures: byType[key], share: shareText(byType[key].value, total) }))
    .sort((a, b) => amount(b.figures.value) - amount(a.figures.value));
}

export function hasMembers(portfolio: FamilyPortfolio): boolean {
  return portfolio.people.some((p) => !p.is_me);
}
