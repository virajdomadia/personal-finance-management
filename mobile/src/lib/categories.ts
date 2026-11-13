// Managed categories: GET /categories and its forms. These mirror backend/app/api/routes/categories.py
// and the rules in backend/app/api/categories.py.

export type CategoryKind = "income" | "expense";

export type Category = {
  id: number;
  kind: CategoryKind;
  name: string;
  parent_id: number | null;
  icon: string | null; // a key from CategoryTree.icons
  colour: string | null; // "#rrggbb"
  archived: boolean;
  fixed: boolean; // used by the app itself: can't be renamed, archived or merged away
  transaction_count: number;
};

// Each kind's categories (archived ones too): a top-level one, then its subcategories.
export type CategoryTree = { income: Category[]; expense: Category[]; icons: string[] };

export type MergeResult = {
  category: Category;
  moved_transactions: number;
  moved_templates: number;
  moved_rules: number;
};

export const CATEGORIES_PATH = "/categories";
export const EMPTY_TREE: CategoryTree = { income: [], expense: [], icons: [] };

export const CATEGORY_KINDS: { value: CategoryKind; label: string }[] = [
  { value: "expense", label: "Spending" },
  { value: "income", label: "Income" },
];

// The colours the app offers. The server takes any "#rrggbb", so a colour set elsewhere still shows.
export const CATEGORY_PALETTE = [
  "#e63946",
  "#e4572e",
  "#ff9f1c",
  "#f3a712",
  "#4cb944",
  "#2e9e5b",
  "#2ec4b6",
  "#1f7a8c",
  "#5c80bc",
  "#29335c",
  "#a06cd5",
  "#db5375",
  "#b5651d",
  "#8a8a8a",
];

// The server's icon keys, mapped to Material Community Icons.
const ICONS: Record<string, string> = {
  salary: "briefcase",
  business: "store",
  interest: "percent",
  dividends: "cash-multiple",
  refund: "cash-refund",
  gift: "gift",
  other: "dots-horizontal-circle",
  groceries: "cart",
  food: "silverware-fork-knife",
  transport: "bus",
  fuel: "gas-station",
  home: "home",
  utilities: "lightbulb",
  shopping: "shopping",
  health: "medical-bag",
  entertainment: "movie-open",
  education: "school",
  insurance: "shield-check",
  loan: "bank",
  travel: "airplane",
  fees: "receipt",
  pets: "paw",
  kids: "baby-face-outline",
  phone: "cellphone",
  clothes: "tshirt-crew",
  fitness: "dumbbell",
  personal: "account-heart",
  subscriptions: "autorenew",
  tax: "scale-balance",
  savings: "piggy-bank",
};
export const FALLBACK_ICON = "tag";
export const FALLBACK_COLOUR = "#8a8a8a";

// An unknown or missing key (a newer server, or "Uncategorised") gets a plain tag.
export function iconName(key: string | null | undefined): string {
  return (key && ICONS[key]) || FALLBACK_ICON;
}

const HEX = /^#([0-9a-f]{6})$/i;

export function colourOf(colour: string | null | undefined): string {
  return colour && HEX.test(colour) ? colour.toLowerCase() : FALLBACK_COLOUR;
}

// Whether ink reads better than white on `colour` (relative luminance, WCAG).
export function inkOn(colour: string | null | undefined): boolean {
  const hex = colourOf(colour).slice(1);
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Contrast with white (1.05 / (L + 0.05)) against contrast with ink #1A1A1A (L ≈ 0.0103).
  return (luminance + 0.05) / 0.0603 > 1.05 / (luminance + 0.05);
}

export type CategoryGroup<T extends Pick<Category, "id" | "parent_id"> = Category> = { parent: T; children: T[] };

// A list in the server's order (a top-level category, then its subcategories), as groups. A
// subcategory whose parent isn't in the list stands on its own.
export function nest<T extends Pick<Category, "id" | "parent_id">>(list: T[]): CategoryGroup<T>[] {
  const ids = new Set(list.map((c) => c.id));
  const groups: CategoryGroup<T>[] = [];
  const byId = new Map<number, CategoryGroup<T>>();
  for (const c of list) {
    if (c.parent_id !== null && ids.has(c.parent_id)) continue;
    const group = { parent: c, children: [] as T[] };
    groups.push(group);
    byId.set(c.id, group);
  }
  for (const c of list) {
    if (c.parent_id !== null && ids.has(c.parent_id)) byId.get(c.parent_id)?.children.push(c);
  }
  return groups;
}

// What a picker offers: the live categories, nested, archived ones left out.
export function pickerGroups(list: Category[]): CategoryGroup[] {
  return nest(list.filter((c) => !c.archived));
}

