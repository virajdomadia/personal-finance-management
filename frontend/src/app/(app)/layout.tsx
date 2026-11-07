import { SessionCheck } from "@/components/session-check";
import { Sidebar } from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1">
      <SessionCheck />
      <Sidebar />
      <main className="min-w-0 flex-1 p-6">{children}</main>
    </div>
  );
}
