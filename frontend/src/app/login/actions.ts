"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "@/lib/auth";

export type LoginState = { error: string | null };

const API_URL = process.env.API_URL ?? "http://127.0.0.1:8000";

const UNAVAILABLE_MESSAGE = "Sign-in isn't available right now. Try again in a few minutes.";
const NO_ACCESS_MESSAGE = "This Google account doesn't have access.";

export async function loginWithGoogle(credential: string): Promise<LoginState> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/api/auth/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: credential }),
      cache: "no-store",
    });
  } catch {
    return { error: UNAVAILABLE_MESSAGE };
  }

  if (response.status === 403) return { error: NO_ACCESS_MESSAGE };
  // 401 means Google's token was rejected, which the user can't fix by trying again; 503 and the
  // rest are outages. All of them read as "unavailable".
  if (!response.ok) return { error: UNAVAILABLE_MESSAGE };

  let token: unknown;
  try {
    token = ((await response.json()) as { token?: unknown }).token;
  } catch {
    return { error: UNAVAILABLE_MESSAGE };
  }
  if (typeof token !== "string" || !token) return { error: UNAVAILABLE_MESSAGE };

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  redirect("/");
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  redirect("/login");
}
