import Link from "next/link";

import type { Unlinked } from "@/lib/investments";

import { SECTION_TITLE } from "./shared";

// Shown while some holdings have no live-price link. Each one opens its page, where "Link to live
// prices" is.
export function LinkPrompt({ unlinked }: { unlinked: Unlinked }) {
  const groups = [
    { label: "Stocks", base: "/investments", items: unlinked.stocks.map((s) => ({ id: s.id, text: s.symbol })) },
    { label: "Funds", base: "/investments/funds", items: unlinked.funds.map((f) => ({ id: f.id, text: f.name })) },
    { label: "Coins", base: "/investments/crypto", items: unlinked.coins.map((c) => ({ id: c.id, text: c.symbol })) },
  ].filter((g) => g.items.length > 0);
  if (groups.length === 0) return null;
  return (
    <section aria-labelledby="link-prompt-title" className="rounded-[18px] border-[2.5px] border-ink bg-yellow p-4 text-ink shadow-chunky">
      <h2 id="link-prompt-title" className="text-lg font-black">
        Let Gullak fetch your prices
      </h2>
      <p className="mt-0.5 text-sm font-bold">Link each holding once and its price updates every night.</p>
      <div className="mt-3 flex flex-col gap-2">
        {groups.map((g) => (
          <div key={g.label}>
            <h3 className={`${SECTION_TITLE} !mb-1 !px-0`}>{g.label}</h3>
            <ul className="flex flex-wrap gap-2">
              {g.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`${g.base}/${item.id}`}
                    className="inline-block rounded-full border-[2.5px] border-ink bg-card px-3 py-1 text-xs font-extrabold hover:bg-bg focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg focus-visible:outline-transparent"
                  >
                    {item.text}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
