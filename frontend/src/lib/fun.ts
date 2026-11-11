// The playful bits: emoji for categories, accounts and investments, and the little stickers.

const CATEGORY_EMOJI: Record<string, string> = {
  salary: "💼",
  business: "🏪",
  interest: "🏦",
  dividends: "💰",
  refund: "↩️",
  gift: "🎁",
  other: "🧾",
  groceries: "🛒",
  "food and dining": "🍔",
  transport: "🚌",
  fuel: "⛽",
  housing: "🏠",
  utilities: "💡",
  shopping: "🛍️",
  health: "💊",
  entertainment: "🎬",
  education: "🎓",
  insurance: "🛡️",
  "loan payments": "🏧",
  travel: "✈️",
  "gifts and donations": "🎁",
  "fees and charges": "🧾",
};

export function categoryEmoji(category: string | null): string {
  if (!category) return "🧾";
  return CATEGORY_EMOJI[category.trim().toLowerCase()] ?? "🧾";
}

const ACCOUNT_EMOJI: Record<string, string> = {
  bank: "🏦",
  credit_card: "💳",
  cash: "💵",
  broker: "📊",
  wallet: "👛",
  ppf: "🐷",
  rd: "🪙",
  loan: "🧾",
};

export function accountEmoji(type: string): string {
  return ACCOUNT_EMOJI[type] ?? "🧾";
}

export function investmentEmoji(kind: "stock" | "mutual_fund" | "crypto"): string {
  if (kind === "stock") return "📈";
  if (kind === "mutual_fund") return "🥧";
  return "🪙";
}

// A "+12%" sticker for a holding that is up 10% or more; the percent is floored.
export function investmentSticker(unrealisedPercent: string | null): string | null {
  if (unrealisedPercent === null) return null;
  const value = Number(unrealisedPercent);
  if (!Number.isFinite(value) || value < 10) return null;
  return `+${Math.floor(value)}%`;
}

// The streak chip: the day count up to 6, then the milestone reached.
export function streakLabel(days: number): string | null {
  if (!(days > 0)) return null;
  if (days >= 100) return "🔥 100+";
  if (days >= 30) return "🔥 30+";
  if (days >= 7) return "🔥 7+";
  return `🔥 ${days}`;
}

// Bar segment colours, in order. These are tile fills, so they carry ink text or none at all.
export const STACK_COLORS = ["#58CC02", "#FFC800", "#FF4B8B", "#1CB0F6", "#A560FF", "#FF7A00"];