// Only the names in `allowed` (case-insensitive), e.g. "Interest" for income into a PPF. A name
// that no category has is offered on its own.
export function restrictGroups(groups: CategoryGroup[], allowed: string[]): CategoryGroup[] {
  const keys = new Set(allowed.map((n) => n.trim().toLowerCase()));
  const result: CategoryGroup[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    const children = g.children.filter((c) => keys.has(c.name.toLowerCase()));
    for (const c of children) seen.add(c.name.toLowerCase());
    if (keys.has(g.parent.name.toLowerCase())) {
      result.push({ parent: g.parent, children });
      seen.add(g.parent.name.toLowerCase());
    } else {
      // Without its parent, each allowed subcategory stands on its own.
      for (const c of children) result.push({ parent: c, children: [] });
    }
  }
  for (const name of allowed) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ parent: bareCategory(name.trim()), children: [] });
  }
  return result;
}

// A stand-in for a name the server didn't send (an older server, or a failed load).
export function bareCategory(name: string, kind: CategoryKind = "expense"): Category {
  return {
    id: -1,
    kind,
    name,
    parent_id: null,
    icon: null,
    colour: null,
    archived: false,
    fixed: false,
    transaction_count: 0,
  };
}

export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// The categories screen: the live ones nested, and the archived ones apart.
export function categorySections(list: Category[]): { live: CategoryGroup[]; archived: Category[] } {
  return { live: nest(list.filter((c) => !c.archived)), archived: list.filter((c) => c.archived) };
}

export function usageText(count: number): string {
  if (count === 0) return "Not used yet";
  return `${count} ${count === 1 ? "transaction" : "transactions"}`;
}

const hasChildren = (list: Category[], self: Category) => list.some((c) => c.parent_id === self.id);

// Where a category can go: live top-level categories of its kind, not itself. None when it has
// subcategories of its own, as only one level of nesting is allowed.
export function parentOptions(list: Category[], self: Category | null, kind: CategoryKind): Category[] {
  if (self !== null && hasChildren(list, self)) return [];
  return list.filter(
    (c) => c.kind === kind && c.parent_id === null && !c.archived && (self === null || c.id !== self.id),
  );
}

// What it can be merged into: live categories of its kind, but not itself or one of its own
// subcategories; and when it has subcategories, only a top-level one (they move along with it).
export function mergeTargets(list: Category[], self: Category): Category[] {
  const parentOnly = hasChildren(list, self);
  return list.filter(
    (c) =>
      c.kind === self.kind &&
      c.id !== self.id &&
      !c.archived &&
      c.parent_id !== self.id &&
      (!parentOnly || c.parent_id === null),
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "Moved 12 transactions, 1 reminder and 2 payee rules into Food." or "Nothing needed moving into Food."
export function mergedText(result: MergeResult): string {
  const parts = [
    result.moved_transactions > 0 ? plural(result.moved_transactions, "transaction", "transactions") : null,
    result.moved_templates > 0 ? plural(result.moved_templates, "reminder", "reminders") : null,
    result.moved_rules > 0 ? plural(result.moved_rules, "payee rule", "payee rules") : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return `Nothing needed moving into ${result.category.name}.`;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Moved ${list} into ${result.category.name}.`;
}

export type CategoryForm = {
  kind: CategoryKind;
  name: string;
  icon: string | null;
  colour: string | null;
  parent_id: number | null;
};

export function categoryFormBlank(kind: CategoryKind): CategoryForm {
  return { kind, name: "", icon: null, colour: null, parent_id: null };
}

export function categoryFormFrom(c: Category): CategoryForm {
  return { kind: c.kind, name: c.name, icon: c.icon, colour: c.colour, parent_id: c.parent_id };
}

// A new category sends everything set; an edit only what changed (a fixed one keeps its name).
// Empty means nothing to save.
export function categoryPayload(form: CategoryForm, original: Category | null): Record<string, unknown> {
  const name = form.name.trim();
  if (original === null) {
    const payload: Record<string, unknown> = { kind: form.kind, name: name || null };
    if (form.icon !== null) payload.icon = form.icon;
    if (form.colour !== null) payload.colour = form.colour;
    if (form.parent_id !== null) payload.parent_id = form.parent_id;
    return payload;
  }
  const payload: Record<string, unknown> = {};
  if (!original.fixed && name !== original.name) payload.name = name || null;
  if (form.icon !== original.icon) payload.icon = form.icon;
  if (form.colour !== original.colour) payload.colour = form.colour;
  if (form.parent_id !== original.parent_id) payload.parent_id = form.parent_id;
  return payload;
}

// Checked before saving, in the server's words.
export function categoryErrors(form: CategoryForm): Record<string, string> {
  const name = form.name.trim();
  if (name === "") return { name: "Enter a name." };
  if (name.length > 40) return { name: "Use 40 characters or fewer." };
  return {};
}
