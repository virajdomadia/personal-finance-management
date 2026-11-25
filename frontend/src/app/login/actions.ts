"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, endSessionRequest } from "@/lib/auth";
import { PROFILE_COOKIE } from "@/lib/family";

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
  // A fresh sign-in starts on the owner's own profile.
  cookieStore.delete(PROFILE_COOKIE);
  // Success is a null error; the client navigates, since an action that redirects rejects its promise.
  return { error: null };
}

async function signOutHere(): Promise<never> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(PROFILE_COOKIE);
  redirect("/login");
}

// Revokes this browser's session on the API, then forgets the cookie. Also runs on a 401, when the
// token is already dead, so the API's answer doesn't matter: the cookie goes either way.
export async function logout(): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await fetch(...endSessionRequest(API_URL, "logout", token));
    } catch {
      // The API is down or slow; the cookie is still removed below.
    }
  }
  await signOutHere();
}

export type SignOutEverywhereState = { error: string | null };

const EVERYWHERE_FAILED = "Couldn't sign out your other devices. Try again in a few minutes.";

// Signs every browser and phone out. Unlike logout, it reports a failure: the point is that the
// other devices are signed out, and staying here signed in says they weren't.
export async function logoutEverywhere(): Promise<SignOutEverywhereState> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    let response: Response;
    try {
      response = await fetch(...endSessionRequest(API_URL, "everywhere", token));
    } catch {
      return { error: EVERYWHERE_FAILED };
    }
    // A 401 means this session had already ended, so there's nothing left to sign out here.
    if (!response.ok && response.status !== 401) return { error: EVERYWHERE_FAILED };
  }
  return signOutHere();
}
