"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { logout } from "@/app/login/actions";
import { formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type CashFlowMonth,
  type CategorySlice,
  categoryLink,
  changeText,
  changeTone,
  shortDate,
} from "@/lib/cash-flow";
import { FALLBACK_COLOUR, iconEmoji } from "@/lib/categories";
import { formatMonth } from "@/lib/transactions";
import { FOCUS, PageHeader, TABLE, TD, TD_NUM, TH, buttonClass } from "@/components/ui/chunky";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: CashFlowMonth };

const CARD = "min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky";
const MONTH_BUTTON = `${buttonClass("alt")} !rounded-full !px-3 !py-1.5 !text-xs !font-extrabold !shadow-chunky-sm`;
const TONE_CLASS = { good: "text-gain", bad: "text-loss", same: "text-zinc-600" } as const;

// The month report: totals against last month at the same day, daily spending and where it went.
export function CashFlowView({ month }: { month: string | null }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    let current = true;
    apiFetch<CashFlowMonth>(month ? `/cash-flow?month=${month}` : "/cash-flow")
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
  }, [month]);

  const title = month ? formatMonth(month) : "This month";
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={`Cash flow · ${load.status === "ready" ? formatMonth(load.data.month) : title}`}
        action={
          <>
            <Link href="/categories" className={`${buttonClass("alt")} uppercase`}>
              Categories
            </Link>
            {load.status === "ready" ? <MonthNav data={load.data} /> : null}
          </>
        }
      />
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
      {load.status === "ready" && <Report data={load.data} />}
    </div>
  );
}

