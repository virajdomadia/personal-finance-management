"use client";

import { useEffect } from "react";

import { logout } from "@/app/login/actions";
import { ApiError, apiFetch } from "@/lib/api";

// The proxy only checks the cookie's signature, so only the API can notice a revoked login.
export function SessionCheck() {
  useEffect(() => {
    apiFetch("/auth/session").catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 401) void logout();
    });
  }, []);

  return null;
}
