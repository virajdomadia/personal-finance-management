// The first-run checklist. Mirrors SetupResponse in backend/app/api/routes/setup.py: the server
// says which steps the user's data already covers. Skipping and hiding live on this device only.

export type StepKey = "bank" | "cards" | "loans" | "recurring" | "investments";
export type ServerStep = { key: StepKey; done: boolean; count: number };
export type SetupResponse = { user_id: number; steps: ServerStep[] };

// open: the full card. later: a one-line strip with Resume. hidden: gone.
export type Mode = "open" | "later" | "hidden";
// `none`: the steps the user said "Not for me" to.
export type SetupState = { mode: Mode; none: StepKey[] };

export type StepStatus = "done" | "none" | "todo";
export type ChecklistStep = {
  key: StepKey;
  title: string;
  hint: string;
  href: string;
  status: StepStatus;
  count: number;
  canSkip: boolean;
};

// Kept per signed-in user, because family members may share a browser.
export function setupKey(userId: number): string {
  return `gullak.setup.${userId}`;
}

const KEYS: StepKey[] = ["bank", "cards", "loans", "recurring", "investments"];

const STEPS: Record<StepKey, { title: string; hint: string; href: string; emoji: string }> = {
  bank: {
    title: "Your main bank account",
    hint: "The one your salary lands in. Start here.",
    href: "/accounts?add=bank",
    emoji: "🏦",
  },
  cards: {
    title: "Credit cards",
    hint: "See each bill and due date before it sneaks up on you.",
    href: "/accounts?add=credit_card",
    emoji: "💳",
  },
  loans: {
    title: "Loans",
    hint: "Keep track of EMIs and how much is left to pay.",
    href: "/accounts?add=loan",
    emoji: "🏠",
  },
  recurring: {
    title: "Salary, rent and SIPs",
    hint: "Get a nudge when regular money comes in or goes out.",
    href: "/recurring?add=1",
    emoji: "🔁",
  },
  investments: {
    title: "Investments",
    hint: "Stocks, funds, coins, PPF and RD, all in one place.",
    href: "/investments",
    emoji: "📈",
  },
};

export function stepEmoji(key: StepKey): string {
  return STEPS[key].emoji;
}

const BLANK: SetupState = { mode: "open", none: [] };

// What was stored on this device, or a fresh start if it's missing or unreadable.
export function parseSetupState(raw: string | null): SetupState {
  if (raw === null) return BLANK;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return BLANK;
    const { mode, none } = value as { mode?: unknown; none?: unknown };
    return {
      mode: mode === "later" || mode === "hidden" ? mode : "open",
      none: Array.isArray(none) ? KEYS.filter((key) => none.includes(key)) : [],
    };
  } catch {
    return BLANK;
  }
}

// The server's steps in its order, with "Not for me" applied. Done beats "none": a card
// added after saying "Not for me" shows as added.
export function checklistSteps(server: ServerStep[], none: StepKey[]): ChecklistStep[] {
  return server
    .filter((step) => KEYS.includes(step.key))
    .map((step) => ({
      key: step.key,
      title: STEPS[step.key].title,
      hint: STEPS[step.key].hint,
      href: STEPS[step.key].href,
      status: step.done ? "done" : none.includes(step.key) ? "none" : "todo",
      count: step.count,
      canSkip: step.key !== "bank",
    }));
}

export function progressOf(steps: { status: StepStatus }[]): { finished: number; total: number } {
  return { finished: steps.filter((step) => step.status !== "todo").length, total: steps.length };
}

export function progressText(steps: { status: StepStatus }[]): string {
  const { finished, total } = progressOf(steps);
  return `${finished} of ${total} done`;
}

// What the dashboard shows: nothing once every step is done or skipped, or once hidden.
export function shownAs(steps: { status: StepStatus }[], mode: Mode): "open" | "later" | "nothing" {
  const { finished, total } = progressOf(steps);
  if (total === 0 || finished === total || mode === "hidden") return "nothing";
  return mode;
}

export function statusText(step: ChecklistStep): string {
  if (step.status === "none") return "Skipped. Undo if that changes.";
  if (step.status === "todo") return step.hint;
  return step.count === 1 ? "1 added" : `${step.count} added`;
}

export function withNone(state: SetupState, key: StepKey, on: boolean): SetupState {
  const none = on ? [...state.none.filter((k) => k !== key), key] : state.none.filter((k) => k !== key);
  return { ...state, none };
}
