import type { Metadata } from "next";

import { OwnerOnly } from "@/components/family/owner-only";
import { ReviewView } from "@/components/review/review-view";

export const metadata: Metadata = {
  title: "To review",
};

export default function ReviewPage() {
  return (
    <OwnerOnly title="To review" emoji="📥" message="SMS review is for your own profile.">
      <ReviewView />
    </OwnerOnly>
  );
}
