"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList, errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type ApproveResult,
  type ConfidentSummary,
  type Learnable,
  REVIEW_CHANGED,
  type ReviewItem,
  type ReviewList,
  approveButtonText,
  approveResultText,
  confidentTotalsText,
  reviewCountText,
} from "@/lib/review";
import type { CategoryList } from "@/lib/transactions";
import { Notice, isUnauthorized } from "@/components/investments/shared";
import { PageHeader, buttonClass } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";
import { ApproveDialog } from "@/components/review/approve-dialog";
import { ReviewCard } from "@/components/review/review-card";

type Data = { items: ReviewItem[]; confident: ConfidentSummary; accounts: Account[]; categories: CategoryList };
// What the last "Approve all" did, with a label for each skipped item from the list it was sent from.
type Outcome = { result: ApproveResult; labels: Record<number, string> };
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: Data };

const itemKey = (item: ReviewItem) => `${item.id}-${item.reason}`;

// Messages the app couldn't sort by itself, one card each. An answer takes its card away at once;
// the list then reloads quietly, since one answer can settle others (the same payee's, say).
export function ReviewView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const latest = useRef(0);

  const fetchAll = useCallback(() => {
    const request = ++latest.current;
    Promise.all([
      apiFetch<ReviewList>("/sms/review"),
      apiFetch<AccountList>("/accounts"),
      apiFetch<CategoryList>("/transactions/categories"),
    ])
      .then(([review, accounts, categories]) => {
        if (request !== latest.current) return;
        setLoad({
          status: "ready",
          data: { items: review.items, confident: review.confident, accounts: accounts.accounts, categories },
        });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad((l) => (l.status === "ready" ? l : { status: "error" }));
      });
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const changed = useCallback(() => {
    window.dispatchEvent(new Event(REVIEW_CHANGED));
    fetchAll();
  }, [fetchAll]);

  const answered = useCallback(
    (item: ReviewItem, next: ReviewItem | null) => {
      setNotice(null);
      setLoad((l) => {
        if (l.status !== "ready") return l;
        const items = next
          ? l.data.items.map((i) => (i.id === item.id ? next : i))
          : l.data.items.filter((i) => i.id !== item.id);
        return { status: "ready", data: { ...l.data, items } };
      });
      changed();
    },
    [changed],
  );

  const stale = useCallback(
    (message: string) => {
      setNotice(message);
      changed();
    },
    [changed],
  );

  const approved = useCallback(
    (result: ApproveResult) => {
      if (load.status !== "ready") return;
      const labels = Object.fromEntries(load.data.items.map((i) => [i.id, i.payee ?? reviewCountText(1)]));
      setNotice(null);
      setOutcome({ result, labels });
      changed();
    },
    [load, changed],
  );

  const items = load.status === "ready" ? load.data.items : [];
  const confident = load.status === "ready" ? load.data.confident : null;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="To review"
        action={
          <Link href="/payee-rules" className={`${buttonClass("alt")} uppercase`}>
            Payee rules
          </Link>
        }
      />

      <Notice message={notice} />

      {outcome && <ApproveOutcome outcome={outcome} onClose={() => setOutcome(null)} onLearned={changed} />}

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your messages...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-5 shadow-chunky">
          <p className="font-extrabold">We couldn&apos;t load your messages.</p>
          <button
            type="button"
            className={`mt-3 ${buttonClass("alt")} uppercase`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchAll();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" && items.length === 0 && (
        <EmptyState
          emoji="🎉"
          title="Nothing to review"
          action={
            <Link href="/transactions" className={buttonClass("alt")}>
              SEE TRANSACTIONS
            </Link>
          }
        >
          When the Android app reads a bank text it can&apos;t sort by itself, it waits here for you to check.
        </EmptyState>
      )}

      {load.status === "ready" && items.length > 0 && (
        <>
          <p className="mb-3 text-sm font-extrabold" aria-live="polite">
            {reviewCountText(items.length)}
          </p>
          {confident && confident.count > 0 && (
            <section
              aria-labelledby="confident-title"
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[18px] border-[2.5px] border-ink bg-green/15 px-4 py-3 shadow-chunky"
            >
              <div className="min-w-0">
                <h2 id="confident-title" className="text-base font-black">
                  {confident.total === 1 ? "1 is ready to approve" : `${confident.total} are ready to approve`}
                </h2>
                <p className="text-sm font-bold text-zinc-700 tabular-nums">
                  {`${confidentTotalsText(confident)}${confident.count < confident.total ? ` in the oldest ${confident.count}` : ""} · their payee rule, a known merchant or past payments say the category`}
                </p>
              </div>
              <button type="button" className={`${buttonClass("green")} uppercase`} onClick={() => setConfirming(true)}>
                {approveButtonText(confident)}
              </button>
            </section>
          )}
          {confirming && confident && (
            <ApproveDialog
              items={items}
              summary={confident}
              onClose={() => setConfirming(false)}
              onDone={approved}
            />
          )}
          <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
            {items.map((item) => (
              <ReviewCard
                key={itemKey(item)}
                item={item}
                accounts={load.data.accounts}
                categories={load.data.categories}
                onAnswered={answered}
                onStale={stale}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// What "Approve all" did: the count, anything it left (and why), and a one-tap rule for each payee
// approved from its history, so it never waits again.
function ApproveOutcome({
  outcome,
  onClose,
  onLearned,
}: {
  outcome: Outcome;
  onClose: () => void;
  // A rule was made: the payee's other waiting items may now be ready to approve.
  onLearned: () => void;
}) {
  const { result, labels } = outcome;
  return (
    <section
      aria-labelledby="outcome-title"
      className="mb-4 flex flex-col gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="outcome-title" role="status" className="text-base font-black">
          {approveResultText(result)}
        </h2>
        <button type="button" className={`${buttonClass("alt")} !px-2.5 !py-1 uppercase`} onClick={onClose}>
          Done
        </button>
      </div>
      {result.skipped.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm font-bold">
          {result.skipped.map((s) => (
            <li key={s.id} className="[overflow-wrap:anywhere]">
              <span className="font-extrabold">{labels[s.id] ?? "A message"}</span>: {s.reason}
            </li>
          ))}
        </ul>
      )}
      {result.learn.length > 0 && (
        <div className="flex flex-col gap-2 border-t-[1.5px] border-dashed border-zinc-300 pt-3">
          <p className="text-xs font-black tracking-wide uppercase">Make these automatic next time?</p>
          <div className="flex flex-wrap gap-2">
            {result.learn.map((l) => (
              <LearnButton key={l.entry_id} learn={l} onSaved={onLearned} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function LearnButton({ learn, onSaved }: { learn: Learnable; onSaved: () => void }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  // The payee already has another rule (a transfer, say): it isn't offered again.
  const [refused, setRefused] = useState<string | null>(null);
  async function save() {
    if (state === "saving" || state === "saved") return;
    setState("saving");
    try {
      await apiFetch("/payee-rules", {
        method: "POST",
        body: JSON.stringify({ entry_id: learn.entry_id, category: learn.category }),
      });
      setState("saved");
      onSaved();
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else if (err instanceof ApiError && err.status === 409) setRefused(errorMessage(err));
      else setState("failed");
    }
  }
  if (refused !== null) {
    return <p className="text-sm font-bold text-zinc-600 [overflow-wrap:anywhere]">{refused}</p>;
  }
  const text = `Always use ${learn.category} for ${learn.payee}`;
  return (
    <button
      type="button"
      onClick={save}
      disabled={state === "saving" || state === "saved"}
      aria-live="polite"
      className={`${buttonClass(state === "saved" ? "alt" : "green")} !px-3 !py-1.5 text-left !normal-case`}
    >
      {state === "saving" ? "Saving..." : state === "saved" ? `Saved: ${text}` : state === "failed" ? `Try again: ${text}` : text}
    </button>
  );
}
