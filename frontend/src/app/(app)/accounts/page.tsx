import type { Metadata } from "next";

import { AccountsView } from "@/components/accounts/accounts-view";

export const metadata: Metadata = {
  title: "Accounts | Personal Finance Manager",
};

export default function AccountsPage() {
  return <AccountsView />;
}
