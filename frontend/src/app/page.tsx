import { logout } from "@/app/login/actions";
import { ApiStatus } from "@/components/api-status";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-semibold tracking-tight">Personal Finance Manager</h1>
      <p className="text-zinc-600 dark:text-zinc-400">Next.js frontend + FastAPI backend.</p>
      <ApiStatus />
      <form action={logout}>
        <button type="submit" className="text-sm text-zinc-600 underline dark:text-zinc-400">
          Log out
        </button>
      </form>
    </main>
  );
}
