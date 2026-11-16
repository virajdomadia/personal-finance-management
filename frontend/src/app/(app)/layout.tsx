import { ProfileProvider, ViewingBar } from "@/components/family/profile";
import { SessionCheck } from "@/components/session-check";
import { Sidebar } from "@/components/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProfileProvider>
      <div className="flex flex-1">
        <SessionCheck />
        <Sidebar />
        <main className="min-w-0 flex-1 p-4 sm:p-6">
          <ViewingBar />
          {children}
        </main>
      </div>
    </ProfileProvider>
  );
}
