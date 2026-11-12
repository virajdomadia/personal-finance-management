"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Dashboard, formatDueDate, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { Signed } from "@/components/investments/shared";
import { DueSection } from "@/components/recurring/due-list";
import { SetupChecklist } from "@/components/dashboard/setup-checklist";
import { MonthCard } from "@/components/dashboard/month-card";
import {
  FOCUS,
  PageHeader,
  ProgressBar,
  StackedBar,
  Tile,
  buttonClass,
} from "@/components/ui/chunky";
import { investmentSticker } from "@/lib/fun";
import { progressText } from "@/lib/goals";
import { cardBillText, reviewCountText } from "@/lib/review";

type Load =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: Dashboard };

const GROUP_LABELS: Record<Dashboard["asset_split"][number]["group"], string> =
  {
    bank_cash: "Bank & cash",
    deposits: "Deposits",
    stocks: "Stocks",
    funds: "Funds",
    crypto: "Crypto",
  };

const ITEM = `block border-b-[1.5px] border-dashed border-zinc-300 py-2 text-sm font-extrabold [overflow-wrap:anywhere] ${FOCUS}`;

export function DashboardView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const latest = useRef(0);

  const fetchDashboard = useCallback(() => {
    const request = ++latest.current;
    apiFetch<Dashboard>("/dashboard")
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Hey there! 👋"
        action={
          <Link href="/transactions" className={buttonClass("primary")}>
            + ADD TRANSACTION
          </Link>
        }
      />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your dashboard...
        </p>
      )}

      {load.status === "error" && (
        <div
          role="alert"
          className="rounded-[18px] border-[2.5px] border-ink bg-card p-5 shadow-chunky"
        >
          <p className="text-4xl" aria-hidden="true">
            🙈
          </p>
          <p className="mt-1 font-extrabold">
            We couldn&apos;t load your dashboard.
          </p>
          <button
            type="button"
            className={`mt-3 ${buttonClass("alt")}`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchDashboard();
            }}
          >
            TRY AGAIN
          </button>
        </div>
      )}

      {load.status === "ready" && (
        <Content data={load.data} onChanged={fetchDashboard} />
      )}
    </div>
  );
}

