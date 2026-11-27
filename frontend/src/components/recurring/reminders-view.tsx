"use client";

import { useCallback, useEffect, useState } from "react";

import { logout } from "@/app/login/actions";
import { ApiError, apiFetch } from "@/lib/api";
import { type Frequency, type Template, type TemplateType, splitTemplates } from "@/lib/recurring";
import { Notice } from "@/components/investments/shared";
import { DueSection } from "@/components/recurring/due-list";
import { ReminderList } from "@/components/recurring/reminder-list";
import { TemplateDialog } from "@/components/recurring/template-dialog";
import { PageHeader, buttonClass } from "@/components/ui/chunky";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; templates: Template[] };
type Dialog =
  | { kind: "none" }
  | { kind: "add"; type: TemplateType; frequency: Frequency }
  | { kind: "edit"; template: Template };
type ListActions = {
  onEdit: (t: Template) => void;
  onChanged: () => void;
  onNotice: (message: string | null) => void;
};

const CARD = "min-w-0 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky";

// Reminders: what's due now to record or skip, and every reminder to add or change.
export function RemindersView({ adding = false }: { adding?: boolean }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [dialog, setDialog] = useState<Dialog>(
    adding ? { kind: "add", type: "expense", frequency: "monthly" } : { kind: "none" },
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let current = true;
    apiFetch<{ templates: Template[] }>("/recurring")
      .then((list) => {
        if (current) setLoad({ status: "ready", templates: list.templates });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (current) setLoad({ status: "error" });
      });
    return () => {
      current = false;
    };
  }, [version]);

  // Opened from the checklist: drop `?add=` so a reload doesn't open the dialog again.
  useEffect(() => {
    if (adding) window.history.replaceState(null, "", "/reminders");
  }, [adding]);

  const closeDialog = () => setDialog({ kind: "none" });
  const add = (type: TemplateType, frequency: Frequency = "monthly") => setDialog({ kind: "add", type, frequency });
  const lists: ListActions = { onEdit: (template) => setDialog({ kind: "edit", template }), onChanged: reload, onNotice: setNotice };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Reminders" />
      <Notice message={notice} />
      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your reminders...
        </p>
      )}
      {load.status === "error" && (
        <p role="alert" className={`${CARD} font-extrabold`}>
          We couldn&apos;t load your reminders. Reload the page to try again.
        </p>
      )}
      {load.status === "ready" && (
        <div className="flex flex-col gap-3.5">
          <DueSection refreshKey={version} onChanged={reload} />
          <Monthly templates={splitTemplates(load.templates).monthly} onAdd={add} {...lists} />
          <Other templates={splitTemplates(load.templates).other} onAdd={add} {...lists} />
        </div>
      )}
      {dialog.kind !== "none" && (
        <TemplateDialog
          key={dialog.kind === "edit" ? dialog.template.id : `new-${dialog.type}-${dialog.frequency}`}
          template={dialog.kind === "edit" ? dialog.template : null}
          frequency={dialog.kind === "add" ? dialog.frequency : "monthly"}
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

function Monthly({
  templates,
  onAdd,
  ...actions
}: { templates: Template[]; onAdd: (type: TemplateType) => void } & ListActions) {
  return (
    <section aria-labelledby="monthly-title" className={CARD}>
      <h2 id="monthly-title" className="text-sm font-black">
        <span aria-hidden="true">🔁 </span>Every month
      </h2>
      <p className="mt-1 text-xs font-bold text-zinc-600">
        {templates.length === 0
          ? "Salary, rent, PPF: add what comes in or goes out every month and you'll be reminded when each one is due."
          : "You'll be reminded when each one is due."}
      </p>
      {templates.length > 0 && (
        <div className="mt-3">
          <ReminderList templates={templates} caption="Your monthly reminders" {...actions} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={buttonClass("green")} onClick={() => onAdd("income")}>
          + Add income
        </button>
        <button type="button" className={buttonClass("pink")} onClick={() => onAdd("expense")}>
          + Add expense
        </button>
      </div>
    </section>
  );
}

function Other({
  templates,
  onAdd,
  ...actions
}: { templates: Template[]; onAdd: (type: TemplateType, frequency?: Frequency) => void } & ListActions) {
  return (
    <section aria-labelledby="other-title" className={CARD}>
      <h2 id="other-title" className="text-sm font-black">
        <span aria-hidden="true">🗂️ </span>Yearly and stopped
      </h2>
      <p className="mt-1 text-xs font-bold text-zinc-600">Yearly payments like insurance premiums, and reminders you&apos;ve stopped.</p>
      {templates.length > 0 ? (
        <div className="mt-3">
          <ReminderList templates={templates} caption="Yearly and stopped reminders" {...actions} />
        </div>
      ) : (
        <p className="mt-2 text-sm font-bold text-zinc-600">None yet.</p>
      )}
      <div className="mt-3">
        <button type="button" className={buttonClass("alt")} onClick={() => onAdd("expense", "yearly")}>
          + Add yearly reminder
        </button>
      </div>
    </section>
  );
}
