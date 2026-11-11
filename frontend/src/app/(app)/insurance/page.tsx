import type { Metadata } from "next";

import { InsuranceView } from "@/components/insurance/insurance-view";

export const metadata: Metadata = {
  title: "Insurance",
};

export default function InsurancePage() {
  return <InsuranceView />;
}
