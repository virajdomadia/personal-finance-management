"use client";

import Link from "next/link";
import { type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode, useRef } from "react";

import { STACK_COLORS } from "@/lib/fun";

// The focus ring: ink, with a cream gap so it shows on every fill.
export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export type Tone = "card" | "green" | "yellow" | "pink" | "blue" | "purple" | "orange" | "due";

// Tiles that carry white text use the deeper shades (5.1:1 or better); yellow and due carry ink.
const TONE: Record<Tone, string> = {
  card: "bg-card text-ink",
  green: "bg-green-strong text-white",
  yellow: "bg-yellow text-ink",
  pink: "bg-pink-strong text-white",
  blue: "bg-blue-strong text-white",
  purple: "bg-purple-strong text-white",
  orange: "bg-orange-strong text-white",
  due: "bg-due text-ink",
};

export function Sticker({ text }: { text: string }) {
  return (
    <span className="absolute -top-3.5 right-4 z-10 flex size-[58px] rotate-12 items-center justify-center rounded-full border-[2.5px] border-ink bg-yellow p-1 text-center text-xs leading-none font-black text-ink">
      {text}
    </span>
  );
}

export function Tile({
  tone = "card",
  emoji,
  label,
  value,
  size = "md",
  sticker,
  href,
  children,
}: {
  tone?: Tone;
  emoji?: string;
  label: string;
  value?: ReactNode;
  size?: "md" | "huge";
  sticker?: string | null;
  href?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      {sticker ? <Sticker text={sticker} /> : null}
      <span className="block min-w-0 text-xs font-extrabold break-words">
        {emoji ? <span aria-hidden="true">{emoji} </span> : null}
        {label}
      </span>
      {value !== undefined && value !== null ? (
        <span
          className={`mt-0.5 block font-black tabular-nums break-words ${sticker ? "pr-[4.75rem]" : ""} ${size === "huge" ? "text-[clamp(1.5rem,3vw,2.25rem)] leading-tight tracking-tight" : "text-[22px] leading-tight"}`}
        >
          {value}
        </span>
      ) : null}
      {children}
    </>
  );
  const cls = `relative block min-w-0 rounded-[18px] border-[2.5px] border-ink p-3.5 shadow-chunky ${TONE[tone]}`;
  if (href) {
    return (
      <Link
        href={href}
        className={`${cls} hover:brightness-95 ${FOCUS} motion-safe:transition motion-safe:active:translate-y-1 motion-safe:active:shadow-none`}
      >
        {body}
      </Link>
    );
  }
  return <div className={cls}>{body}</div>;
}

const BUTTON_BASE = `inline-block rounded-[14px] border-[2.5px] border-ink px-3.5 py-2.5 text-center text-xs font-black tracking-wide shadow-chunky disabled:opacity-60 disabled:shadow-none chunky-press ${FOCUS}`;
const BUTTON: Record<"primary" | "alt" | "green" | "pink", string> = {
  primary: "bg-ink text-white",
  alt: "bg-card text-ink",
  green: "bg-green-strong text-white",
  pink: "bg-pink-strong text-white",
};

export function buttonClass(variant: "primary" | "alt" | "green" | "pink"): string {
  return `${BUTTON_BASE} ${BUTTON[variant]}`;
}

