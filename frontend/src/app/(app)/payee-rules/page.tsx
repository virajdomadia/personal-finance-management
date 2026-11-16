import type { Metadata } from "next";

import { OwnerOnly } from "@/components/family/owner-only";
import { PayeeRulesView } from "@/components/review/payee-rules-view";

export const metadata: Metadata = {
  title: "Payee rules",
};

export default function PayeeRulesPage() {
  return (
    <OwnerOnly title="Payee rules" emoji="🏷️" message="Payee rules are for your own profile.">
      <PayeeRulesView />
    </OwnerOnly>
  );
}
