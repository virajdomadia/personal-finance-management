import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { GoalView } from "@/components/goals/goal-view";

export const metadata: Metadata = {
  title: "Goal",
};

type Params = Promise<{ goalId: string }>;

async function Content({ params }: { params: Params }) {
  const { goalId } = await params;
  if (!/^[1-9]\d{0,9}$/.test(goalId)) notFound();
  return <GoalView key={goalId} goalId={Number(goalId)} />;
}

export default function GoalPage({ params }: { params: Params }) {
  return (
    <Suspense>
      <Content params={params} />
    </Suspense>
  );
}
