import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { StockView } from "@/components/investments/stock-view";

export const metadata: Metadata = {
  title: "Stock",
};

type Params = Promise<{ stockId: string }>;

async function Content({ params }: { params: Params }) {
  const { stockId } = await params;
  if (!/^[1-9]\d{0,9}$/.test(stockId)) notFound();
  return <StockView key={stockId} stockId={Number(stockId)} />;
}

export default function StockPage({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
