"use client";

import { useActionState, useState } from "react";

import { type SignOutEverywhereState, logoutEverywhere } from "@/app/login/actions";
import { Notice } from "@/components/investments/shared";
import { buttonClass } from "@/components/ui/chunky";

// Ends every session: this browser, others, and the phone app. Asks once before doing it.
export function SignOutEverywhere() {
  const [asking, setAsking] = useState(false);
  const [state, action, pending] = useActionState<SignOutEverywhereState>(logoutEverywhere, { error: null });

  return (
    <section
      aria-labelledby="sign-out-everywhere"
      className="mt-6 flex flex-col gap-3 rounded-[18px] border-[2.5px] border-ink bg-card p-4 shadow-chunky"
    >
      <h2 id="sign-out-everywhere" className="text-lg font-black">
        <span aria-hidden="true">🔒 </span>
        Sign out everywhere
      </h2>
      <p className="max-w-prose text-sm font-bold text-zinc-600">
        Lost a phone, or signed in on a computer that isn&apos;t yours? This signs out every browser and phone signed in
        to Gullak, this one too. Your data isn&apos;t touched.
      </p>
      <Notice message={state.error} />
      {asking ? (
        <form action={action} className="flex flex-wrap gap-2">
          <button type="submit" className={buttonClass("pink")} disabled={pending} aria-busy={pending}>
            {pending ? "Signing out…" : "Yes, sign out everywhere"}
          </button>
          <button type="button" className={buttonClass("alt")} disabled={pending} onClick={() => setAsking(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div>
          <button type="button" className={buttonClass("alt")} onClick={() => setAsking(true)}>
            Sign out everywhere
          </button>
        </div>
      )}
    </section>
  );
}
