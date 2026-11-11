import type { Metadata } from "next";

import { GoogleSignInButton } from "@/components/google-sign-in-button";

export const metadata: Metadata = {
  title: "Log in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-8 px-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Gullak</h1>
        <p className="text-zinc-600 dark:text-zinc-400">Sign in with your Google account.</p>
      </div>
      {clientId ? (
        <GoogleSignInButton clientId={clientId} />
      ) : (
        <p role="alert" className="text-sm text-red-600">
          Sign-in isn&apos;t available right now. Try again in a few minutes.
        </p>
      )}
    </main>
  );
}
