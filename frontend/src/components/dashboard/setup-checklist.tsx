"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";
import {
  type ChecklistStep,
  type Mode,
  SETUP_KEY,
  type ServerStep,
  type SetupResponse,
  type SetupState,
  checklistSteps,
  parseSetupState,
  progressOf,
  progressText,
  shownAs,
  statusText,
  stepEmoji,
  withNone,
} from "@/lib/setup";
import { ProgressBar, buttonClass } from "@/components/ui/chunky";

const SMALL = "!px-2.5 !py-1 uppercase";

function readState(): SetupState {
  try {
    return parseSetupState(window.localStorage.getItem(SETUP_KEY));
  } catch {
    return parseSetupState(null);
  }
}

function saveState(state: SetupState): void {
  try {
    window.localStorage.setItem(SETUP_KEY, JSON.stringify(state));
  } catch {
    // Not remembered on this browser, then; the change still shows until the page reloads.
  }
}

// The new-user checklist at the top of the dashboard. It loads its own data and reloads when the
// tab comes back into focus, so a step ticks off after the user adds something on another page.
// `fallback` shows instead whenever the checklist doesn't (hidden, finished or failed to load).
export function SetupChecklist({ fallback = null }: { fallback?: ReactNode }) {
  const [server, setServer] = useState<ServerStep[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [state, setState] = useState<SetupState>(() => parseSetupState(null));
  const latest = useRef(0);

  const load = useCallback(() => {
    const request = ++latest.current;
    apiFetch<SetupResponse>("/setup")
      .then((data) => {
        if (request !== latest.current) return;
        setState(readState());
        setServer(data.steps);
        setFailed(false);
      })
      .catch(() => {
        // The dashboard itself deals with a signed-out user; here the checklist just stays away.
        if (request === latest.current) setFailed(true);
      });
  }, []);

  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const update = (next: SetupState) => {
    saveState(next);
    setState(next);
  };
  const setMode = (mode: Mode) => update({ ...state, mode });

  if (server === null) return failed ? <>{fallback}</> : null;
  const steps = checklistSteps(server, state.none);
  const shown = shownAs(steps, state.mode);
  if (shown === "nothing") return <>{fallback}</>;

  if (shown === "later") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border-[2.5px] border-ink bg-due px-4 py-2 shadow-chunky-sm">
        <p className="min-w-0 text-sm font-extrabold">
          <span aria-hidden="true">🧭 </span>
          Finish setting up · {progressText(steps)}
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${buttonClass("primary")} ${SMALL}`} onClick={() => setMode("open")}>
            Resume
          </button>
          <button type="button" className={`${buttonClass("alt")} ${SMALL}`} onClick={() => setMode("hidden")}>
            Don&apos;t show again
          </button>
        </div>
      </div>
    );
  }

  const { finished, total } = progressOf(steps);
  return (
    <section
      aria-labelledby="setup-title"
      className="rounded-[18px] border-[2.5px] border-ink bg-card p-5 shadow-chunky"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="setup-title" className="text-xl font-black">
            <span aria-hidden="true">🐷 </span>Let&apos;s set up your Gullak
          </h2>
          <p className="mt-1 text-sm font-bold text-zinc-600">
            A few minutes now and your dashboard fills itself in. Go in any order, and skip what
            you don&apos;t have.
          </p>
        </div>
        <button type="button" className={`${buttonClass("alt")} ${SMALL}`} onClick={() => setMode("later")}>
          Skip for now
        </button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <ProgressBar
          percent={(finished / total) * 100}
          reached={false}
          label="Setup progress"
          className="flex-1"
        />
        <span className="shrink-0 text-sm font-black tabular-nums">{progressText(steps)}</span>
      </div>

      <ol className="mt-3">
        {steps.map((step, i) => (
          <StepRow
            key={step.key}
            step={step}
            number={i + 1}
            onNone={(on) => update(withNone(state, step.key, on))}
          />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  number,
  onNone,
}: {
  step: ChecklistStep;
  number: number;
  onNone: (on: boolean) => void;
}) {
  const done = step.status === "done";
  const none = step.status === "none";
  const marker = done ? "✓" : none ? "–" : String(number);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b-[1.5px] border-dashed border-zinc-300 py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full border-[2.5px] border-ink text-sm font-black ${done ? "bg-green-strong text-white" : none ? "bg-zinc-200 text-zinc-600" : "bg-yellow text-ink"}`}
      >
        {marker}
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className={`font-black ${none ? "text-zinc-600 line-through" : ""}`}>
          <span aria-hidden="true">{stepEmoji(step.key)} </span>
          {step.title}
          <span className="sr-only">{done ? ", done" : none ? ", skipped" : ", to do"}</span>
        </p>
        <p className="text-xs font-bold text-zinc-600">{statusText(step)}</p>
      </div>
      {step.status === "todo" && (
        <div className="flex flex-wrap gap-2">
          {step.canSkip && (
            <button type="button" className={`${buttonClass("alt")} ${SMALL}`} onClick={() => onNone(true)}>
              Not for me
            </button>
          )}
          <Link href={step.href} className={`${buttonClass("primary")} ${SMALL}`}>
            Add<span className="sr-only"> {step.title.toLowerCase()}</span>
          </Link>
        </div>
      )}
      {none && (
        <button type="button" className={`${buttonClass("alt")} ${SMALL}`} onClick={() => onNone(false)}>
          Undo<span className="sr-only"> skipping {step.title.toLowerCase()}</span>
        </button>
      )}
    </li>
  );
}
