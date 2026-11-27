import type { Metadata } from "next";
import { Suspense } from "react";

import { RemindersView } from "@/components/recurring/reminders-view";

export const metadata: Metadata = {
  title: "Reminders",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// `?add=1` (from the first-run checklist) opens the add form for a monthly expense.
async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { add } = await searchParams;
  const adding = add === "1";
  return <RemindersView key={String(adding)} adding={adding} />;
}

export default function RemindersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
