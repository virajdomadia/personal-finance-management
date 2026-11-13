import type { Metadata } from "next";
import { Suspense } from "react";

import { RecurringView } from "@/components/recurring/recurring-view";

export const metadata: Metadata = {
  title: "Recurring",
};

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// `?add=1` (from the first-run checklist) opens the add dialog.
async function Content({ searchParams }: { searchParams: SearchParams }) {
  const { add } = await searchParams;
  const adding = add === "1";
  return <RecurringView key={adding ? "add" : "list"} adding={adding} />;
}

export default function RecurringPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
