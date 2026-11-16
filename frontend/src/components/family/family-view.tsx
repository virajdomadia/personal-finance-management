"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { formatRupees } from "@/lib/accounts";
import { apiFetch } from "@/lib/api";
import {
  type FamilyPortfolio,
  type PersonPortfolio,
  HOW_IT_WORKS,
  emptyHoldingsText,
  formatShare,
  holdingCountText,
  holdingGain,
  holdingLabel,
  kindLabel,
  shares,
  sortHoldings,
  typesWithMoney,
} from "@/lib/family";
import { useProfile } from "@/components/family/profile";
import { PlainSigned, PRIMARY, QUIET, SECONDARY, SECTION_TITLE, Signed, isUnauthorized } from "@/components/investments/shared";
import { PageHeader, StackedBar, TABLE, TD, TD_NUM, TH, Tile, buttonClass } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";

type Load = { status: "loading" } | { status: "error" } | { status: "ready"; data: FamilyPortfolio };

// Everyone's investments together. Always the owner's family, whichever profile is chosen.
export function FamilyView() {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const latest = useRef(0);

  const reload = useCallback(() => {
    const request = ++latest.current;
    apiFetch<FamilyPortfolio>("/family/portfolio")
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (isUnauthorized(err)) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const data = load.status === "ready" ? load.data : null;
  const hasMembers = data !== null && data.people.some((p) => !p.is_me);

  return (
    <>
      <PageHeader
        title="Family portfolio"
        action={
          hasMembers ? (
            <Link href="/family/manage" className={SECONDARY}>
              Manage family
            </Link>
          ) : undefined
        }
      />

      {load.status === "loading" && (
        <p role="status" className="text-sm font-bold text-zinc-600">
          Loading your family&apos;s investments...
        </p>
      )}

      {load.status === "error" && (
        <div role="alert" className="rounded-[18px] border-[2.5px] border-ink bg-card p-4 text-sm font-extrabold shadow-chunky">
          <p>We couldn&apos;t load your family&apos;s investments.</p>
          <button
            type="button"
            className={`${QUIET} mt-2`}
            onClick={() => {
              setLoad({ status: "loading" });
              reload();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {data && !hasMembers && (
        <EmptyState
          emoji="👨‍👩‍👧"
          title="Bring your family's investments together"
          action={
            <Link href="/family/manage" className={PRIMARY}>
              Add a family member
            </Link>
          }
        >
          {HOW_IT_WORKS}
        </EmptyState>
      )}

      {data && hasMembers && (
        <div className="flex flex-col gap-8">
          <Totals data={data} />
          <ByPerson people={data.people} />
          <ByType data={data} />
          <section aria-labelledby="people-title">
            <h2 id="people-title" className={SECTION_TITLE}>
              Each person&apos;s holdings
            </h2>
            <div className="flex flex-col gap-3">
              {data.people.map((p) => (
                <PersonHoldings key={p.id} person={p} />
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Totals({ data }: { data: FamilyPortfolio }) {
  const { overall } = data;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="sm:col-span-2">
        <Tile tone="blue" size="huge" emoji="💎" label="Family's investments, worth today" value={formatRupees(overall.value)}>
          <span className="mt-0.5 block text-xs font-extrabold break-words">
            <span className="uppercase">Gain</span> <PlainSigned value={overall.unrealised} percent={overall.unrealised_percent} />
          </span>
        </Tile>
      </div>
      <Tile tone="yellow" emoji="💰" label="Put in" value={formatRupees(overall.invested)} />
      <Tile label="Gain">
        <span className="mt-0.5 block text-[22px] leading-tight font-black tabular-nums break-words">
          <Signed value={overall.unrealised} />
        </span>
        <span className="block text-xs font-extrabold">
          <Signed value={overall.unrealised_percent} percentOnly />
        </span>
      </Tile>
    </div>
  );
}

function GainCell({ value, percent }: { value: string; percent?: string }) {
  return (
    <td className={TD_NUM}>
      <Signed value={value} />
      {percent !== undefined && (
        <span className="block text-xs">
          <Signed value={percent} percentOnly />
        </span>
      )}
    </td>
  );
}

function ByPerson({ people }: { people: PersonPortfolio[] }) {
  const share = shares(people.map((p) => p.overall.value));
  return (
    <section aria-labelledby="by-person-title">
      <h2 id="by-person-title" className={SECTION_TITLE}>
        By person
      </h2>
      <div className="mb-3 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky">
        <StackedBar label="Family's value by person" items={people.map((p) => ({ label: p.name, value: Number(p.overall.value) }))} />
        {people.every((p) => !(Number(p.overall.value) > 0)) && (
          <p className="text-sm font-bold text-zinc-600">Nobody has investments yet.</p>
        )}
      </div>
      <div className="overflow-x-auto pb-1">
        <table className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Person
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Value
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Put in
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Gain
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((p, i) => (
              <tr key={p.id}>
                <th scope="row" className={`${TD} text-left font-extrabold [overflow-wrap:anywhere]`}>
                  {p.name}
                </th>
                <td className={TD_NUM}>{formatRupees(p.overall.value)}</td>
                <td className={TD_NUM}>{formatRupees(p.overall.invested)}</td>
                <GainCell value={p.overall.unrealised} percent={p.overall.unrealised_percent} />
                <td className={TD_NUM}>{formatShare(share[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ByType({ data }: { data: FamilyPortfolio }) {
  const rows = typesWithMoney(data.by_type);
  if (rows.length === 0) return null;
  const share = shares(rows.map((r) => r.figures.value));
  return (
    <section aria-labelledby="by-type-title">
      <h2 id="by-type-title" className={SECTION_TITLE}>
        By type
      </h2>
      <div className="mb-3 rounded-[18px] border-[2.5px] border-ink bg-card p-3.5 shadow-chunky">
        <StackedBar label="Family's value by type" items={rows.map((r) => ({ label: r.label, value: Number(r.figures.value) }))} />
        <p className="mt-2 text-xs font-bold text-zinc-600">Deposits (PPF, RD, FD) count at their balance, as on Investments.</p>
      </div>
      <div className="overflow-x-auto pb-1">
        <table className={`${TABLE} max-lg:[&_td]:px-2 max-lg:[&_th]:px-2`}>
          <thead>
            <tr>
              <th scope="col" className={TH}>
                Type
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Value
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Put in
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Gain
              </th>
              <th scope="col" className={`${TH} text-right`}>
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <th scope="row" className={`${TD} text-left font-extrabold`}>
                  {r.label}
                </th>
                <td className={TD_NUM}>{formatRupees(r.figures.value)}</td>
                <td className={TD_NUM}>{formatRupees(r.figures.invested)}</td>
                <GainCell value={r.figures.unrealised} percent={r.figures.unrealised_percent} />
                <td className={TD_NUM}>{formatShare(share[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PersonHoldings({ person }: { person: PersonPortfolio }) {
  const { viewingMember, switchTo } = useProfile();
  const holdings = sortHoldings(person.holdings);
  const titleId = `holdings-${person.id}`;
  return (
    <details className="group rounded-[18px] border-[2.5px] border-ink bg-card shadow-chunky">
      <summary
        className={`flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-[15px] px-4 py-3 hover:bg-due [&::-webkit-details-marker]:hidden focus-visible:outline-2 focus-visible:outline-transparent focus-visible:ring-[3px] focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-bg`}
      >
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90 motion-reduce:transition-none">
          ▸
        </span>
        <span id={titleId} className="min-w-0 flex-1 text-base font-black [overflow-wrap:anywhere]">
          {person.name}
        </span>
        <span className="text-sm font-black tabular-nums">{formatRupees(person.overall.value)}</span>
        <span className="w-full pl-6 text-xs font-bold text-zinc-600 sm:w-auto sm:pl-0">
          {holdingCountText(person.holdings.length)}
        </span>
      </summary>
      <div className="border-t-[2.5px] border-ink">
        {holdings.length === 0 ? (
          <EmptyState
            inset
            heading="p"
            emoji="🌱"
            title={emptyHoldingsText(person)}
            action={
              person.is_me ? (
                viewingMember ? (
                  <button type="button" className={`${buttonClass("primary")} uppercase`} onClick={() => switchTo(null)}>
                    Back to me
                  </button>
                ) : (
                  <Link href="/investments" className={PRIMARY}>
                    Go to Investments
                  </Link>
                )
              ) : (
                <button type="button" className={`${buttonClass("primary")} uppercase`} onClick={() => switchTo(person.id)}>
                  Switch to {person.name}
                </button>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table aria-labelledby={titleId} className="w-full border-separate border-spacing-0 text-sm max-lg:[&_td]:px-2 max-lg:[&_th]:px-2">
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    Holding
                  </th>
                  <th scope="col" className={`${TH} hidden sm:table-cell`}>
                    Kind
                  </th>
                  <th scope="col" className={`${TH} hidden text-right md:table-cell`}>
                    Quantity
                  </th>
                  <th scope="col" className={`${TH} hidden text-right md:table-cell`}>
                    Put in
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Value
                  </th>
                  <th scope="col" className={`${TH} text-right`}>
                    Gain
                  </th>
                </tr>
              </thead>
              <tbody className="[&>tr:last-child>*]:border-b-0">
                {holdings.map((h, i) => {
                  const { title, detail } = holdingLabel(h);
                  return (
                    <tr key={`${h.kind}-${h.symbol ?? ""}-${h.name}-${i}`}>
                      <th scope="row" className={`${TD} text-left`}>
                        <span className="block font-extrabold [overflow-wrap:anywhere]">{title}</span>
                        <span className="block text-xs font-bold text-zinc-600 [overflow-wrap:anywhere]">
                          {detail && <>{detail}</>}
                          <span className="sm:hidden">
                            {detail ? " · " : ""}
                            {kindLabel(h.kind)}
                          </span>
                        </span>
                      </th>
                      <td className={`${TD} hidden sm:table-cell`}>{kindLabel(h.kind)}</td>
                      <td className={`${TD_NUM} hidden md:table-cell`}>{h.quantity ?? "–"}</td>
                      <td className={`${TD_NUM} hidden md:table-cell`}>{formatRupees(h.invested)}</td>
                      <td className={TD_NUM}>
                        {formatRupees(h.value)}
                        <span className="block text-xs font-bold text-zinc-600 md:hidden">Put in {formatRupees(h.invested)}</span>
                      </td>
                      <GainCell value={holdingGain(h)} />
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </details>
  );
}
