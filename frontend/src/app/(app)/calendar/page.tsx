import type { Metadata } from "next";
import { Suspense } from "react";

import { SpendCalendarView } from "@/components/cash-flow/spend-calendar-view";

export const metadata: Metadata = {
  title: "Spending calendar",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// `?add=1` (from the first-run checklist) opens the add form for a fixed expense.
async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { month, add } = await searchParams;
  const valid = typeof month === "string" && /^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
  const adding = add === "1";
  return <SpendCalendarView key={`${valid ?? "current"}-${adding}`} month={valid} adding={adding} />;
}

export default function CalendarPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
