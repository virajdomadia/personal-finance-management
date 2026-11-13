"use client";

import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { formatRupees } from "@/lib/accounts";
import {
  type Frame,
  GROUP_COLORS,
  GROUP_LABELS,
  GROUPS,
  type NetWorthPoint,
  type Scale,
  lineSegments,
  longDate,
  monthLabel,
  monthTicks,
  nearestIndex,
  scale,
  shortRupees,
  stackLayers,
  stackTotals,
} from "@/lib/net-worth";

const FRAME: Frame = { width: 720, height: 260, left: 64, right: 16, top: 14, bottom: 30 };
const NARROW = 520;

// The chart is drawn at its box's real width, so the 12px labels stay 12px on a phone.
function useFrame(): [RefObject<HTMLDivElement | null>, Frame] {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FRAME.width);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const narrow = width < NARROW;
  return [box, { ...FRAME, width, height: narrow ? 220 : FRAME.height, left: narrow ? 52 : FRAME.left }];
}
const INK = "#1a1a1a";
const MUTED = "#6b675c";
const GRID = "#e6e2d6";

// Hover, touch or arrow keys pick a point; the tooltip follows it. Focus starts on the latest point.
function ChartShell({
  box,
  frame,
  label,
  xs,
  render,
  tooltip,
}: {
  box: RefObject<HTMLDivElement | null>;
  frame: Frame;
  label: string;
  xs: number[];
  render: (active: number | null) => ReactNode;
  tooltip: (index: number) => ReactNode;
}) {
  const [active, setActive] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const tipId = useId();

  function pick(e: PointerEvent<SVGSVGElement>) {
    const box = svg.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    setActive(nearestIndex(xs, ((e.clientX - box.left) / box.width) * frame.width));
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    const last = xs.length - 1;
    const at = active ?? last;
    let next: number;
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, at - 1);
    else if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(last, at + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") {
      setActive(null);
      return;
    } else return;
    e.preventDefault();
    setActive(next);
  }

  const share = active === null ? 0 : xs[active] / frame.width;
  const shift = share < 0.2 ? "0%" : share > 0.8 ? "-100%" : "-50%";

  return (
    <div ref={box} className="relative">
      <svg
        ref={svg}
        viewBox={`0 0 ${frame.width} ${frame.height}`}
        className="block h-auto w-full touch-pan-y rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
        role="img"
        aria-label={`${label}. Use the left and right arrow keys to read each point.`}
        aria-describedby={active === null ? undefined : tipId}
        tabIndex={0}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(xs.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        {render(active)}
      </svg>
      {active !== null ? (
        <div
          id={tipId}
          role="status"
          className="pointer-events-none absolute top-0 z-10 min-w-40 rounded-[14px] border-[2.5px] border-ink bg-card px-3 py-2 text-xs font-bold shadow-chunky-sm"
          style={{ left: `${share * 100}%`, transform: `translateX(${shift})` }}
        >
          {tooltip(active)}
        </div>
      ) : null}
    </div>
  );
}

function Axes({ s, dates, frame }: { s: Scale; dates: string[]; frame: Frame }) {
  const ticks = monthTicks(dates[0], dates[dates.length - 1], frame.width < NARROW ? 3 : 6);
  return (
    <g aria-hidden="true">
      {s.ticks.map((t) => (
        <g key={t}>
          <line
            x1={frame.left}
            x2={frame.width - frame.right}
            y1={s.y(t)}
            y2={s.y(t)}
            stroke={t === 0 ? MUTED : GRID}
            strokeWidth={t === 0 ? 1.5 : 1}
          />
          <text x={frame.left - 8} y={s.y(t) + 4} textAnchor="end" fontSize="12" fontWeight="800" fill={MUTED}>
            {shortRupees(t)}
          </text>
        </g>
      ))}
      {ticks.map((d) => (
        <text
          key={d}
          x={s.x(d)}
          y={frame.height - 8}
          textAnchor="middle"
          fontSize="12"
          fontWeight="800"
          fill={MUTED}
        >
          {monthLabel(d)}
        </text>
      ))}
    </g>
  );
}

