// Managed categories: the shapes `/categories` returns and the small helpers the pages share.

export type CategoryKind = "income" | "expense";

export type Category = {
  id: number;
  kind: CategoryKind;
  name: string;
  parent_id: number | null;
  icon: string | null;
  colour: string | null;
  archived: boolean;
  fixed: boolean; // used by the app itself: can't be renamed, archived or merged away
  transaction_count: number;
};

export type CategoryTree = { income: Category[]; expense: Category[]; icons: string[] };

export type MergeResult = {
  category: Category;
  moved_transactions: number;
  moved_templates: number;
  moved_rules: number;
};

// The icon keys the server knows, drawn as emoji on the website.
const ICON_EMOJI: Record<string, string> = {
  salary: "💼",
  business: "🏪",
  interest: "🏦",
  dividends: "💰",
  refund: "↩️",
  gift: "🎁",
  other: "🧾",
  groceries: "🛒",
  food: "🍔",
  transport: "🚌",
  fuel: "⛽",
  home: "🏠",
  utilities: "💡",
  shopping: "🛍️",
  health: "💊",
  entertainment: "🎬",
  education: "🎓",
  insurance: "🛡️",
  loan: "🏧",
  travel: "✈️",
  fees: "🧾",
  pets: "🐾",
  kids: "🧸",
  phone: "📱",
  clothes: "👕",
  fitness: "🏋️",
  personal: "💇",
  subscriptions: "🔁",
  tax: "🏛️",
  savings: "🐷",
};

export function iconEmoji(icon: string | null): string {
  return (icon && ICON_EMOJI[icon]) || "🏷️";
}

// The colours offered when choosing one. Any #rrggbb is accepted by the server.
export const PALETTE = [
  "#4cb944",
  "#2e9e5b",
  "#f3a712",
  "#ff9f1c",
  "#e4572e",
  "#e63946",
  "#db5375",
  "#a06cd5",
  "#8d6a9f",
  "#5c80bc",
  "#2ec4b6",
  "#1f7a8c",
  "#29335c",
  "#8a8a8a",
];

export const FALLBACK_COLOUR = "#d4d4d8";

// Live categories a parent can be chosen from: top-level, unarchived, of the kind, not the
// category itself.
export function parentOptions(list: Category[], self: Category | null): Category[] {
  return list.filter((c) => c.parent_id === null && !c.archived && c.id !== self?.id);
}

// Where a category can be merged into: same kind (the list is one kind), not itself, not archived,
// not its own subcategory, and not a subcategory when it has subcategories of its own.
export function mergeTargets(list: Category[], source: Category): Category[] {
  const hasChildren = list.some((c) => c.parent_id === source.id);
  return list.filter(
    (c) => c.id !== source.id && !c.archived && c.parent_id !== source.id && !(hasChildren && c.parent_id !== null),
  );
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// "Moved 12 transactions, 1 reminder and 2 payee rules into Food and dining."
export function mergeText(result: MergeResult): string {
  const parts = [
    plural(result.moved_transactions, "transaction", "transactions"),
    plural(result.moved_templates, "reminder", "reminders"),
    plural(result.moved_rules, "payee rule", "payee rules"),
  ];
  return `Moved ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]} into ${result.category.name}.`;
}

// The list as shown: live (unarchived) ones, each subcategory after its parent, then the archived.
export function splitArchived(list: Category[]): { live: Category[]; archived: Category[] } {
  return { live: list.filter((c) => !c.archived), archived: list.filter((c) => c.archived) };
}

// The body of a create or edit: only what changed when editing.
export function categoryPayload(
  form: { name: string; parent_id: string; icon: string; colour: string },
  original: Category | null,
  kind: CategoryKind,
): Record<string, unknown> {
  const parent = form.parent_id === "" ? null : Number(form.parent_id);
  const icon = form.icon === "" ? null : form.icon;
  const colour = form.colour === "" ? null : form.colour;
  if (original === null) {
    return { kind, name: form.name.trim(), parent_id: parent, icon, colour };
  }
  const body: Record<string, unknown> = {};
  if (form.name.trim() !== original.name) body.name = form.name.trim();
  if (parent !== original.parent_id) body.parent_id = parent;
  if (icon !== original.icon) body.icon = icon;
  if (colour !== original.colour) body.colour = colour;
  return body;
}
