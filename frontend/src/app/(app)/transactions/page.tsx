import type { Metadata } from "next";
import { Suspense } from "react";

import { TransactionsView } from "@/components/transactions/transactions-view";

export const metadata: Metadata = {
  title: "Transactions | Personal Finance Manager",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { account } = await searchParams;
  const accountId = typeof account === "string" && /^[1-9]\d{0,9}$/.test(account) ? Number(account) : null;
  return <TransactionsView initialAccountId={accountId} />;
}

export default function TransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
