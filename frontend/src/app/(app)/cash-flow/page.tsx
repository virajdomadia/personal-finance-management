import type { Metadata } from "next";
import { Suspense } from "react";

import { CashFlowView } from "@/components/cash-flow/cash-flow-view";

export const metadata: Metadata = {
  title: "Cash flow",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { month } = await searchParams;
  const valid = typeof month === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  return <CashFlowView key={valid ?? "current"} month={valid} />;
}

export default function CashFlowPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
