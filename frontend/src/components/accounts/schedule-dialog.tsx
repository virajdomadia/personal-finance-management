"use client";

import { useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { type Account, type LoanSchedule, errorMessage, formatDueDate, formatRupees, scheduleSummary } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { buttonClass } from "@/components/ui/chunky";

const TH = "border-b-2 border-ink px-2 py-1.5 text-right text-[11px] font-black uppercase first:text-left";
const TD = "border-b border-zinc-200 px-2 py-1.5 text-right tabular-nums first:text-left";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const whole = (amount: string) => formatRupees(amount.replace(/\.00$/, ""));
// "5 Dec 2026", or "Dec 2026" when the loan has no due day.
const when = (month: string, due: string | null) =>
  due ? `${formatDueDate(due)} ${due.slice(0, 4)}` : `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

// A loan's EMIs from here to the end, split into interest and principal.
export function ScheduleDialog({ loan, onClose }: { loan: Account; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [schedule, setSchedule] = useState<LoanSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let current = true;
    apiFetch<LoanSchedule>(`/accounts/${loan.id}/schedule`)
      .then((s) => {
        if (current) setSchedule(s);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (current) setError(errorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [loan.id]);

  const summary = schedule ? scheduleSummary(schedule) : null;
  return (
    <dialog
      ref={ref}
      aria-labelledby="schedule-dialog-title"
      onClose={onClose}
      className="m-auto w-[min(44rem,calc(100vw-2rem))] rounded-[18px] border-[2.5px] border-ink bg-card p-0 text-ink shadow-chunky backdrop:bg-ink/60"
    >
      <div className="flex max-h-[90vh] flex-col">
        <h2 id="schedule-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black">
          {loan.name}: repayment schedule
        </h2>
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          {schedule === null && error === null ? (
            <p role="status" className="text-sm font-bold text-zinc-600">
              Working it out...
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {error}
            </p>
          ) : null}
          {schedule?.paid_off ? <p className="text-sm font-extrabold">Paid off. Nothing left to repay.</p> : null}
          {schedule?.problem ? <p className="text-sm font-extrabold text-loss">{schedule.problem}</p> : null}
          {summary && schedule ? (
            <>
              <p className="text-sm font-extrabold">
                {summary}
                <span className="block text-xs font-bold text-zinc-600">
                  {schedule.rate}% a year · EMI {whole(schedule.emi ?? "0")} · from {whole(schedule.owed)} owed today
                </span>
              </p>
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">EMIs left on {loan.name}</caption>
                <thead>
                  <tr>
                    <th scope="col" className={TH}>Due</th>
                    <th scope="col" className={TH}>EMI</th>
                    <th scope="col" className={TH}>Interest</th>
                    <th scope="col" className={TH}>Principal</th>
                    <th scope="col" className={TH}>Left after</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.rows.map((r) => (
                    <tr key={r.month}>
                      <td className={`${TD} font-extrabold`}>{when(r.month, r.due)}</td>
                      <td className={TD}>{whole(r.amount)}</td>
                      <td className={TD}>{whole(r.interest)}</td>
                      <td className={TD}>{whole(r.principal)}</td>
                      <td className={TD}>{whole(r.left)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </div>
        <div className="flex justify-end border-t-[2.5px] border-ink px-5 py-3">
          <button type="button" onClick={() => ref.current?.close()} className={`${buttonClass("alt")} uppercase`}>
            Close
          </button>
        </div>
      </div>
    </dialog>
  );
}
