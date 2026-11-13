"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, formatFullDate } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import {
  ConfirmDelete,
  DIALOG,
  LIST,
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
import { PageHeader, TABLE, TD, TD_NUM, TH, Tile, buttonClass } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";

import { PolicyDialog } from "./policy-dialog";
import { RenewDialog } from "./renew-dialog";

// A policy renewing within this many days (or already past) is listed under Renew soon.
const RENEW_SOON_DAYS = 60;

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

  const policies = load.status === "ready" ? load.policies : [];
  const active = policies.filter((p) => p.active);
  const lapsed = policies.filter((p) => !p.active);
  const soon = active.filter((p) => p.days_to_renewal !== null && p.days_to_renewal <= RENEW_SOON_DAYS);
  const cover = active.reduce((sum, p) => sum + Number(p.sum_insured), 0);

  const rowProps = (policy: Policy) => ({
    policy,
    onEdit: () => setDialog({ kind: "form", policy }),
    onRenew: () => setDialog({ kind: "renew", policy }),
    onLapse: () => setDialog({ kind: "lapse", policy }),
    onDelete: () => setDialog({ kind: "delete", policy }),
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Insurance"
        action={
          <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form", policy: null })}>
            + Add policy
          </button>
        }
      />

      <Notice message={notice} />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your policies...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load your policies.</p>
          <button
            type="button"
            className={`${QUIET} mt-2`}
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
        (policies.length === 0 ? (
          <EmptyState
            emoji="🛡️"
            title="No policies yet"
            action={
              <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form", policy: null })}>
                + Add policy
              </button>
            }
          >
            Add your health insurance to get a reminder before it renews and see what each year cost.
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-8">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Tile
                tone="green"
                emoji="🛡️"
                label="You're covered for"
                size="huge"
                value={whole(String(cover))}
              >
                <span className="mt-1 block text-xs font-bold">
                  {active.length} active {active.length === 1 ? "policy" : "policies"}
                </span>
              </Tile>
            </div>

            {soon.length > 0 && (
              <section
                aria-labelledby="renew-soon-title"
                className="rounded-[18px] border-[2.5px] border-ink bg-due p-3.5 shadow-chunky"
              >
                <h2 id="renew-soon-title" className="mb-0.5 text-xs font-black tracking-wide uppercase">
                  Renew soon
                </h2>
                <ul>
                  {soon.map((policy) => {
                    const name = `${policy.insurer}, ${policy.plan}`;
                    return (
                      <li
                        key={policy.id}
                        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b-[1.5px] border-dashed border-zinc-300 py-2 last:border-b-0"
                      >
                        <p className="min-w-40 flex-1 text-sm font-extrabold [overflow-wrap:anywhere]">
                          {policy.insurer}
                          <span className="block text-xs font-bold text-zinc-700">{renewalText(policy)}</span>
                        </p>
                        <button
                          type="button"
                          className={`${buttonClass("green")} !px-3 !py-1 uppercase`}
                          aria-label={`Renew ${name} soon`}
                          onClick={() => setDialog({ kind: "renew", policy })}
                        >
                          Renew
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {active.length > 0 && (
              <PolicyTable title="Active" id="active-policies-title">
                {active.map((policy) => (
                  <PolicyRows key={policy.id} {...rowProps(policy)} />
                ))}
              </PolicyTable>
            )}

            {lapsed.length > 0 && (
              <PolicyTable title="Lapsed" id="lapsed-policies-title">
                {lapsed.map((policy) => (
                  <PolicyRows key={policy.id} {...rowProps(policy)} />
                ))}
              </PolicyTable>
            )}
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
      <dt className="text-xs font-extrabold text-zinc-600">{label}</dt>
      <dd className="mt-0.5 text-sm font-extrabold [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function PolicyTable({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className={SECTION_TITLE}>
        {title}
      </h2>
      <div className="overflow-x-auto pb-1">
        <table className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
          <caption className="sr-only">{title} policies</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Policy
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Sum insured
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Premium
              </th>
            </tr>
          </thead>
          {children}
        </table>
      </div>
    </section>
  );
}

// One policy: a summary row, then its detail and actions in a row of its own beneath.
function PolicyRows({
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
  const bare = "!border-b-0 !pb-1";
  return (
    <tbody aria-label={name} className="[&:last-child>tr:last-child>td]:border-b-0 [&:last-child>tr:last-child>th]:border-b-0">
      <tr>
        <th scope="row" className={`${TD} ${bare} min-w-40 text-left [overflow-wrap:anywhere]`}>
          <span className="block text-base font-black">{policy.insurer}</span>
          <span className="block text-sm font-bold text-zinc-700">{policy.plan}</span>
          <span className="mt-1 block text-xs font-extrabold">
            {renewal ?? (
              <span className="rounded-full border-2 border-ink bg-card px-2 py-0.5 font-black">Lapsed</span>
            )}
          </span>
        </th>
        <td className={`${TD_NUM} ${bare} align-top whitespace-nowrap`}>{whole(policy.sum_insured)}</td>
        <td className={`${TD_NUM} ${bare} align-top whitespace-nowrap`}>
          {whole(policy.premium)}
          <span className="block text-xs font-bold text-zinc-600">a year</span>
        </td>
      </tr>
      <tr>
        <td colSpan={3} className={`${TD} !border-b-[2.5px] !border-b-ink`}>
          <div className="flex flex-col gap-4 py-1">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Fact label="Policy number" value={policy.policy_number} />
              <Fact label="Insured" value={policy.insured} />
            </dl>

            {(funding || cardBill) && (
              <div className="flex flex-col gap-2 text-sm font-bold">
                {funding && <p>{funding}</p>}
                {cardBill && (
                  <p role="note" className="rounded-[14px] border-[2.5px] border-ink bg-due px-3 py-2 text-ink">
                    <span className="font-black">Heads up. </span>
                    {cardBill}
                  </p>
                )}
              </div>
            )}

            {policy.details && (
              <div>
                <h3 className={SECTION_TITLE}>Details</h3>
                <p className="px-1 text-sm font-bold whitespace-pre-line [overflow-wrap:anywhere]">{policy.details}</p>
              </div>
            )}

            {policy.premium_by_fy.length > 0 && (
              <div>
                <h3 className={SECTION_TITLE}>Premium paid by financial year</h3>
                <ul className="px-1 text-sm font-bold">
                  {policy.premium_by_fy.map((fy) => (
                    <li key={fy.fy} className="[overflow-wrap:anywhere]">
                      FY {fy.fy}: <span className="tabular-nums">{whole(fy.amount)}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 px-1 text-xs font-bold text-zinc-600">Health premiums are usually deductible under section 80D.</p>
              </div>
            )}

            {periods.length > 0 && (
              <div>
                <h3 className={SECTION_TITLE}>Policy years</h3>
                <ul className={LIST}>
                  {periods.map((p) => (
                    <li key={p.period_start} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
                      <span className="min-w-0 font-extrabold [overflow-wrap:anywhere]">
                        {formatFullDate(p.period_start)} to {formatFullDate(p.period_end)}
                        <span className="block text-xs font-bold text-zinc-600">
                          {p.transaction_id === null ? `Paid ${formatFullDate(p.paid_on)}, before using the app` : `Paid ${formatFullDate(p.paid_on)}`}
                          {" · "}sum insured {whole(p.sum_insured)}
                        </span>
                      </span>
                      <span className="font-black tabular-nums">{whole(p.premium)}</span>
                    </li>
                  ))}
                </ul>
                {periods.length > 1 && (
                  <p className="mt-2 px-1 text-xs font-bold text-zinc-600">
                    Renewed by mistake? Delete the latest premium payment on the Transactions page and the policy goes back a year.
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              {policy.active && (
                <button type="button" className={PRIMARY} onClick={onRenew} aria-label={`Renew ${name}`}>
                  Renew
                </button>
              )}
              <button type="button" className={SECONDARY} onClick={onEdit} aria-label={`Edit ${name}`}>
                Edit
              </button>
              {policy.active && (
                <button type="button" className={ROW_ACTION} onClick={onLapse} aria-label={`Mark lapsed ${name}`}>
                  Mark lapsed
                </button>
              )}
              <button type="button" className={ROW_ACTION} onClick={onDelete} aria-label={`Delete ${name}`}>
                Delete
              </button>
            </div>
          </div>
        </td>
      </tr>
    </tbody>
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
      <h2 id="lapse-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black [overflow-wrap:anywhere]">
        Mark {policy.insurer} as lapsed?
      </h2>
      <div className="px-5 py-4">
        <p className="text-sm font-bold text-zinc-700">
          Its renewal reminder stops. The policy and its history stay.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
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
