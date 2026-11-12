import type { Metadata } from "next";

import { NetWorthView } from "@/components/net-worth/net-worth-view";

export const metadata: Metadata = {
  title: "Net worth",
};

export default function NetWorthPage() {
  return <NetWorthView />;
}