function Cursor({ x, frame }: { x: number; frame: Frame }) {
  return (
    <line
      x1={x}
      x2={x}
      y1={frame.top}
      y2={frame.height - frame.bottom}
      stroke={INK}
      strokeWidth="1.5"
      strokeDasharray="3 3"
      aria-hidden="true"
    />
  );
}

function EstimatedTag() {
  return (
    <span className="mt-1 inline-block rounded-full border-2 border-ink bg-due px-1.5 text-[11px] font-black">
      Estimated
    </span>
  );
}

// The band behind estimated points, so the estimated stretch reads at a glance.
function EstimatedBand({ s, points, frame }: { s: Scale; points: NetWorthPoint[]; frame: Frame }) {
  const estimated = points.filter((p) => p.estimated);
  if (estimated.length === 0) return null;
  const from = s.x(estimated[0].date);
  const to = s.x(estimated[estimated.length - 1].date);
  return (
    <g aria-hidden="true">
      <rect
        x={from - 6}
        y={frame.top}
        width={Math.max(12, to - from + 12)}
        height={frame.height - frame.top - frame.bottom}
        fill="#fff1c2"
        opacity="0.7"
        rx="8"
      />
      <text x={from} y={frame.top + 14} fontSize="11" fontWeight="900" fill={MUTED}>
        ESTIMATED
      </text>
    </g>
  );
}

