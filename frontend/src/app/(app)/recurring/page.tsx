import { redirect } from "next/navigation";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

// Reminders now live on the spending calendar; old links and bookmarks land there.
export default async function RecurringPage({ searchParams }: { searchParams: SearchParams }) {
  const { add } = await searchParams;
  redirect(add === "1" ? "/calendar?add=1" : "/calendar");
}
