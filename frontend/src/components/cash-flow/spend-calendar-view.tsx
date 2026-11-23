"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { logout } from "@/app/login/actions";
import { formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CalendarDay,
  type FixedLine,
  type Mark,
  type SpendCalendar,
  calendarPath,
  calendarWeeks,
  dayTone,
  dayTransactionsHref,
  markText,
  marksByDate,
  paceText,
  shortDate,
  shortRupees,
  splitTemplates,
} from "@/lib/cash-flow";
import { type Frequency, type Template, type TemplateType, whole } from "@/lib/recurring";
import { formatMonth } from "@/lib/transactions";
import { Notice } from "@/components/investments/shared";
import { DueSection } from "@/components/recurring/due-list";
import { ReminderList } from "@/components/recurring/reminder-list";
import { TemplateDialog } from "@/components/recurring/template-dialog";
import { FOCUS, PageHeader, buttonClass } from "@/components/ui/chunky";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: SpendCalendar; templates: Template[] };
type Dialog =
  | { kind: "none" }
  | { kind: "add"; type: TemplateType; frequency: Frequency }
  | { kind: "edit"; template: Template };

const CARD = "min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky";
const MONTH_BUTTON = `${buttonClass("alt")} !rounded-full !px-3 !py-1.5 !text-xs !font-extrabold !shadow-chunky-sm`;
const SMALL_BUTTON = `${buttonClass("alt")} !px-3 !py-1.5 !text-xs`;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TONE = {
  over: "bg-loss/10 border-loss text-loss",
  under: "bg-gain/10 border-gain text-gain",
  plain: "bg-card border-ink text-ink",
  future: "bg-zinc-100 border-zinc-300 text-zinc-500",
} as const;
const TONE_WORD = { over: ", over the daily amount", under: ", within the daily amount", plain: "", future: "" } as const;
// A reminder's mark on its day: paid, owed, still to come, or skipped.
const MARK = {
  paid: { symbol: "✓", className: "bg-gain text-white" },
  due: { symbol: "!", className: "bg-loss text-white" },
  coming: { symbol: "•", className: "bg-ink text-white" },
  skipped: { symbol: "–", className: "bg-zinc-300 text-ink" },
} as const;

