// The first-run checklist. Mirrors SetupResponse in backend/app/api/routes/setup.py: the server
// says which steps the user's data already covers. The app adds "Bank SMS" from this phone's own
// SMS setting. Skipping and hiding live on this phone only.

export type ServerKey = "bank" | "cards" | "loans" | "recurring" | "investments";
export type StepKey = ServerKey | "sms";
export type ServerStep = { key: ServerKey; done: boolean; count: number };
export type SetupResponse = { user_id: number; steps: ServerStep[] };

// open: the full card. later: a one-line strip with Resume. hidden: gone.
export type Mode = "open" | "later" | "hidden";
export type Shown = "open" | "later" | "nothing";
// `none`: the steps the user said "Not for me" to. `last`: what the dashboard showed last time,
// so the next app start can hold the right space (or none) while the checklist loads.
export type SetupState = { mode: Mode; none: StepKey[]; last: Shown };

export type StepStatus = "done" | "none" | "todo";
export type Target = { pathname: string; params?: Record<string, string> };
export type ChecklistStep = {
  key: StepKey;
  title: string;
  hint: string;
  emoji: string;
  target: Target;
  status: StepStatus;
  count: number | null; // null for the SMS step, which is on or off
  canSkip: boolean;
};

// Kept per signed-in user, because family members may share a phone.
export function setupKey(userId: number): string {
  return `gullak.setup.${userId}`;
}

// The user id from the API's token ("userId.sessionVersion.expiry.signature"), or null.
export function userIdFromToken(token: string | null): number | null {
  const first = token?.split(".")[0] ?? "";
  return /^[1-9]\d{0,14}$/.test(first) ? Number(first) : null;
}

const KEYS: StepKey[] = ["bank", "cards", "loans", "recurring", "investments", "sms"];

const STEPS: Record<StepKey, { title: string; hint: string; emoji: string; target: Target }> = {
  bank: {
    title: "Your main bank account",
    hint: "The one your salary lands in. Start here.",
    emoji: "🏦",
    target: { pathname: "/account-form", params: { type: "bank" } },
  },
  cards: {
    title: "Credit cards",
    hint: "See each bill and due date in time.",
    emoji: "💳",
    target: { pathname: "/account-form", params: { type: "credit_card" } },
  },
  loans: {
    title: "Loans",
    hint: "Track EMIs and what's left to pay.",
    emoji: "🏠",
    target: { pathname: "/account-form", params: { type: "loan" } },
  },
  recurring: {
    title: "Salary, rent and SIPs",
    hint: "A nudge when regular money moves.",
    emoji: "🔁",
    target: { pathname: "/template-form" },
  },
  investments: {
    title: "Investments",
    hint: "Stocks, funds, coins, PPF and RD.",
    emoji: "📈",
    target: { pathname: "/investments" },
  },
  sms: {
    title: "Read bank SMS",
    hint: "Bank texts become entries for you to check.",
    emoji: "📩",
    target: { pathname: "/sms-settings" },
  },
};

const BLANK: SetupState = { mode: "open", none: [], last: "open" };

// What was stored on this phone, or a fresh start if it's missing or unreadable.
export function parseSetupState(raw: string | null): SetupState {
  if (raw === null) return BLANK;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return BLANK;
    const { mode, none, last } = value as { mode?: unknown; none?: unknown; last?: unknown };
    return {
      mode: mode === "later" || mode === "hidden" ? mode : "open",
      none: Array.isArray(none) ? KEYS.filter((key) => none.includes(key)) : [],
      last: last === "later" || last === "nothing" ? last : "open",
    };
  } catch {
    return BLANK;
  }
}

function status(done: boolean, key: StepKey, none: StepKey[]): StepStatus {
  // Done beats "Not for me": a card added after skipping the step shows as added.
  if (done) return "done";
  return none.includes(key) ? "none" : "todo";
}

// The server's steps in its order, then Bank SMS when this app can read SMS (`smsOn` is null when
// it can't, so the step isn't offered).
export function checklistSteps(server: ServerStep[], smsOn: boolean | null, none: StepKey[]): ChecklistStep[] {
  const steps: ChecklistStep[] = server
    .filter((step) => KEYS.includes(step.key))
    .map((step) => ({
      key: step.key,
      ...STEPS[step.key],
      status: status(step.done, step.key, none),
      count: step.count,
      canSkip: step.key !== "bank",
    }));
  if (smsOn !== null) {
    steps.push({ key: "sms", ...STEPS.sms, status: status(smsOn, "sms", none), count: null, canSkip: true });
  }
  return steps;
}

export function progressOf(steps: { status: StepStatus }[]): { finished: number; total: number } {
  return { finished: steps.filter((step) => step.status !== "todo").length, total: steps.length };
}

export function progressText(steps: { status: StepStatus }[]): string {
  const { finished, total } = progressOf(steps);
  return `${finished} of ${total} done`;
}

// What the dashboard shows: nothing once every step is done or skipped, or once hidden.
export function shownAs(steps: { status: StepStatus }[], mode: Mode): Shown {
  const { finished, total } = progressOf(steps);
  if (total === 0 || finished === total || mode === "hidden") return "nothing";
  return mode;
}

export function statusText(step: ChecklistStep): string {
  if (step.status === "none") return "Skipped";
  if (step.status === "todo") return step.hint;
  if (step.count === null) return "On";
  return step.count === 1 ? "1 added" : `${step.count} added`;
}

export function withNone(state: SetupState, key: StepKey, on: boolean): SetupState {
  const rest = state.none.filter((k) => k !== key);
  return { ...state, none: on ? [...rest, key] : rest };
}

// While loading: nothing if the checklist was gone last time (or is hidden), else a placeholder.
export function loadingShown(state: SetupState): "placeholder" | "nothing" {
  return state.mode === "hidden" || state.last === "nothing" ? "nothing" : "placeholder";
}
