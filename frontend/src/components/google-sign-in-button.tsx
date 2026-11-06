"use client";

import Script from "next/script";
import { useRef, useState } from "react";

import { loginWithGoogle } from "@/app/login/actions";

type GoogleAccounts = {
  initialize: (config: {
    client_id: string;
    callback: (response: { credential: string }) => void;
    use_fedcm_for_button: boolean;
  }) => void;
  renderButton: (parent: HTMLElement, options: Record<string, string | number>) => void;
};

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccounts } };
  }
}

const UNAVAILABLE = "Sign-in isn't available right now. Try again in a few minutes.";

export function GoogleSignInButton({ clientId }: { clientId: string }) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  function renderButton() {
    const google = window.google?.accounts.id;
    if (!google || !buttonRef.current) return;
    google.initialize({
      client_id: clientId,
      use_fedcm_for_button: true,
      callback: async ({ credential }) => {
        setError(null);
        try {
          const result = await loginWithGoogle(credential);
          if (result.error) setError(result.error);
        } catch {
          setError(UNAVAILABLE);
        }
      },
    });
    google.renderButton(buttonRef.current, {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "signin_with",
      width: 280,
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={renderButton}
        onError={() => setError(UNAVAILABLE)}
      />
      <div ref={buttonRef} className="min-h-10" />
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}