// The spending calendar: the month's fixed money, the daily amount it leaves, each day's spending
// against it, and every reminder: due ones to record or skip, and the full list to change.
export function SpendCalendarView({ month, adding = false }: { month: string | null; adding?: boolean }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>(
    adding ? { kind: "add", type: "expense", frequency: "monthly" } : { kind: "none" },
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let current = true;
    Promise.all([
      apiFetch<SpendCalendar>(month ? `/calendar?month=${month}` : "/calendar"),
      apiFetch<{ templates: Template[] }>("/recurring"),
    ])
      .then(([data, list]) => {
        if (current) setLoad({ status: "ready", data, templates: list.templates });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (current) setLoad({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [month, version]);

  // Opened from the checklist: drop `?add=` so a reload doesn't open the dialog again.
  useEffect(() => {
    if (adding) window.history.replaceState(null, "", "/calendar");
  }, [adding]);

  const closeDialog = () => setDialog({ kind: "none" });
  const add = (type: TemplateType, frequency: Frequency = "monthly") => setDialog({ kind: "add", type, frequency });
  const edit = (template: Template) => setDialog({ kind: "edit", template });

  const title = load.status === "ready" ? formatMonth(load.data.month) : month ? formatMonth(month) : "This month";
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`Spending calendar · ${title}`}
        action={load.status === "ready" ? <MonthNav data={load.data} /> : null}
      />
      <Notice message={notice} />
      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading the month...
        </p>
      )}
      {load.status === "error" && (
        <p role="alert" className={`${CARD} font-extrabold`}>
          We couldn&apos;t load this month. Reload the page to try again.
        </p>
      )}
      {load.status === "ready" && (
        <Body
          data={load.data}
          templates={load.templates}
          version={version}
          onAdd={add}
          onEdit={edit}
          onChanged={reload}
          onNotice={setNotice}
        />
      )}
      {dialog.kind !== "none" && (
        <TemplateDialog
          key={dialog.kind === "edit" ? dialog.template.id : `new-${dialog.type}-${dialog.frequency}`}
          template={dialog.kind === "edit" ? dialog.template : null}
          frequency={dialog.kind === "add" ? dialog.frequency : "monthly"}
          type={dialog.kind === "add" ? dialog.type : undefined}
          onClose={closeDialog}
          onSaved={() => {
            setNotice(null);
            closeDialog();
            reload();
          }}
          onConflict={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}
    </div>
  );
}

function Body({
  data,
  templates,
  version,
  onAdd,
  onEdit,
  onChanged,
  onNotice,
}: {
  data: SpendCalendar;
  templates: Template[];
  version: number;
  onAdd: (type: TemplateType, frequency?: Frequency) => void;
  onEdit: (t: Template) => void;
  onChanged: () => void;
  onNotice: (message: string | null) => void;
}) {
  const { fixed, other } = splitTemplates(templates);
  const sips = data.fixed.filter((f) => f.source === "sip");
  const lists = { onEdit, onChanged, onNotice };
  const fixedMoney = <FixedMoney data={data} templates={fixed} sips={sips} onAdd={onAdd} {...lists} />;
  return (
    <div className="flex flex-col gap-3.5">
      {/* Until there's a daily amount, asking for the fixed money comes first. */}
      {data.per_day === null && fixedMoney}
      {data.is_current && <DueSection refreshKey={version} onChanged={onChanged} />}
      <Summary data={data} />
      <MonthGrid data={data} />
      {data.per_day !== null && fixedMoney}
      <OtherReminders templates={other} onAdd={onAdd} {...lists} />
    </div>
  );
}

function MonthNav({ data }: { data: SpendCalendar }) {
  const link = (target: string | null, label: string, text: string) =>
    target === null ? (
      <span className={`${MONTH_BUTTON} opacity-40`} aria-disabled="true" aria-label={label}>
        {text}
      </span>
    ) : (
      <Link href={calendarPath(target)} className={MONTH_BUTTON} aria-label={label}>
        {text}
      </Link>
    );
  return (
    <div className="flex items-center gap-2">
      {link(data.previous_month, "Previous month", "‹")}
      {link(data.next_month, "Next month", "›")}
    </div>
  );
}

function Summary({ data }: { data: SpendCalendar }) {
  const pace = paceText(data.pace);
  const behind = data.pace?.startsWith("-") ?? false;
  return (
    <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
      <Figure label="Free this month" emoji="🧮" amount={data.free}>
        {formatRupees(data.income)} in − {formatRupees(data.fixed_out)} fixed
      </Figure>
      <Figure label="Per day" emoji="📅" amount={data.per_day}>
        {data.per_day === null ? "Needs your monthly income" : `Free ÷ ${data.days.length} days`}
      </Figure>
      <Figure label="Spent" emoji="💸" amount={data.spent}>
        {data.is_current ? `1–${shortDate(data.through)}` : "The whole month"}
      </Figure>
      <Figure label="Left" emoji="👛" amount={data.left}>
        {pace === null ? "Free − spent" : <span className={behind ? "text-loss" : "text-gain"}>{pace}</span>}
      </Figure>
    </div>
  );
}

function Figure({
  label,
  emoji,
  amount,
  children,
}: {
  label: string;
  emoji: string;
  amount: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className={CARD}>
      <p className="text-xs font-extrabold">
        <span aria-hidden="true">{emoji} </span>
        {label}
      </p>
      <p className="text-[22px] leading-tight font-black tabular-nums">{amount === null ? "—" : formatRupees(amount)}</p>
      <p className="mt-0.5 text-xs font-extrabold text-zinc-600">{children}</p>
    </div>
  );
}

function MonthGrid({ data }: { data: SpendCalendar }) {
  const weeks = calendarWeeks(data.days);
  const marks = marksByDate(data.marks);
  return (
    <section aria-labelledby="grid-title" className={CARD}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="grid-title" className="text-xs font-extrabold">
          <span aria-hidden="true">🗓️ </span>Spent each day (₹)
        </h2>
        {data.per_day !== null && (
          <p className="text-xs font-bold text-zinc-600">
            <span className="text-gain">■</span> within {whole(data.per_day)} ·{" "}
            <span className="text-loss">■</span> over · reminders: ✓ paid, ! due, • coming
          </p>
        )}
      </div>
      <table className="w-full table-fixed border-separate border-spacing-1">
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} scope="col" className="text-[11px] font-black text-zinc-600 uppercase">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week, i) => (
            <tr key={i}>
              {week.map((day, j) => (
                <td key={j} className="p-0 align-top">
                  {day === null ? null : <DayCell day={day} marks={marks.get(day.date) ?? []} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs font-bold text-zinc-600">
        Rent, SIPs and other fixed payments aren&apos;t counted here: they&apos;re already taken out of the free amount. Pick a day to see its transactions.
      </p>
    </section>
  );
}

// The day's reminders as small badges; their names are in the cell's label and tooltip.
function MarkBadges({ marks }: { marks: Mark[] }) {
  if (marks.length === 0) return null;
  return (
    <span className="flex gap-0.5" aria-hidden="true">
      {marks.slice(0, 3).map((m) => (
        <span
          key={`${m.template_id}`}
          className={`flex size-3.5 items-center justify-center rounded-full text-[9px] leading-none font-black sm:size-4 ${MARK[m.state].className}`}
        >
          {MARK[m.state].symbol}
        </span>
      ))}
    </span>
  );
}

function DayCell({ day, marks }: { day: CalendarDay; marks: Mark[] }) {
  const tone = dayTone(day);
  const number = Number(day.date.slice(8));
  const box = `flex h-14 flex-col justify-between rounded-[10px] border-2 px-0.5 py-1 sm:h-20 sm:p-1.5 ${TONE[tone]}`;
  const reminders = marks.map(markText).join("; ");
  const reminderWords = reminders ? `. ${reminders}` : "";
  const top = (
    <span className="flex items-start justify-between gap-0.5">
      <span className="text-xs font-black">{number}</span>
      <MarkBadges marks={marks} />
    </span>
  );
  if (tone === "future") {
    return (
      <div className={box} aria-label={`${shortDate(day.date)}, still to come${reminderWords}`} title={reminders || undefined}>
        {top}
      </div>
    );
  }
  const spent = day.spent ?? "0.00";
  return (
    <Link
      href={dayTransactionsHref(day.date)}
      className={`${box} hover:-translate-y-0.5 ${FOCUS}`}
      aria-label={`${shortDate(day.date)}, spent ${formatRupees(spent)}${TONE_WORD[tone]}${reminderWords}`}
      title={reminders || undefined}
    >
      {top}
      {/* A phone's cell is too narrow for the ₹; the header says these are rupees. */}
      <span className="text-right text-[10px] leading-none font-black tracking-tight tabular-nums sm:hidden" aria-hidden="true">
        {shortRupees(spent).replace("₹", "")}
      </span>
      <span className="hidden truncate text-right text-sm font-black tabular-nums sm:block">{shortRupees(spent)}</span>
    </Link>
  );
}

type ListActions = {
  onEdit: (t: Template) => void;
  onChanged: () => void;
  onNotice: (message: string | null) => void;
};

function FixedMoney({
  data,
  templates,
  sips,
  onAdd,
  ...actions
}: {
  data: SpendCalendar;
  templates: Template[];
  sips: FixedLine[];
  onAdd: (type: TemplateType) => void;
} & ListActions) {
  const empty = templates.length === 0 && sips.length === 0;
  return (
    <section aria-labelledby="fixed-title" className={CARD}>
      <h2 id="fixed-title" className="text-sm font-black">
        <span aria-hidden="true">📌 </span>Your fixed money
      </h2>
      <p className="mt-1 text-xs font-bold text-zinc-600">
        {empty
          ? "Tell us what comes in and goes out every month (salary, rent, SIP, PPF) and we'll work out how much you can spend each day. You'll be reminded when each one is due."
          : `Every month: ${whole(data.income)} in − ${whole(data.fixed_out)} fixed = ${whole(data.free)} free. Changing these changes the daily amount.`}
      </p>
      {data.per_day === null && !empty && (
        <p className="mt-2 text-xs font-extrabold text-loss">Add your monthly income to get a daily amount.</p>
      )}
      {templates.length > 0 && (
        <div className="mt-3">
          <ReminderList templates={templates} caption="Your monthly reminders" {...actions} />
        </div>
      )}
      {sips.length > 0 && <SipList sips={sips} />}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={buttonClass("green")} onClick={() => onAdd("income")}>
          + Add income
        </button>
        <button type="button" className={buttonClass("pink")} onClick={() => onAdd("expense")}>
          + Add fixed expense
        </button>
      </div>
    </section>
  );
}

// SIP plans count as fixed money but are changed from Investments.
function SipList({ sips }: { sips: FixedLine[] }) {
  return (
    <div className="mt-3">
      <h3 className="mb-1 text-xs font-black tracking-wide uppercase">SIPs</h3>
      <ul className="flex flex-col gap-1.5">
        {sips.map((line) => (
          <li key={line.id} className="flex items-center justify-between gap-2 rounded-[12px] border-2 border-ink px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate font-extrabold">{line.name}</span>
              <span className="text-xs font-bold text-zinc-600">SIP · on the {ordinal(line.day)}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-black tabular-nums">{whole(line.amount)}</span>
              <Link href="/investments" className={`${SMALL_BUTTON} ${FOCUS}`} aria-label={`Change ${line.name} in Investments`}>
                Edit
              </Link>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OtherReminders({
  templates,
  onAdd,
  ...actions
}: { templates: Template[]; onAdd: (type: TemplateType, frequency?: Frequency) => void } & ListActions) {
  return (
    <section aria-labelledby="other-title" className={CARD}>
      <h2 id="other-title" className="text-sm font-black">
        <span aria-hidden="true">🗂️ </span>Other reminders
      </h2>
      <p className="mt-1 text-xs font-bold text-zinc-600">
        Yearly payments like insurance premiums, and reminders you&apos;ve stopped. They don&apos;t change the daily amount.
      </p>
      {templates.length > 0 ? (
        <div className="mt-3">
          <ReminderList templates={templates} caption="Yearly and stopped reminders" {...actions} />
        </div>
      ) : (
        <p className="mt-2 text-sm font-bold text-zinc-600">None yet.</p>
      )}
      <div className="mt-3">
        <button type="button" className={buttonClass("alt")} onClick={() => onAdd("expense", "yearly")}>
          + Add yearly reminder
        </button>
      </div>
    </section>
  );
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}