function Content({
  data,
  onChanged,
}: {
  data: Dashboard;
  onChanged: () => void;
}) {
  const bill = data.card_bill ?? null;
  // The card's statement bill says more than its due day, so the card isn't listed twice.
  const due = data.next_card_due && data.next_card_due.account_id !== bill?.account_id ? data.next_card_due : null;
  const used = data.credit_used;
  const investments = data.investments;
  const goals = data.goals ?? [];
  const goalsDue = data.goals_due ?? [];
  // The groups need not add up to total_have, so the bar works from its own parts.
  const split = (data.asset_split ?? []).map((item) => ({
    label: GROUP_LABELS[item.group],
    value: Number(item.value),
  }));
  const hasSplit = split.some((item) => item.value > 0);
  const negative = Number(data.net_worth) < 0;
  const toReview = data.to_review ?? 0;

  const emptyPrompt = (
    <div className="flex flex-col items-start gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-6 shadow-chunky">
      <p className="text-6xl" aria-hidden="true">
        🐷
      </p>
      <h2 className="text-xl font-black">Nothing here yet</h2>
      <p className="text-sm font-bold text-zinc-600">
        Add your first account and your net worth shows up here.
      </p>
      <Link href="/accounts" className={buttonClass("primary")}>
        ADD YOUR FIRST ACCOUNT
      </Link>
    </div>
  );

  const hasAccounts = data.has_accounts;
  const showAttention =
    hasAccounts ||
    !!bill ||
    !!due ||
    !!used ||
    data.recurring.length > 0 ||
    goalsDue.length > 0;

  return (
    <div className="flex flex-col gap-3.5">
      {toReview > 0 && (
        <Tile tone="purple" emoji="📥" label="To review" value={reviewCountText(toReview)} href="/review">
          <span className="mt-0.5 block text-xs font-extrabold">
            Bank messages the app couldn&apos;t sort by itself. Answer them to keep your records right.
          </span>
        </Tile>
      )}
      <SetupChecklist fallback={hasAccounts ? null : emptyPrompt} />
      {(hasAccounts || investments || hasSplit) && (
        <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-[2fr_1fr_1fr]">
          {hasAccounts && (
            <div className="sm:col-span-2 xl:col-span-1 xl:row-span-2 [&>*]:h-full">
              <Tile
                tone={negative ? "pink" : "green"}
                label="Net worth"
                value={formatRupees(data.net_worth)}
                size="huge"
              >
                {investments && (
                  <span className="mt-2 block text-xs font-extrabold">
                    Includes investments at their latest price (or cost if no
                    price yet)
                  </span>
                )}
              </Tile>
            </div>
          )}
          {hasAccounts && (
            <>
              <Tile
                tone="yellow"
                emoji="🏦"
                label="You have"
                value={formatRupees(data.total_have)}
                href="/accounts"
              />
              <Tile
                tone="pink"
                emoji="💳"
                label="You owe"
                value={formatRupees(data.total_owe)}
                href="/accounts"
              />
            </>
          )}
          {investments && (
            <Tile
              tone="blue"
              emoji="📈"
              label="Investments"
              value={formatRupees(investments.value)}
              sticker={investmentSticker(investments.unrealised_percent)}
              href="/investments"
            >
              <span className="mt-1.5 inline-block rounded-full border-2 border-ink bg-card px-2 py-0.5 text-xs font-extrabold text-ink">
                Unrealised <Signed value={investments.unrealised} />{" "}
                <Signed value={investments.unrealised_percent} percentOnly />
              </span>
            </Tile>
          )}
          {hasSplit && (
            <Tile label="Where it is" emoji="🧭">
              <StackedBar items={split} label="Where your money is" />
            </Tile>
          )}
        </div>
      )}
      {hasAccounts && <MonthCard />}

      <div
        className={`grid grid-cols-1 items-start gap-3.5 ${goals.length > 0 ? "sm:grid-cols-2" : ""}`}
      >
        {showAttention && (
          <section
            aria-labelledby="attention-title"
            className="min-w-0 rounded-[18px] border-[2.5px] border-ink bg-due p-3.5 shadow-chunky"
          >
            <h2 id="attention-title" className="mb-1 text-xs font-extrabold">
              <span aria-hidden="true">⏰ </span>Needs attention
            </h2>
            {(bill || due || used) && (
              <ul>
                {bill && (
                  <li>
                    <Link href="/accounts" className={ITEM}>
                      {cardBillText(bill)}
                    </Link>
                  </li>
                )}
                {due && (
                  <li>
                    <Link href="/accounts" className={ITEM}>
                      {due.name} due {formatDueDate(due.due_date)}
                    </Link>
                  </li>
                )}
                {used && (
                  <li>
                    <Link href="/accounts" className={ITEM}>
                      {used.percent}% of credit limit used
                    </Link>
                  </li>
                )}
              </ul>
            )}
            <DueSection
              items={data.recurring}
              goals={goalsDue}
              onChanged={onChanged}
              embedded
            />
            {hasAccounts &&
              !bill &&
              !due &&
              !used &&
              data.recurring.length === 0 &&
              goalsDue.length === 0 && (
                <p className="py-2 text-sm font-extrabold">
                  <span aria-hidden="true">🎉 </span>All caught up. Nothing
                  needs you right now.
                </p>
              )}
          </section>
        )}

        {goals.length > 0 && (
          <section
            aria-labelledby="goals-title"
            className="min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky"
          >
            <h2 id="goals-title" className="mb-1 text-xs font-extrabold">
              <span aria-hidden="true">🎯 </span>Goals
            </h2>
            <ul>
              {goals.map((g) => (
                <li
                  key={g.id}
                  className="border-b-[1.5px] border-dashed border-zinc-300 last:border-b-0"
                >
                  <Link
                    href={`/goals/${g.id}`}
                    className={`block py-2 ${FOCUS}`}
                  >
                    <span className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <span className="text-sm font-extrabold [overflow-wrap:anywhere]">
                        {g.name}
                      </span>
                      <span className="text-xs font-bold tabular-nums">
                        {progressText(g)}
                      </span>
                    </span>
                    {g.target !== null && (
                      <ProgressBar
                        percent={g.percent}
                        reached={g.reached}
                        label={`${g.name} progress`}
                        className="mt-2"
                      />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
