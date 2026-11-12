import type { Metadata } from "next";
import { Suspense } from "react";

import { BudgetsView } from "@/components/budgets/budgets-view";

export const metadata: Metadata = {
  title: "Budgets",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { month } = await searchParams;
  const valid = typeof month === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  return <BudgetsView key={valid ?? "current"} month={valid} />;
}

export default function BudgetsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