export function Chip({
  selected,
  children,
  className = "",
  ...rest
}: { selected: boolean; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      {...rest}
      className={`rounded-full border-[2.5px] border-ink px-3 py-1.5 text-xs font-extrabold shadow-chunky-sm disabled:opacity-60 chunky-press ${selected ? "bg-ink text-white" : "bg-card text-ink hover:bg-yellow"} ${FOCUS} ${className}`}
    >
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const last = options.length - 1;
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") next = selected < 0 || selected === last ? 0 : selected + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = selected <= 0 ? last : selected - 1;
    else return;
    e.preventDefault();
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="inline-flex max-w-full overflow-hidden rounded-[14px] border-[2.5px] border-ink bg-card shadow-chunky-sm"
    >
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={`px-4 py-1.5 text-xs font-black ${i > 0 ? "border-l-2 border-ink" : ""} ${on ? "bg-yellow text-ink" : "bg-card text-ink hover:bg-due"} focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ink`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function StackedBar({ items, label }: { items: { label: string; value: number }[]; label: string }) {
  const shown = items.filter((i) => i.value > 0);
  const total = shown.reduce((sum, i) => sum + i.value, 0);
  if (!(total > 0)) return null;
  const parts = shown.map((item, i) => ({
    ...item,
    percent: (item.value / total) * 100,
    color: STACK_COLORS[i % STACK_COLORS.length],
  }));
  const spoken = parts.map((p) => `${p.label} ${Math.round(p.percent)}%`).join(", ");
  return (
    <div>
      <div
        role="img"
        aria-label={`${label}: ${spoken}`}
        className="mt-2 flex h-4 overflow-hidden rounded-full border-[2.5px] border-ink bg-card"
      >
        {parts.map((p, i) => (
          <i
            key={p.label}
            className={`block h-full ${i > 0 ? "border-l-2 border-ink" : ""}`}
            style={{ width: `${p.percent}%`, background: p.color }}
          />
        ))}
      </div>
      <ul aria-hidden="true" className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs font-extrabold">
        {parts.map((p) => (
          <li key={p.label} className="flex min-w-0 items-center">
            <span
              className="mr-1.5 inline-block size-2.5 shrink-0 rounded-[3px] border-2 border-ink"
              style={{ background: p.color }}
            />
            <span className="break-words">
              {p.label} {Math.round(p.percent)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Saved against the target. The bar stops at full; the text beside it says when a goal is past 100%.
export function ProgressBar({
  percent,
  reached,
  label,
  className = "",
  warn = false,
}: {
  percent: number | null;
  reached: boolean;
  label: string;
  className?: string;
  warn?: boolean; // a pink fill, for a bar that is filling up in a bad way
}) {
  const value = Math.round(percent ?? 0);
  const width = Math.max(0, Math.min(value, 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={width}
      aria-valuetext={reached ? `${value}%, reached` : `${value}%`}
      className={`h-4 w-full overflow-hidden rounded-full border-[2.5px] border-ink bg-zinc-200 ${className}`}
    >
      <div
        className={`h-full ${width > 0 && width < 100 ? "border-r-2 border-ink" : ""} ${warn ? "bg-pink-strong" : reached ? "bg-green-strong" : "bg-green"}`}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

// A round progress dial, like ProgressBar but for the goal tiles.
export function Ring({
  percent,
  reached,
  label,
  size = 110,
}: {
  percent: number | null;
  reached: boolean;
  label: string;
  size?: number;
}) {
  const value = Math.round(percent ?? 0);
  const width = Math.max(0, Math.min(value, 100));
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={width}
      aria-valuetext={percent === null ? "No target" : reached ? `${value}%, reached` : `${value}%`}
      className="relative shrink-0 rounded-full drop-shadow-[0_4px_0_#1a1a1a]"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden="true">
        <circle cx="50" cy="50" r="47" fill="#fff" stroke="#1a1a1a" strokeWidth="3" />
        <circle cx="50" cy="50" r={radius} fill="none" stroke="#e6e2d6" strokeWidth="11" />
        {width > 0 ? (
          <circle
            cx="50"
            cy="50"
            r={radius}
            fill="none"
            stroke={reached ? "#2f7d00" : "#58cc02"}
            strokeWidth="11"
            strokeDasharray={`${(width / 100) * circumference} ${circumference}`}
            transform="rotate(-90 50 50)"
          />
        ) : null}
        <circle cx="50" cy="50" r="41.5" fill="none" stroke="#1a1a1a" strokeWidth="2.5" />
        <circle cx="50" cy="50" r="30.5" fill="#fff" stroke="#1a1a1a" strokeWidth="2.5" />
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center font-black text-ink tabular-nums"
        style={{ fontSize: Math.max(11, size * 0.18) }}
      >
        {percent === null ? "–" : `${value}%`}
      </span>
    </div>
  );
}

const SQUARE: Record<Tone, string> = {
  card: "bg-card",
  green: "bg-green",
  yellow: "bg-yellow",
  pink: "bg-pink",
  blue: "bg-blue",
  purple: "bg-purple",
  orange: "bg-orange",
  due: "bg-due",
};

// A small emoji tile; the emoji is decoration, so it is hidden from screen readers.
export function EmojiSquare({ emoji, tone }: { emoji: string; tone: Tone }) {
  return (
    <span
      aria-hidden="true"
      className={`mr-2 inline-flex size-7 shrink-0 items-center justify-center rounded-[9px] border-[2.5px] border-ink align-middle text-sm ${SQUARE[tone]}`}
    >
      {emoji}
    </span>
  );
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="min-w-0 text-2xl font-black break-words">{title}</h1>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  );
}

// Class strings for a table: put TABLE on the table inside an overflow-x-auto wrapper.
export const TABLE =
  "w-full border-separate border-spacing-0 overflow-hidden rounded-[18px] border-[2.5px] border-ink bg-card text-sm shadow-chunky";
export const TH =
  "border-b-[2.5px] border-ink bg-yellow px-3 py-2 text-left text-[11px] font-black tracking-wider uppercase";
export const TD = "border-b-[1.5px] border-zinc-200 px-3 py-2 font-bold";
export const TD_NUM = `${TD} text-right tabular-nums`;
