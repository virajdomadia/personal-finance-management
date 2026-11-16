"use client";

import type { ReactNode } from "react";

import { useProfile } from "@/components/family/profile";
import { PageHeader, buttonClass } from "@/components/ui/chunky";
import { EmptyState } from "@/components/ui/empty-state";

// A page about the phone's SMS, which are always the owner's: the API answers /sms/* and
// /payee-rules for the owner whatever profile is chosen, while the accounts these pages offer
// would be the member's. So while a member is viewed the page asks to go back instead.
export function OwnerOnly({
  title,
  emoji,
  message,
  children,
}: {
  title: string;
  emoji: string;
  message: string;
  children: ReactNode;
}) {
  const { ready, viewingMember, switchTo } = useProfile();
  if (!ready) return null;
  if (!viewingMember) return children;
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        emoji={emoji}
        title={message}
        action={
          <button type="button" className={`${buttonClass("primary")} uppercase`} onClick={() => switchTo(null)}>
            Back to me
          </button>
        }
      >
        The SMS from your phone are yours, so they are handled on your profile.
      </EmptyState>
    </>
  );
}
