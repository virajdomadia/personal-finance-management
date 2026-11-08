import type { Metadata } from "next";
import { Suspense } from "react";

import { InvestmentsView } from "@/components/investments/investments-view";

export const metadata: Metadata = {
  title: "Investments | Personal Finance Manager",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { broker } = await searchParams;
  const brokerId = typeof broker === "string" && /^[1-9]\d{0,9}$/.test(broker) ? Number(broker) : null;
  // Keyed so that clearing or changing the broker starts a fresh view.
  return <InvestmentsView key={brokerId ?? "all"} brokerId={brokerId} />;
}

export default function InvestmentsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
