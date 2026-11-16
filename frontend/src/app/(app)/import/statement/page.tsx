import type { Metadata } from "next";

import { StatementImportView } from "@/components/statement/statement-import-view";

export const metadata: Metadata = {
  title: "Import a statement",
};

export default function StatementImportPage() {
  return <StatementImportView />;
}
