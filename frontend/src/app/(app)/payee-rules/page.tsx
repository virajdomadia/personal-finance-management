import type { Metadata } from "next";

import { PayeeRulesView } from "@/components/review/payee-rules-view";

export const metadata: Metadata = {
  title: "Payee rules",
};

export default function PayeeRulesPage() {
  return <PayeeRulesView />;
}
