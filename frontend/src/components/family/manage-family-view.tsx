"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Family, type Person, HOW_IT_WORKS, confirmMatches, removeBody } from "@/lib/family";
import { useProfile } from "@/components/family/profile";
import { DIALOG, INPUT, LIST, Notice, PRIMARY, QUIET, ROW_ACTION, SECONDARY, SELL, isUnauthorized } from "@/components/investments/shared";
import { PageHeader } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";

const MAX_MEMBERS = 10;

// A failed save, split into the message beside the field and the one above the page. A 422 carries
// field messages in `detail[]`; a 404 or 409 one sentence in `detail`.
function failure(err: unknown, field: string): { field: string | null; general: string | null } {
  if (err instanceof ApiError && err.status === 422) {
    const { fields, general } = splitErrors(err.body, [field]);
    return { field: fields[field] ?? null, general: general.length > 0 ? general.join(" ") : null };
  }
  return { field: null, general: errorMessage(err) };
}

export function ManageFamilyView() {
  const { family, familyStatus, reloadFamily, setFamily, member: viewed, switchTo } = useProfile();
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Person | null>(null);

  const onError = (err: unknown) => {
    if (isUnauthorized(err)) void logout();
  };

  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Manage family"
        action={
          <Link href="/family" className={SECONDARY}>
            Family portfolio
          </Link>
        }
      />
      <p className="mb-5 text-sm font-bold text-zinc-600">{HOW_IT_WORKS}</p>
      <Notice message={notice} />

      {familyStatus === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your family...
        </p>
      )}
      {familyStatus === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load your family.</p>
          <button type="button" className={`${QUIET} mt-2`} onClick={reloadFamily}>
            Try again
          </button>
        </div>
      )}

      {family && (
        <div className="flex flex-col gap-6">
          <AddMember
            full={family.members.length >= MAX_MEMBERS}
            onAdded={() => {
              setNotice(null);
              reloadFamily();
            }}
            onError={onError}
          />
          <section aria-labelledby="members-title">
            <h2 id="members-title" className="mb-2 px-1 text-xs font-black tracking-wider uppercase">
              Family members ({family.members.length} of {MAX_MEMBERS})
            </h2>
            {family.members.length === 0 ? (
              <EmptyState emoji="👨‍👩‍👧" title="No family members yet" heading="p">
                Add someone above to start a profile for them.
              </EmptyState>
            ) : (
              <ul className={LIST}>
                {family.members.map((m) => (
                  <MemberRow
                    key={m.id}
                    member={m}
                    viewing={viewed?.id === m.id}
                    onRenamed={reloadFamily}
                    onSwitch={() => switchTo(m.id)}
                    onRemove={() => {
                      setNotice(null);
                      setRemoving(m);
                    }}
                    onError={onError}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {removing && (
        <RemoveDialog
          member={removing}
          onClose={() => setRemoving(null)}
          onRemoved={(next) => {
            setRemoving(null);
            // The profile on screen is gone: start over as the owner.
            if (viewed?.id === removing.id) switchTo(null);
            else setFamily(next);
          }}
          onGone={(message) => {
            setRemoving(null);
            setNotice(message);
            reloadFamily();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

function AddMember({ full, onAdded, onError }: { full: boolean; onAdded: () => void; onError: (err: unknown) => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field: string | null; general: string | null }>({ field: null, general: null });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await apiFetch<Person>("/family/members", { method: "POST", body: JSON.stringify({ name }) });
      setName("");
      setError({ field: null, general: null });
      onAdded();
    } catch (err) {
      onError(err);
      setError(failure(err, "name"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky">
      <label htmlFor={`${id}-name`} className="mb-1.5 block text-xs font-black tracking-wider uppercase">
        Add a family member
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          placeholder="Papa, Maa, Riya..."
          autoComplete="off"
          disabled={full}
          aria-invalid={error.field ? true : undefined}
          aria-describedby={error.field ? `${id}-error` : full ? `${id}-full` : undefined}
          className={`${INPUT} min-w-0 flex-1 basis-48`}
        />
        <button type="submit" className={PRIMARY} disabled={saving || full}>
          {saving ? "Adding..." : "Add"}
        </button>
      </div>
      {error.field && (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-extrabold text-loss">
          {error.field}
        </p>
      )}
      {error.general && (
        <p role="alert" className="mt-1.5 text-xs font-extrabold text-loss">
          {error.general}
        </p>
      )}
      {full && (
        <p id={`${id}-full`} className="mt-1.5 text-xs font-bold text-zinc-600">
          You have the most family members you can have ({MAX_MEMBERS}).
        </p>
      )}
    </form>
  );
}

function MemberRow({
  member,
  viewing,
  onRenamed,
  onSwitch,
  onRemove,
  onError,
}: {
  member: Person;
  viewing: boolean;
  onRenamed: () => void;
  onSwitch: () => void;
  onRemove: () => void;
  onError: (err: unknown) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(member.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ field: string | null; general: string | null }>({ field: null, general: null });
  const input = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  function stop() {
    setEditing(false);
    setName(member.name);
    setError({ field: null, general: null });
    // Back to the button that opened it, once it is rendered again.
    requestAnimationFrame(() => renameButton.current?.focus());
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (name.trim() === member.name) {
      stop();
      return;
    }
    setSaving(true);
    try {
      await apiFetch<Person>(`/family/members/${member.id}`, { method: "PATCH", body: JSON.stringify({ name }) });
      setEditing(false);
      setError({ field: null, general: null });
      onRenamed();
    } catch (err) {
      onError(err);
      setError(failure(err, "name"));
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <li className="px-4 py-3">
        <form onSubmit={save} noValidate>
          <label htmlFor={`${id}-name`} className="sr-only">
            New name for {member.name}
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              ref={input}
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  stop();
                }
              }}
              maxLength={40}
              autoComplete="off"
              aria-invalid={error.field ? true : undefined}
              aria-describedby={error.field ? `${id}-error` : undefined}
              className={`${INPUT} min-w-0 flex-1 basis-40`}
            />
            <button type="submit" className={ROW_ACTION} disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
            <button type="button" className={ROW_ACTION} disabled={saving} onClick={stop}>
              Cancel
            </button>
          </div>
          {error.field && (
            <p id={`${id}-error`} className="mt-1.5 text-xs font-extrabold text-loss">
              {error.field}
            </p>
          )}
          {error.general && (
            <p role="alert" className="mt-1.5 text-xs font-extrabold text-loss">
              {error.general}
            </p>
          )}
        </form>
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <p className="min-w-24 flex-1 text-sm font-extrabold [overflow-wrap:anywhere]">
        {member.name}
        {viewing && (
          <span className="ml-2 rounded-full border-[1.5px] border-ink bg-purple-strong px-2 py-px text-[11px] font-black text-white">
            viewing
          </span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {!viewing && (
          <button type="button" className={ROW_ACTION} onClick={onSwitch}>
            Switch to<span className="sr-only"> {member.name}</span>
          </button>
        )}
        <button ref={renameButton} type="button" className={ROW_ACTION} onClick={() => {
            setName(member.name);
            setEditing(true);
          }}
        >
          Rename<span className="sr-only"> {member.name}</span>
        </button>
        <button type="button" className={`${ROW_ACTION} !bg-pink-strong !text-white`} onClick={onRemove}>
          Remove<span className="sr-only"> {member.name}</span>
        </button>
      </div>
    </li>
  );
}

function RemoveDialog({
  member,
  onClose,
  onRemoved,
  onGone,
  onError,
}: {
  member: Person;
  onClose: () => void;
  onRemoved: (family: Family) => void;
  onGone: (message: string) => void;
  onError: (err: unknown) => void;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = confirmMatches(typed, member.name);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function remove(e: FormEvent) {
    e.preventDefault();
    if (saving || !matches) return;
    setSaving(true);
    try {
      const next = await apiFetch<Family>(
        `/family/members/${member.id}?confirm=${encodeURIComponent(typed.trim())}`,
        { method: "DELETE" },
      );
      onRemoved(next);
    } catch (err) {
      onError(err);
      if (err instanceof ApiError && err.status === 404) onGone(errorMessage(err));
      else {
        const { field, general } = failure(err, "confirm");
        setError(field ?? general);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(28rem,calc(100vw-2rem))]`}
    >
      <form onSubmit={remove} noValidate>
        <h2 id={`${id}-title`} className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black [overflow-wrap:anywhere]">
          Remove {member.name}?
        </h2>
        <div className="px-5 py-4">
          <p id={`${id}-body`} className="text-sm font-bold text-zinc-700">
            {removeBody(member.name)}
          </p>
          <label htmlFor={`${id}-confirm`} className="mt-4 mb-1.5 block text-xs font-black [overflow-wrap:anywhere]">
            Type <span className="rounded bg-due px-1">{member.name}</span> to confirm
          </label>
          <input
            id={`${id}-confirm`}
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className={INPUT}
          />
          {error && (
            <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs font-extrabold text-loss">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
          <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className={SELL} disabled={saving || !matches}>
            {saving ? "Removing..." : "Remove for good"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
