"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, formatDueDate, formatFullDate } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import { ConfirmDelete, LIST, Notice, PRIMARY, QUIET, ROW_ACTION, isUnauthorized } from "@/components/investments/shared";
import { type Template, scheduleText, toggleLabel, whole } from "@/lib/recurring";

import { DueSection } from "./due-list";
import { TemplateDialog } from "./template-dialog";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; templates: Template[] };
type Dialog = { kind: "none" } | { kind: "form"; template: Template | null } | { kind: "delete"; template: Template };

const TYPE_LABEL = { expense: "Expense", income: "Income", transfer: "Transfer" } as const;

// "Due since 1 Mar", "Next: 6 Apr", or why there is nothing to show.
function nextText(t: Template): string {
  if (!t.active) return "Stopped";
  if (t.due.length > 0) return `Due since ${formatDueDate(t.due[0])}`;
  if (t.coming_up) return `Coming up on ${formatDueDate(t.coming_up)}`;
  if (t.end_date) return `Ends ${formatFullDate(t.end_date)}`;
  return "Nothing due yet";
}

export function RecurringView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);
  const [dueKey, setDueKey] = useState(0);
  const [toggling, setToggling] = useState<number | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const latest = useRef(0);
  const busy = useRef(false);

  const fetchTemplates = useCallback(() => {
    const request = ++latest.current;
    apiFetch<{ templates: Template[] }>("/recurring")
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", templates: data.templates });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const reload = useCallback(() => {
    fetchTemplates();
    setDueKey((k) => k + 1);
  }, [fetchTemplates]);
  const closeDialog = () => setDialog({ kind: "none" });

  async function toggle(t: Template) {
    if (busy.current) return;
    busy.current = true;
    setToggling(t.id);
    setNotice(null);
    try {
      await apiFetch(`/recurring/${t.id}`, { method: "PATCH", body: JSON.stringify({ active: !t.active }) });
      reload();
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else setNotice(errorMessage(err));
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
    setNotice(null);
    try {
      await apiFetch(`/recurring/${t.id}/skip/${occurrence}`, { method: "DELETE" });
      reload();
    } catch (err) {
      if (isUnauthorized(err)) void logout();
      else {
        setNotice(errorMessage(err));
        reload();
      }
    } finally {
      busy.current = false;
      setUndoing(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-semibold">Recurring</h1>
        <button type="button" className={PRIMARY} onClick={() => setDialog({ kind: "form", template: null })}>
          Add reminder
        </button>
      </div>

      <Notice message={notice} />
      <DueSection refreshKey={dueKey} onChanged={reload} />

      {load.status === "loading" && (
        <p role="status" className="text-sm text-zinc-500 dark:text-zinc-400">
          Loading your reminders...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <p>We couldn&apos;t load your reminders.</p>
          <button
            type="button"
            className={`${QUIET} mt-2 -ml-3`}
            onClick={() => {
              setLoad({ status: "loading" });
              fetchTemplates();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {load.status === "ready" &&
        (load.templates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 px-6 py-12 text-center dark:border-zinc-700">
            <p className="font-medium">No reminders yet</p>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Add rent, a salary or any regular payment, and it will show up here when it&apos;s due. Nothing is recorded until you do it.
            </p>
          </div>
        ) : (
          <ul className={LIST}>
            {load.templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                toggling={toggling === t.id}
                undoing={undoing}
                onUndoSkip={(occurrence) => undoSkip(t, occurrence)}
                onEdit={() => setDialog({ kind: "form", template: t })}
                onToggle={() => toggle(t)}
                onDelete={() => setDialog({ kind: "delete", template: t })}
              />
            ))}
          </ul>
        ))}

      {dialog.kind === "form" && (
        <TemplateDialog
          key={dialog.template?.id ?? "new"}
          template={dialog.template}
          frequency="monthly"
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

      {dialog.kind === "delete" && (
        <ConfirmDelete
          title={`Delete ${dialog.template.name}?`}
          body="The reminder is removed for good. Transactions you recorded from it stay. If it has any, stop it instead."
          path={`/recurring/${dialog.template.id}`}
          onClose={closeDialog}
          onDone={(message) => {
            setNotice(message);
            closeDialog();
            reload();
          }}
        />
      )}
    </div>
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
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-40 flex-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">
          {t.name}
          {t.policy_id !== null && (
            <>
              {" "}
              <Link href="/insurance" className="text-xs font-normal text-zinc-500 underline dark:text-zinc-400">
                insurance policy
              </Link>
            </>
          )}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 [overflow-wrap:anywhere]">{details.filter(Boolean).join(" · ")}</p>
        <p className={`text-xs ${t.active ? "" : "text-zinc-500 dark:text-zinc-400"}`}>{nextText(t)}</p>
        {t.skipped.length > 0 && (
          <ul aria-label={`Skipped dates for ${t.name}`} className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
            <li>Skipped:</li>
            {t.skipped.map((occurrence) => (
              <li key={occurrence} className="flex items-center gap-0.5">
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
      </div>
      <p className="min-w-0 max-w-full text-right text-sm font-medium tabular-nums [overflow-wrap:anywhere]">{whole(t.amount)}</p>
      <div className="flex shrink-0 justify-end gap-1">
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
    </li>
  );
}