export function NetWorthLine({ points }: { points: NetWorthPoint[] }) {
  const [box, frame] = useFrame();
  const dates = points.map((p) => p.date);
  const s = scale(dates, points.map((p) => Number(p.net_worth)), frame);
  const xs = dates.map(s.x);
  const segments = lineSegments(points, s);
  const last = points.length - 1;
  const label = `Net worth from ${longDate(dates[0])} to ${longDate(dates[last])}, now ${formatRupees(points[last].net_worth)}`;

  return (
    <ChartShell
      box={box}
      frame={frame}
      label={label}
      xs={xs}
      render={(active) => (
        <>
          <EstimatedBand s={s} points={points} frame={frame} />
          <Axes s={s} dates={dates} frame={frame} />
          {segments.map((seg, i) => (
            <path
              key={i}
              d={seg.path}
              fill="none"
              stroke={seg.estimated ? MUTED : "#2f7d00"}
              strokeWidth={seg.estimated ? 3 : 4}
              strokeDasharray={seg.estimated ? "7 6" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {points.map((p, i) =>
            p.estimated ? (
              <circle key={p.date} cx={xs[i]} cy={s.y(Number(p.net_worth))} r="5" fill="#fff" stroke={MUTED} strokeWidth="2.5" />
            ) : null,
          )}
          <circle cx={xs[last]} cy={s.y(Number(points[last].net_worth))} r="6.5" fill="#58cc02" stroke={INK} strokeWidth="2.5" />
          {active !== null ? (
            <>
              <Cursor x={xs[active]} frame={frame} />
              <circle
                cx={xs[active]}
                cy={s.y(Number(points[active].net_worth))}
                r="7.5"
                fill={points[active].estimated ? "#fff" : "#ffc800"}
                stroke={INK}
                strokeWidth="2.5"
              />
            </>
          ) : null}
        </>
      )}
      tooltip={(i) => {
        const p = points[i];
        return (
          <>
            <span className="block font-black">{longDate(p.date)}</span>
            <span className="block text-sm font-black tabular-nums">{formatRupees(p.net_worth)}</span>
            <span className="block tabular-nums text-zinc-600">
              Have {formatRupees(p.total_have)} · Owe {formatRupees(p.total_owe)}
            </span>
            {p.estimated ? <EstimatedTag /> : null}
          </>
        );
      }}
    />
  );
}

export function AllocationChart({ points }: { points: NetWorthPoint[] }) {
  const [box, frame] = useFrame();
  const dates = points.map((p) => p.date);
  const s = scale(dates, [0, ...stackTotals(points)], frame);
  const xs = dates.map(s.x);
  const layers = stackLayers(points, s);
  // A single day has no width to fill, so it is drawn as one bar instead of an area.
  const single = points.length === 1;

  return (
    <ChartShell
      box={box}
      frame={frame}
      label={`Where your money is, from ${longDate(dates[0])} to ${longDate(dates[dates.length - 1])}`}
      xs={xs}
      render={(active) => (
        <>
          <EstimatedBand s={s} points={points} frame={frame} />
          <Axes s={s} dates={dates} frame={frame} />
          {single
            ? (() => {
                let base = 0;
                const p = points[0];
                return GROUPS.map((g) => {
                  const v = Math.max(0, Number(p.allocation[g]));
                  if (v <= 0) return null;
                  const top = s.y(base + v);
                  const bottom = s.y(base);
                  base += v;
                  return (
                    <rect key={g} x={xs[0] - 24} y={top} width="48" height={bottom - top} fill={GROUP_COLORS[g]} stroke={INK} strokeWidth="2" />
                  );
                });
              })()
            : layers.map((l) => (
                <path key={l.group} d={l.path} fill={GROUP_COLORS[l.group]} stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
              ))}
          {active !== null ? <Cursor x={xs[active]} frame={frame} /> : null}
        </>
      )}
      tooltip={(i) => {
        const p = points[i];
        const shown = GROUPS.filter((g) => Number(p.allocation[g]) !== 0);
        return (
          <>
            <span className="block font-black">{longDate(p.date)}</span>
            <ul className="mt-1">
              {shown.map((g) => (
                <li key={g} className="flex items-center gap-1.5 tabular-nums">
                  <span
                    aria-hidden="true"
                    className="inline-block size-2.5 shrink-0 rounded-[3px] border-2 border-ink"
                    style={{ background: GROUP_COLORS[g] }}
                  />
                  {GROUP_LABELS[g]} {formatRupees(p.allocation[g])}
                </li>
              ))}
            </ul>
            {p.estimated ? <EstimatedTag /> : null}
          </>
        );
      }}
    />
  );
}

export function AllocationLegend({ points }: { points: NetWorthPoint[] }) {
  const used = GROUPS.filter((g) => points.some((p) => Number(p.allocation[g]) > 0));
  return (
    <ul aria-hidden="true" className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs font-extrabold">
      {used.map((g) => (
        <li key={g} className="flex items-center">
          <span
            className="mr-1.5 inline-block size-2.5 shrink-0 rounded-[3px] border-2 border-ink"
            style={{ background: GROUP_COLORS[g] }}
          />
          {GROUP_LABELS[g]}
        </li>
      ))}
    </ul>
  );
}

// The dashboard's small trend line: white on the net worth tile, estimated stretch dashed.
export function Sparkline({ points }: { points: NetWorthPoint[] }) {
  const frame: Frame = { width: 240, height: 44, left: 4, right: 6, top: 6, bottom: 6 };
  const dates = points.map((p) => p.date);
  const s = scale(dates, points.map((p) => Number(p.net_worth)), frame, true);
  const last = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${frame.width} ${frame.height}`} className="mt-2 block h-11 w-full max-w-sm" aria-hidden="true">
      {lineSegments(points, s).map((seg, i) => (
        <path
          key={i}
          d={seg.path}
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeOpacity={seg.estimated ? 0.75 : 1}
          strokeDasharray={seg.estimated ? "5 5" : undefined}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <circle cx={s.x(last.date)} cy={s.y(Number(last.net_worth))} r="4.5" fill="#ffc800" stroke={INK} strokeWidth="2" />
    </svg>
  );
}
