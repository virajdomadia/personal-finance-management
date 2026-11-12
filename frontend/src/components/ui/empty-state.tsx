import type { ReactNode } from "react";

// What an empty list shows: what the screen is for, in a line or two, and one clear action.
// `inset` drops the card's border and shadow, for an empty section inside a card that has them.
export function EmptyState({
  emoji,
  title,
  children,
  action,
  heading = "h2",
  inset = false,
}: {
  emoji: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  heading?: "h2" | "h3" | "p";
  inset?: boolean;
}) {
  const Title = heading;
  return (
    <div
      className={
        inset
          ? "px-4 py-6 text-center"
          : "rounded-[18px] border-[2.5px] border-ink bg-card px-6 py-10 text-center shadow-chunky"
      }
    >
      <p className={inset ? "text-3xl" : "text-4xl"} aria-hidden="true">
        {emoji}
      </p>
      <Title className="mt-2 text-base font-black">{title}</Title>
      {children ? <p className="mx-auto mt-1 max-w-md text-sm font-bold text-zinc-600">{children}</p> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
