import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CoinView } from "@/components/investments/coin-view";

export const metadata: Metadata = {
  title: "Coin | Personal Finance Manager",
};

type Params = Promise<{ coinId: string }>;

async function Content({ params }: { params: Params }) {
  const { coinId } = await params;
  if (!/^[1-9]\d{0,9}$/.test(coinId)) notFound();
  return <CoinView key={coinId} coinId={Number(coinId)} />;
}

export default function CoinPage({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
