"use client";

import { useEffect, useId, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { errorMessage, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type MarketKind,
  type MarketMatch,
  NO_MATCH,
  canSearchMarket,
  linkLabel,
  marketSearchPath,
  selectedLabel,
} from "@/lib/investments";

import { DIALOG, INPUT, PRIMARY, QUIET, ROW_ACTION } from "./shared";

const DEBOUNCE_MS = 300;

const PLACEHOLDER: Record<MarketKind, string> = {
  stock: "Search NSE stocks, like Infosys",
  mutual_fund: "Search funds, like Parag Parikh",
  crypto: "Search coins, like Bitcoin",
};

// The outcome of the search for `text`; it is stale (and the box says "Searching...") until the
// text it was run for matches what is typed.
type Outcome = { text: string; results: MarketMatch[]; message: string | null };

// A search box for the market's codes: type, pick a match. `selected` is the pick (or null), and it
// shows as "Selected: NAME" (it is saved only by the form around it) with a way to clear it. Arrow keys move through the matches, and Enter
// picks the first one (it never submits the form around it).
export function MarketSearch({
  kind,
  selected,
  onSelect,
  disabled = false,
  label = "Search live prices",
}: {
  kind: MarketKind;
  selected: MarketMatch | null;
  onSelect: (match: MarketMatch | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const latest = useRef(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const request = ++latest.current;
    if (!canSearchMarket(text)) return;
    const timer = setTimeout(() => {
      apiFetch<{ results: MarketMatch[] }>(marketSearchPath(kind, text))
        .then((res) => {
          if (request === latest.current) setOutcome({ text, results: res.results, message: null });
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) void logout();
          else if (request === latest.current) setOutcome({ text, results: [], message: errorMessage(err) });
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, kind]);

  const pick = (match: MarketMatch) => {
    latest.current++;
    setText("");
    onSelect(match);
  };
  const searching = canSearchMarket(text);
  const current = searching && outcome?.text === text ? outcome : null;
  const results = current?.results ?? [];
  const buttons = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);

  if (selected) {
    return (
      <div className="flex items-center gap-2 rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2">
        <p className="min-w-0 flex-1 text-sm font-extrabold [overflow-wrap:anywhere]">
          {selectedLabel(selected.name)}
          <span className="block text-xs font-bold text-zinc-600">{selected.code}</span>
        </p>
        <button type="button" className={ROW_ACTION} disabled={disabled} onClick={() => onSelect(null)}>
          Clear
        </button>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor={`${id}-q`} className="sr-only">
        {label}
      </label>
      <input
        id={`${id}-q`}
        type="text"
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        autoComplete="off"
        maxLength={60}
        disabled={disabled}
        value={text}
        placeholder={PLACEHOLDER[kind]}
        className={INPUT}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            buttons()[0]?.focus();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (results[0]) pick(results[0]);
          }
        }}
      />
      <div aria-live="polite">
        {searching && !current && <p className="mt-1 text-xs font-bold text-zinc-600">Searching...</p>}
        {current?.message && <p className="mt-1 text-xs font-extrabold text-loss">{current.message}</p>}
        {current && !current.message && results.length === 0 && (
          <p className="mt-1 text-xs font-bold text-zinc-700">{NO_MATCH[kind]}</p>
        )}
      </div>
      {results.length > 0 && (
        <ul
          ref={list}
          id={`${id}-list`}
          aria-label="Matches"
          className="mt-2 max-h-56 overflow-y-auto rounded-[14px] border-[2.5px] border-ink bg-card [&>li]:border-b-[1.5px] [&>li]:border-zinc-200 [&>li:last-child]:border-b-0"
          onKeyDown={(e) => {
            const items = buttons();
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              items[Math.min(at + 1, items.length - 1)]?.focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              if (at <= 0) document.getElementById(`${id}-q`)?.focus();
              else items[at - 1]?.focus();
            }
          }}
        >
          {results.map((match) => (
            <li key={match.code}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => pick(match)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-yellow/40 focus-visible:bg-yellow/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink"
              >
                <span className="block font-extrabold [overflow-wrap:anywhere]">{match.name}</span>
                <span className="block text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">
                  {match.code}
                  {match.price ? ` · ₹${match.price}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Links one holding to a market code, or unlinks it. `path` is the holding's own endpoint, like
// /investments/funds/3, which takes source_code on PATCH.
export function LinkDialog({
  kind,
  path,
  title,
  linkedCode,
  onClose,
  onSaved,
  onConflict,
}: {
  kind: MarketKind;
  path: string;
  title: string;
  linkedCode: string | null;
  onClose: () => void;
  onSaved: () => void;
  onConflict: (message: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const savingRef = useRef(false);
  const [pick, setPick] = useState<MarketMatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  async function save(code: string | null) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(path, { method: "PATCH", body: JSON.stringify({ source_code: code }) });
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logout();
      } else if (err instanceof ApiError && err.status === 422) {
        const { fields, general } = splitErrors(err.body, ["source_code"]);
        setError([fields.source_code, ...general].filter(Boolean).join(" "));
      } else if (err instanceof ApiError && err.status === 404) {
        onConflict(errorMessage(err));
      } else {
        setError(errorMessage(err));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby="link-dialog-title"
      onCancel={(e) => {
        if (saving) e.preventDefault();
      }}
      onClose={onClose}
      className={`${DIALOG} w-[min(28rem,calc(100vw-2rem))]`}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (pick) void save(pick.code);
        }}
        noValidate
      >
        <h2 id="link-dialog-title" className="border-b-[2.5px] border-ink bg-yellow px-5 py-3 text-lg font-black [overflow-wrap:anywhere]">
          {title}
        </h2>
        <div className="flex flex-col gap-3 px-5 py-4">
          {linkedCode && !pick && (
            <p className="text-sm font-bold text-zinc-700">
              {linkLabel(linkedCode)}. Its price updates every night. Pick another match to change it.
            </p>
          )}
          <MarketSearch kind={kind} selected={pick} onSelect={setPick} disabled={saving} />
          {error ? (
            <p role="alert" className="text-sm font-extrabold text-loss">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t-[2.5px] border-ink bg-bg px-5 py-3">
          {linkedCode && (
            <button type="button" className={`${QUIET} mr-auto`} disabled={saving} onClick={() => void save(null)}>
              Unlink
            </button>
          )}
          <button type="button" className={QUIET} disabled={saving} onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className={PRIMARY} disabled={saving || !pick}>
            {saving ? "Saving..." : "Link"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

// The optional "link to live prices" part of a new-holding form.
export function LinkField({
  kind,
  selected,
  onSelect,
  disabled,
}: {
  kind: MarketKind;
  selected: MarketMatch | null;
  onSelect: (match: MarketMatch | null) => void;
  disabled: boolean;
}) {
  return (
    <div role="group" aria-labelledby="link-field-title">
      <p id="link-field-title" className="mb-1 text-xs font-black tracking-wide uppercase">
        Live prices (optional)
      </p>
      <MarketSearch kind={kind} selected={selected} onSelect={onSelect} disabled={disabled} />
    </div>
  );
}
