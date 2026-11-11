import type { Metadata } from "next";

import { GoalsView } from "@/components/goals/goals-view";

export const metadata: Metadata = {
  title: "Goals",
};

export default function GoalsPage() {
  return <GoalsView />;
}
