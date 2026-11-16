import type { Metadata } from "next";

import { ManageFamilyView } from "@/components/family/manage-family-view";

export const metadata: Metadata = {
  title: "Manage family",
};

export default function ManageFamilyPage() {
  return <ManageFamilyView />;
}
