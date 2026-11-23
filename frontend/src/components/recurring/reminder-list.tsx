"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, formatDueDate, formatFullDate } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { type Template, scheduleText, toggleLabel, whole } from "@/lib/recurring";
import { ConfirmDelete, ROW_ACTION, isUnauthorized } from "@/components/investments/shared";
import { FOCUS, TABLE, TD, TD_NUM, TH } from "@/components/ui/chunky";

const TYPE_LABEL = { expense: "Expense", income: "Income", transfer: "Transfer" } as const;

// "Due since 1 Mar", "Next: 6 Apr", or why there is nothing to show.
function nextText(t: Template): string {
  if (!t.active) return "Stopped";
  if (t.due.length > 0) return `Due since ${formatDueDate(t.due[0])}`;
  if (t.coming_up) return `Coming up on ${formatDueDate(t.coming_up)}`;
  if (t.end_date) return `Ends ${formatFullDate(t.end_date)}`;
  return "Nothing due yet";
}

type Props = {
  templates: Template[];
  caption: string;
  onEdit: (t: Template) => void;
  onChanged: () => void; // after a stop, restart, delete or undone skip
  onNotice: (message: string | null) => void;
};

// Reminders with their actions: edit, stop or restart, delete, and undo a skipped date.
export function ReminderList({ templates, caption, onEdit, onChanged, onNotice }: Props) {
  const [toggling, setToggling] = useState<number | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Template | null>(null);
  const busy = useRef(false);

  async function toggle(t: Template) {
    if (busy.current) return;
    busy.current = true;
    setToggling(t.id);
    onNotice(null);
    try {
      await apiFetch(`/recurring/${t.id}`, { method: "PATCH", body: JSON.stringify({ active: !t.active }) });
      onChanged();
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else onNotice(errorMessage(err));
    } finally {
      busy.current = false;
      setToggling(null);
    }
  }

  // Un-skip an occurrence, so it shows as due (or coming up) again.
  async function undoSkip(t: Template, occurrence: string) {
    if (busy.current) return;
    busy.current = true;
    setUndoing(`${t.id}-${occurrence}`);
    onNotice(null);
    try {
      await apiFetch(`/recurring/${t.id}/skip/${occurrence}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else {
        onNotice(errorMessage(err));
        onChanged();
      }
    } finally {
      busy.current = false;
      setUndoing(null);
    }
  }

  return (
    <>
      <div className="overflow-x-auto pb-1">
        <table className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Reminder
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Amount
              </th>
              <th scope="col" className={`${TH} w-px`}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                toggling={toggling === t.id}
                undoing={undoing}
                onUndoSkip={(occurrence) => undoSkip(t, occurrence)}
                onEdit={() => onEdit(t)}
                onToggle={() => toggle(t)}
                onDelete={() => setDeleting(t)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {deleting && (
        <ConfirmDelete
          title={`Delete ${deleting.name}?`}
          body="The reminder is removed for good. Transactions you recorded from it stay. If it has any, stop it instead."
          path={`/recurring/${deleting.id}`}
          onClose={() => setDeleting(null)}
          onDone={(message) => {
            onNotice(message);
            setDeleting(null);
            onChanged();
          }}
        />
      )}
    </>
  );
}

function TemplateRow({
  template: t,
  toggling,
  undoing,
  onUndoSkip,
  onEdit,
  onToggle,
  onDelete,
}: {
  template: Template;
  toggling: boolean;
  undoing: string | null;
  onUndoSkip: (occurrence: string) => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const accounts = t.type === "transfer" ? `${t.account_name} → ${t.to_account_name}` : t.account_name;
  const details = [TYPE_LABEL[t.type], scheduleText(t), accounts, t.category];
  const toggleText = toggleLabel(t);
  return (
    <tr>
      <td className={`${TD} min-w-40 [overflow-wrap:anywhere]`}>
        <span className="block">
          {t.name}
          {t.policy_id !== null && (
            <>
              {" "}
              <Link href="/insurance" className={`rounded text-xs font-bold text-zinc-600 underline ${FOCUS}`}>
                insurance policy
              </Link>
            </>
          )}
        </span>
        <span className="block text-xs font-bold text-zinc-600">{details.filter(Boolean).join(" · ")}</span>
        <span className={`block text-xs font-extrabold ${t.active ? "" : "text-zinc-600"}`}>{nextText(t)}</span>
        {t.skipped.length > 0 && (
          <ul aria-label={`Skipped dates for ${t.name}`} className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-zinc-600">
            <li>Skipped:</li>
            {t.skipped.map((occurrence) => (
              <li key={occurrence} className="flex items-center gap-1">
                {formatFullDate(occurrence)}
                <button
                  type="button"
                  className={ROW_ACTION}
                  aria-label={`Undo skipping ${t.name} on ${formatFullDate(occurrence)}`}
                  disabled={undoing === `${t.id}-${occurrence}`}
                  onClick={() => onUndoSkip(occurrence)}
                >
                  {undoing === `${t.id}-${occurrence}` ? "Undoing..." : "Undo"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className={`${TD_NUM} whitespace-nowrap`}>{whole(t.amount)}</td>
      <td className={`${TD} w-px`}>
        <div className="flex min-w-[8.5rem] flex-wrap justify-end gap-1.5">
          <button type="button" className={ROW_ACTION} aria-label={`Edit ${t.name}`} onClick={onEdit}>
            Edit
          </button>
          {toggleText && (
            <button type="button" className={ROW_ACTION} aria-label={`${toggleText} ${t.name}`} disabled={toggling} onClick={onToggle}>
              {toggleText}
            </button>
          )}
          {t.policy_id === null && (
            <button type="button" className={ROW_ACTION} aria-label={`Delete ${t.name}`} onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
