// The Gullak mark (branding/gullak-mark.svg) on its yellow tile.
export function Logo({ size }: { size: number }) {
  return (
    <span
      role="img"
      aria-label="Gullak"
      className="inline-flex shrink-0 items-center justify-center rounded-[22%] border-[2.5px] border-ink bg-yellow"
      style={{ width: size, height: size }}
    >
      <svg viewBox="20 6 80 102" width={size * 0.62} height={size * 0.62} aria-hidden="true">
        <ellipse cx="60" cy="74" rx="34" ry="28" fill="#FF7A00" stroke="#1A1A1A" strokeWidth="5" />
        <rect x="44" y="40" width="32" height="12" rx="5" fill="#FF7A00" stroke="#1A1A1A" strokeWidth="5" />
        <rect x="50" y="62" width="20" height="6" rx="3" fill="#1A1A1A" />
        <circle cx="60" cy="24" r="11" fill="#58CC02" stroke="#1A1A1A" strokeWidth="5" />
        <path d="M40 84 q20 10 40 0" fill="none" stroke="#1A1A1A" strokeWidth="4" strokeLinecap="round" opacity=".35" />
      </svg>
    </span>
  );
}
