import type { Metadata } from "next";

import { FamilyView } from "@/components/family/family-view";

export const metadata: Metadata = {
  title: "Family portfolio",
};

export default function FamilyPage() {
  return <FamilyView />;
}
