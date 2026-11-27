import type { Metadata } from "next";
import { Suspense } from "react";

import { SpendCalendarView } from "@/components/cash-flow/spend-calendar-view";

export const metadata: Metadata = {
  title: "Spending calendar",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { month } = await searchParams;
  const valid = typeof month === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  return <SpendCalendarView key={valid ?? "current"} month={valid} />;
}

export default function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