function MonthNav({ data }: { data: CashFlowMonth }) {
  const link = (target: string | null, label: string, text: string) =>
    target === null ? (
      <span className={`${MONTH_BUTTON} opacity-40`} aria-disabled="true" aria-label={label}>
        {text}
      </span>
    ) : (
      <Link href={`/cash-flow?month=${target}`} className={MONTH_BUTTON} aria-label={label}>
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

function Report({ data }: { data: CashFlowMonth }) {
  const whole = !data.is_current;
  const netNegative = data.net.startsWith("-");
  return (
    <div className="flex flex-col gap-3.5">
      <p className="text-sm font-bold text-zinc-600">
        {data.is_current
          ? `1–${shortDate(data.through)}, compared with 1–${shortDate(data.previous.through)}.`
          : `The whole month, compared with ${formatMonth(data.previous.month)}.`}{" "}
        Transfers, card bill payments, investments and loan principal aren&apos;t spending; EMI interest is.
      </p>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <Total label="Spent" emoji="💸" amount={data.spending}>
          <span className={TONE_CLASS[changeTone(data.spending_change, "spending")]}>
            {changeText(data.spending_change, data.previous, whole)}
          </span>
        </Total>
        <Total label="Earned" emoji="💰" amount={data.income}>
          <span className={TONE_CLASS[changeTone(data.income_change, "income")]}>
            {changeText(data.income_change, data.previous, whole)}
          </span>
        </Total>
        <Total label="Net cash flow" emoji={netNegative ? "📉" : "📈"} amount={data.net}>
          <span className={TONE_CLASS[changeTone(data.net_change, "income")]}>
            {changeText(data.net_change, data.previous, whole)}
          </span>
        </Total>
      </div>

      <section aria-labelledby="daily-title" className={CARD}>
        <h2 id="daily-title" className="mb-2 text-xs font-extrabold">
          <span aria-hidden="true">📊 </span>Spending by day
        </h2>
        <DailyBars daily={data.daily} />
      </section>

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[3fr_2fr]">
        <CategoryTable
          title="Where it went"
          slices={data.spending_by_category}
          data={data}
          kind="expense"
          empty="No spending recorded this month."
        />
        <CategoryTable
          title="Where it came from"
          slices={data.income_by_category}
          data={data}
          kind="income"
          empty="No income recorded this month."
        />
      </div>
      <p className="text-xs font-bold text-zinc-600">
        {data.transaction_count} {data.transaction_count === 1 ? "transaction" : "transactions"} this month.{" "}
        <Link href={`/transactions?month=${data.month}`} className={`rounded underline ${FOCUS}`}>
          See them all
        </Link>
      </p>
    </div>
  );
}

function Total({
  label,
  emoji,
  amount,
  children,
}: {
  label: string;
  emoji: string;
  amount: string;
  children: React.ReactNode;
}) {
  return (
    <div className={CARD}>
      <p className="text-xs font-extrabold">
        <span aria-hidden="true">{emoji} </span>
        {label}
      </p>
      <p className="text-[22px] leading-tight font-black tabular-nums">{formatRupees(amount)}</p>
      <p className="mt-0.5 text-xs font-extrabold">{children}</p>
    </div>
  );
}

const BAR_W = 10;
const GAP = 4;
const CHART_H = 120;

// One bar a day, its height the server's percent of the month's biggest day. Days still to come
// are drawn as a dotted stub.
function DailyBars({ daily }: { daily: CashFlowMonth["daily"] }) {
  const width = daily.length * (BAR_W + GAP);
  const spent = daily.filter((d) => d.spent !== null && d.height !== null && d.height > 0);
  const biggest = spent.reduce<(typeof daily)[number] | null>(
    (top, d) => (top === null || (d.height ?? 0) > (top.height ?? 0) ? d : top),
    null,
  );
  const summary =
    biggest === null
      ? "No spending yet this month."
      : `Spending on ${spent.length} of ${daily.filter((d) => d.spent !== null).length} days; the biggest day was ${shortDate(biggest.date)} at ${formatRupees(biggest.spent ?? "0")}.`;
  return (
    <figure className="m-0">
      <div className="overflow-x-auto">
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${width} ${CHART_H + 16}`}
          className="h-40 w-full min-w-[420px]"
          preserveAspectRatio="none"
        >
          <line x1="0" x2={width} y1={CHART_H} y2={CHART_H} stroke="#1a1a1a" strokeWidth="1.5" />
          {daily.map((d, i) => {
            const x = i * (BAR_W + GAP) + GAP / 2;
            if (d.height === null) {
              return <rect key={d.date} x={x} y={CHART_H - 2} width={BAR_W} height={2} fill="#d4d4d8" />;
            }
            const h = Math.max(d.height > 0 ? 3 : 0, (d.height / 100) * (CHART_H - 4));
            return (
              <g key={d.date}>
                <rect x={x} y={CHART_H - h} width={BAR_W} height={h} rx="2" fill="#ff4b8b" stroke="#1a1a1a" strokeWidth={h > 0 ? 1 : 0}>
                  <title>{`${shortDate(d.date)}: ${formatRupees(d.spent ?? "0")}`}</title>
                </rect>
                {(i + 1) % 5 === 0 || i === 0 ? (
                  <text x={x + BAR_W / 2} y={CHART_H + 13} textAnchor="middle" fontSize="9" fontWeight="800" fill="#52525b">
                    {i + 1}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="mt-1 text-xs font-bold text-zinc-600">{summary} Hover a bar for its amount.</figcaption>
    </figure>
  );
}

function ShareBar({ slice }: { slice: CategorySlice }) {
  return (
    <div className="mt-1 h-2 w-full overflow-hidden rounded-full border-[1.5px] border-ink bg-zinc-100" aria-hidden="true">
      <div className="h-full" style={{ width: `${slice.percent}%`, background: slice.colour ?? FALLBACK_COLOUR }} />
    </div>
  );
}

function CategoryTable({
  title,
  slices,
  data,
  kind,
  empty,
}: {
  title: string;
  slices: CategorySlice[];
  data: CashFlowMonth;
  kind: "income" | "expense";
  empty: string;
}) {
  const id = `${kind}-table-title`;
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h2 id={id} className="mb-2 text-xs font-black tracking-wide uppercase">
        {title}
      </h2>
      {slices.length === 0 ? (
        <p className={`${CARD} text-sm font-extrabold`}>{empty}</p>
      ) : (
        <div className="overflow-x-auto pb-1">
          <table className={TABLE}>
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Category
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Amount
                </th>
                <th scope="col" className={`${TH} text-right`}>
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {slices.flatMap((slice) => [
                <Row key={`p-${slice.id ?? slice.name}`} slice={slice} data={data} kind={kind} />,
                ...(slice.children.length > 0 && slice.direct !== "0.00"
                  ? [
                      <tr key={`d-${slice.id}`}>
                        <td className={`${TD} pl-10 text-xs text-zinc-600`}>{slice.name} itself</td>
                        <td className={`${TD_NUM} text-xs text-zinc-600`}>{formatRupees(slice.direct)}</td>
                        <td className={TD} />
                      </tr>,
                    ]
                  : []),
                ...slice.children.map((child) => (
                  <Row key={`c-${child.id}`} slice={child} data={data} kind={kind} nested />
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Row({
  slice,
  data,
  kind,
  nested = false,
}: {
  slice: CategorySlice;
  data: CashFlowMonth;
  kind: "income" | "expense";
  nested?: boolean;
}) {
  return (
    <tr>
      <td className={`${TD} w-full min-w-40 ${nested ? "pl-10" : ""}`}>
        <Link href={categoryLink(data.month, slice.name, kind, data)} className={`rounded hover:underline ${FOCUS} ${nested ? "text-sm" : "font-extrabold"}`}>
          <span aria-hidden="true">{iconEmoji(slice.icon)} </span>
          {slice.name}
        </Link>
        <ShareBar slice={slice} />
      </td>
      <td className={`${TD_NUM} whitespace-nowrap ${nested ? "" : "font-black"}`}>{formatRupees(slice.amount)}</td>
      <td className={`${TD_NUM} whitespace-nowrap`}>{slice.percent}%</td>
    </tr>
  );
}
