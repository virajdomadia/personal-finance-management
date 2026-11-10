"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, formatFullDate } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import {
  ConfirmDelete,
  DIALOG,
  Notice,
  PRIMARY,
  QUIET,
  ROW_ACTION,
  SECONDARY,
  SECTION_TITLE,
  isUnauthorized,
} from "@/components/investments/shared";
import { type Policy, cardBillText, fundingText, renewalText } from "@/lib/insurance";
import { whole } from "@/lib/recurring";

import { PolicyDialog } from "./policy-dialog";
import { RenewDialog } from "./renew-dialog";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; policies: Policy[] };
type Dialog =
  | { kind: "none" }
  | { kind: "form"; policy: Policy | null }
  | { kind: "renew"; policy: Policy }
  | { kind: "lapse"; policy: Policy }
  | { kind: "delete"; policy: Policy };

export function InsuranceView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const latest = useRef(0);

  const fetchPolicies = useCallback(() => {
    const request = ++latest.current;
    apiFetch<{ policies: Policy[] }>("/insurance")
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", policies: data.policies });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const closeDialog = () => setDialog({ kind: "none" });
  const done = (message: string | null) => {
    setNotice(message);
    closeDialog();
    fetchPolicies();
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">Insurance</h1>
        <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form", policy: null })}>
          Add policy
        </button>
      </div>

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading your policies...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load your policies.</p>
          <button
            type="button"
            className={`${QUIET} mt-2 -ml-3`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchPolicies();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" &&
        (load.policies.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
            <p className="font-medium">No policies yet</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Add your health insurance to get a renewal reminder, see what each year cost, and check your premium fund covers it.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {load.policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                policy={policy}
                onEdit={() => setDialog({ kind: "form", policy })}
                onRenew={() => setDialog({ kind: "renew", policy })}
                onLapse={() => setDialog({ kind: "lapse", policy })}
                onDelete={() => setDialog({ kind: "delete", policy })}
              />
            ))}
          </div>
        ))}

      {dialog.kind === "form" && (
        <PolicyDialog
          key={dialog.policy?.id ?? "new"}
          policy={dialog.policy}
          onClose={closeDialog}
          onSaved={() => done(null)}
          onConflict={done}
        />
      )}

      {dialog.kind === "renew" && (
        <RenewDialog policy={dialog.policy} onClose={closeDialog} onRenewed={() => done(null)} />
      )}

      {dialog.kind === "lapse" && <LapseDialog policy={dialog.policy} onClose={closeDialog} onDone={done} />}

      {dialog.kind === "delete" && (
        <ConfirmDelete
          title={`Delete ${dialog.policy.insurer}?`}
          body="The policy and its reminder are removed for good. If premiums have been recorded for it, mark it lapsed instead."
          path={`/insurance/${dialog.policy.id}`}
          onClose={closeDialog}
          onDone={done}
        />
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function PolicyCard({
  policy,
  onEdit,
  onRenew,
  onLapse,
  onDelete,
}: {
  policy: Policy;
  onEdit: () => void;
  onRenew: () => void;
  onLapse: () => void;
  onDelete: () => void;
}) {
  const renewal = renewalText(policy);
  const funding = fundingText(policy);
  const cardBill = cardBillText(policy);
  const periods = [...policy.periods].sort((a, b) => (a.period_start < b.period_start ? 1 : -1));
  const name = `${policy.insurer}, ${policy.plan}`;
  return (
    <section aria-label={name} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <div className="min-w-0">
          <h2 className="text-base font-semibold [overflow-wrap:anywhere]">{policy.insurer}</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 [overflow-wrap:anywhere]">{policy.plan}</p>
        </div>
        <p className="text-sm">
          {renewal ?? (
            <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-xs font-medium dark:border-zinc-700">Lapsed</span>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Fact label="Policy number" value={policy.policy_number} />
          <Fact label="Insured" value={policy.insured} />
          <Fact label="Sum insured" value={whole(policy.sum_insured)} />
          <Fact label="Premium" value={`${whole(policy.premium)} a year`} />
        </dl>

        {(funding || cardBill) && (
          <div className="flex flex-col gap-2 text-sm">
            {funding && <p>{funding}</p>}
            {cardBill && (
              <p role="note" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <span className="font-medium">Heads up. </span>
                {cardBill}
              </p>
            )}
          </div>
        )}

        {policy.details && (
          <div>
            <h3 className={SECTION_TITLE}>Details</h3>
            <p className="px-1 text-sm whitespace-pre-line [overflow-wrap:anywhere]">{policy.details}</p>
          </div>
        )}

        {policy.premium_by_fy.length > 0 && (
          <div>
            <h3 className={SECTION_TITLE}>Premium paid by financial year</h3>
            <ul className="px-1 text-sm">
              {policy.premium_by_fy.map((fy) => (
                <li key={fy.fy} className="[overflow-wrap:anywhere]">
                  FY {fy.fy}: <span className="tabular-nums">{whole(fy.amount)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 px-1 text-xs text-zinc-500 dark:text-zinc-400">Health premiums are usually deductible under section 80D.</p>
          </div>
        )}

        {periods.length > 0 && (
          <div>
            <h3 className={SECTION_TITLE}>Policy years</h3>
            <ul className="divide-y divide-zinc-200 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {periods.map((p) => (
                <li key={p.period_start} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
                  <span className="[overflow-wrap:anywhere]">
                    {formatFullDate(p.period_start)} to {formatFullDate(p.period_end)}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {p.transaction_id === null ? `Paid ${formatFullDate(p.paid_on)}, before using the app` : `Paid ${formatFullDate(p.paid_on)}`}
                      {" · "}sum insured {whole(p.sum_insured)}
                    </span>
                  </span>
                  <span className="font-medium tabular-nums">{whole(p.premium)}</span>
                </li>
              ))}
            </ul>
            {periods.length > 1 && (
              <p className="mt-1 px-1 text-xs text-zinc-500 dark:text-zinc-400">
                Renewed by mistake? Delete the latest premium payment on the Transactions page and the policy goes back a year.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
        {policy.active && (
          <button type="button" className={PRIMARY} onClick={onRenew} aria-label={`Renew ${name}`}>
            Renew
          </button>
        )}
        <button type="button" className={SECONDARY} onClick={onEdit} aria-label={`Edit ${name}`}>
          Edit
        </button>
        {policy.active && (
          <button type="button" className={ROW_ACTION} onClick={onLapse} aria-label={`Mark ${name} lapsed`}>
            Mark lapsed
          </button>
        )}
        <button type="button" className={ROW_ACTION} onClick={onDelete} aria-label={`Delete ${name}`}>
          Delete
        </button>
      </div>
    </section>
  );
}

function LapseDialog({
  policy,
  onClose,
  onDone,
}: {
  policy: Policy;
  onClose: () => void;
  onDone: (message: string | null) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await apiFetch(`/insurance/${policy.id}/lapse`, { method: "POST" });
      onDone(null);
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else onDone(errorMessage(err));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="lapse-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(26rem,calc(100vw-2rem))]`}
    >
      <div className="px-5 py-4">
        <h2 id="lapse-title" className="text-base font-semibold">
          Mark {policy.insurer} as lapsed?
        </h2>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Its renewal reminder stops. The policy and its history stay.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button type="button" className={PRIMARY} disabled={saving} onClick={confirm}>
          {saving ? "Saving..." : "Mark lapsed"}
        </button>
      </div>
    </dialog>
  );
}
