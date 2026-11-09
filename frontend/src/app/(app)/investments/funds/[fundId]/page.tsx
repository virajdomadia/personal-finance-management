import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { FundView } from "@/components/investments/fund-view";

export const metadata: Metadata = {
  title: "Mutual fund | Personal Finance Manager",
};

type Params = Promise<{ fundId: string }>;

async function Content({ params }: { params: Params }) {
  const { fundId } = await params;
  if (!/^[1-9]\d{0,9}$/.test(fundId)) notFound();
  return <FundView key={fundId} fundId={Number(fundId)} />;
}

export default function FundPage({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
