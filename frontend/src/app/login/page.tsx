import type { Metadata } from "next";

import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { Logo } from "@/components/ui/logo";

export const metadata: Metadata = {
  title: "Log in",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-10 px-6 py-10 md:flex-row md:gap-16">
      <div className="flex w-full max-w-md flex-col gap-3">
        <Logo size={72} />
        <h1 className="mt-2 text-5xl leading-none font-black">
          Your money,
          <br />
          but fun.
        </h1>
        <p className="text-base font-bold text-zinc-600">Track every rupee. Watch it grow.</p>
        <div className="mt-4">
          {clientId ? (
            <GoogleSignInButton clientId={clientId} />
          ) : (
            <p role="alert" className="text-sm font-bold text-loss">
              Sign-in isn&apos;t available right now. Try again in a few minutes.
            </p>
          )}
        </div>
      </div>
      <div aria-hidden="true" className="grid w-full max-w-xs grid-cols-2 gap-3.5">
        <div className="col-span-2 rounded-[18px] border-[2.5px] border-ink bg-green-strong p-3.5 text-white shadow-chunky">
          <span className="block text-xs font-extrabold">Net worth</span>
          <span className="block text-[22px] leading-tight font-black tabular-nums">₹14,82,350</span>
        </div>
        <div className="rounded-[18px] border-[2.5px] border-ink bg-yellow p-3.5 text-ink shadow-chunky">
          <span className="block text-xs font-extrabold">Goals</span>
          <span className="block text-[22px] leading-tight font-black">🎯 68%</span>
        </div>
        <div className="rounded-[18px] border-[2.5px] border-ink bg-pink-strong p-3.5 text-white shadow-chunky">
          <span className="block text-xs font-extrabold">Streak</span>
          <span className="block text-[22px] leading-tight font-black">🔥 12</span>
        </div>
      </div>
    </main>
  );
}
