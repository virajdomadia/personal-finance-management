import type { Metadata } from "next";

import { InsuranceView } from "@/components/insurance/insurance-view";

export const metadata: Metadata = {
  title: "Insurance | Personal Finance Manager",
};

export default function InsurancePage() {
  return <InsuranceView />;
}
