"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { logout } from "@/app/login/actions";
import { formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CalendarDay,
  type FixedLine,
  type SpendCalendar,
  calendarPath,
  calendarWeeks,
  dayTone,
  dayTransactionsHref,
  paceText,
  shortDate,
  shortRupees,
} from "@/lib/cash-flow";
import { type Template, type TemplateType, whole } from "@/lib/recurring";
import { formatMonth } from "@/lib/transactions";
import { Notice } from "@/components/investments/shared";
import { TemplateDialog } from "@/components/recurring/template-dialog";
import { FOCUS, PageHeader, buttonClass } from "@/components/ui/chunky";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: SpendCalendar };
type Dialog = { kind: "none" } | { kind: "add"; type: TemplateType } | { kind: "edit"; template: Template };

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

// The spending calendar: the month's fixed money, the daily amount it leaves, and each day's
// spending against it. Fixed money is kept as monthly reminders, added and changed right here.
export function SpendCalendarView({ month }: { month: string | null }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let current = true;
    apiFetch<SpendCalendar>(month ? `/calendar?month=${month}` : "/calendar")
      .then((data) => {
        if (current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (current) setLoad({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [month, version]);

  // The dialog edits a whole reminder, so fetch it before opening.
  const edit = (line: FixedLine) => {
    apiFetch<{ templates: Template[] }>("/recurring")
      .then(({ templates }) => {
        const template = templates.find((t) => t.id === line.id);
        if (template) setDialog({ kind: "edit", template });
        else setNotice("That reminder has gone. Reload the page.");
      })
      .catch(() => setNotice("We couldn't open that reminder. Try again."));
  };
  const closeDialog = () => setDialog({ kind: "none" });
  const fixedMoney = (data: SpendCalendar) => (
    <FixedMoney data={data} onAdd={(type) => setDialog({ kind: "add", type })} onEdit={edit} />
  );

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
        <div className="flex flex-col gap-3.5">
          {/* Until there's a daily amount, asking for the fixed money comes first. */}
          {load.data.per_day === null && fixedMoney(load.data)}
          <Summary data={load.data} />
          <MonthGrid data={load.data} />
          {load.data.per_day !== null && fixedMoney(load.data)}
        </div>
      )}
      {dialog.kind !== "none" && (
        <TemplateDialog
          key={dialog.kind === "edit" ? dialog.template.id : `new-${dialog.type}`}
          template={dialog.kind === "edit" ? dialog.template : null}
          frequency="monthly"
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
  return (
    <section aria-labelledby="grid-title" className={CARD}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="grid-title" className="text-xs font-extrabold">
          <span aria-hidden="true">🗓️ </span>Spent each day (₹)
        </h2>
        {data.per_day !== null && (
          <p className="text-xs font-bold text-zinc-600">
            <span className="text-gain">■</span> within {whole(data.per_day)} ·{" "}
            <span className="text-loss">■</span> over
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
                  {day === null ? null : <DayCell day={day} />}
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

function DayCell({ day }: { day: CalendarDay }) {
  const tone = dayTone(day);
  const number = Number(day.date.slice(8));
  const box = `flex h-14 flex-col justify-between rounded-[10px] border-2 px-0.5 py-1 sm:h-20 sm:p-1.5 ${TONE[tone]}`;
  if (tone === "future") {
    return (
      <div className={box} aria-label={`${shortDate(day.date)}, still to come`}>
        <span className="text-xs font-black">{number}</span>
      </div>
    );
  }
  const spent = day.spent ?? "0.00";
  return (
    <Link
      href={dayTransactionsHref(day.date)}
      className={`${box} hover:-translate-y-0.5 ${FOCUS}`}
      aria-label={`${shortDate(day.date)}, spent ${formatRupees(spent)}${TONE_WORD[tone]}`}
    >
      <span className="text-xs font-black">{number}</span>
      {/* A phone's cell is too narrow for the ₹; the header says these are rupees. */}
      <span className="text-right text-[10px] leading-none font-black tracking-tight tabular-nums sm:hidden" aria-hidden="true">
        {shortRupees(spent).replace("₹", "")}
      </span>
      <span className="hidden truncate text-right text-sm font-black tabular-nums sm:block">{shortRupees(spent)}</span>
    </Link>
  );
}

function FixedMoney({
  data,
  onAdd,
  onEdit,
}: {
  data: SpendCalendar;
  onAdd: (type: TemplateType) => void;
  onEdit: (line: FixedLine) => void;
}) {
  const income = data.fixed.filter((f) => f.kind === "income");
  const out = data.fixed.filter((f) => f.kind === "out");
  const empty = data.fixed.length === 0;
  return (
    <section aria-labelledby="fixed-title" className={CARD}>
      <h2 id="fixed-title" className="text-sm font-black">
        <span aria-hidden="true">📌 </span>Your fixed money
      </h2>
      <p className="mt-1 text-xs font-bold text-zinc-600">
        {empty
          ? "Tell us what comes in and goes out every month (salary, rent, SIP, PPF) and we'll work out how much you can spend each day."
          : "What comes in and goes out every month. Changing these changes the daily amount."}
      </p>
      {data.per_day === null && !empty && (
        <p className="mt-2 text-xs font-extrabold text-loss">Add your monthly income to get a daily amount.</p>
      )}
      <div className="mt-3 grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <FixedList title="Comes in" lines={income} onEdit={onEdit} empty="No monthly income yet." />
        <FixedList title="Goes out" lines={out} onEdit={onEdit} empty="No fixed expenses yet." />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={buttonClass("green")} onClick={() => onAdd("income")}>
          + Add income
        </button>
        <button type="button" className={buttonClass("pink")} onClick={() => onAdd("expense")}>
          + Add fixed expense
        </button>
        <Link href="/recurring" className={`${buttonClass("alt")} ${FOCUS}`}>
          All reminders
        </Link>
      </div>
    </section>
  );
}

function FixedList({
  title,
  lines,
  empty,
  onEdit,
}: {
  title: string;
  lines: FixedLine[];
  empty: string;
  onEdit: (line: FixedLine) => void;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-black tracking-wide uppercase">{title}</h3>
      {lines.length === 0 ? (
        <p className="text-sm font-bold text-zinc-600">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {lines.map((line) => (
            <li
              key={`${line.source}-${line.id}`}
              className="flex items-center justify-between gap-2 rounded-[12px] border-2 border-ink px-3 py-2"
            >
              <span className="min-w-0">
                <span className="block truncate font-extrabold">{line.name}</span>
                <span className="text-xs font-bold text-zinc-600">
                  {line.source === "sip" ? "SIP · " : ""}on the {ordinal(line.day)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="font-black tabular-nums">{whole(line.amount)}</span>
                {line.source === "reminder" ? (
                  <button type="button" className={SMALL_BUTTON} onClick={() => onEdit(line)} aria-label={`Edit ${line.name}`}>
                    Edit
                  </button>
                ) : (
                  <Link href="/investments" className={`${SMALL_BUTTON} ${FOCUS}`} aria-label={`Change ${line.name} in Investments`}>
                    Edit
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${tail}`;
}
