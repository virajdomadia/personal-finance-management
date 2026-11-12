import type { Metadata } from "next";
import { Suspense } from "react";

import { type AddStart, AccountsView } from "@/components/accounts/accounts-view";

export const metadata: Metadata = {
  title: "Accounts",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// `?add=bank|credit_card|loan` (from the first-run checklist) opens the add dialog on that type.
// A bank starts on kind Salary: the checklist asks for the account the salary lands in.
const STARTS: Record<string, AddStart> = {
  bank: { type: "bank", bank_kind: "salary" },
  credit_card: { type: "credit_card" },
  loan: { type: "loan" },
};

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { add } = await searchParams;
  const start = typeof add === "string" && Object.hasOwn(STARTS, add) ? STARTS[add] : null;
  return <AccountsView key={add ? String(add) : "list"} add={start} />;
}

export default function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
