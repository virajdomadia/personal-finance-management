"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type AccountList } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { REVIEW_CHANGED, type ReviewItem, type ReviewList, reviewCountText } from "@/lib/review";
import type { CategoryList } from "@/lib/transactions";
import { Notice, isUnauthorized } from "@/components/investments/shared";
import { PageHeader, buttonClass } from "@/components/ui/chunky";
import { ReviewCard } from "@/components/review/review-card";

type Data = { items: ReviewItem[]; accounts: Account[]; categories: CategoryList };
type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: Data };

const itemKey = (item: ReviewItem) => `${item.id}-${item.reason}`;

// Messages the app couldn't sort by itself, one card each. An answer takes its card away at once;
// the list then reloads quietly, since one answer can settle others (the same payee's, say).
export function ReviewView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
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
        setLoad({ status: "ready", data: { items: review.items, accounts: accounts.accounts, categories } });
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

  const items = load.status === "ready" ? load.data.items : [];

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
        <div className="flex flex-col items-start gap-2 rounded-[18px] border-[2.5px] border-ink bg-card p-6 shadow-chunky">
          <p className="text-5xl" aria-hidden="true">
            🎉
          </p>
          <h2 className="text-xl font-black">Nothing to review</h2>
          <p className="text-sm font-bold text-zinc-600">
            Bank messages the app can&apos;t sort by itself show up here.
          </p>
        </div>
      )}

      {load.status === "ready" && items.length > 0 && (
        <>
          <p className="mb-3 text-sm font-extrabold" aria-live="polite">
            {reviewCountText(items.length)}
          </p>
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
