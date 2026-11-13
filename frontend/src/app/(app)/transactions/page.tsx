import type { Metadata } from "next";
import { Suspense } from "react";

import { TransactionsView } from "@/components/transactions/transactions-view";

export const metadata: Metadata = {
  title: "Transactions",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  // The filters live in the address (?q=plumber&category=Housing...); the view checks each one.
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.set(key, value);
  }
  return <TransactionsView initialQuery={params.toString()} />;
}

export default function TransactionsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
