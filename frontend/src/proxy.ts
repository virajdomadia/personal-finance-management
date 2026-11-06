import { NextResponse, type NextRequest } from "next/server";

import { hasSessionToRedirect, isValidSessionToken, SESSION_COOKIE } from "@/lib/auth";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:8000";

function isLoggedIn(request: NextRequest): boolean {
  const secret = process.env.TOKEN_SECRET;
  // Local dev runs without auth unless TOKEN_SECRET is set; production never falls open.
  if (!secret && process.env.NODE_ENV !== "production") return true;
  return isValidSessionToken(request.cookies.get(SESSION_COOKIE)?.value, secret ?? "");
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const loggedIn = isLoggedIn(request);

  if (pathname === "/login") {
    const hasSession = hasSessionToRedirect(
      request.cookies.get(SESSION_COOKIE)?.value,
      process.env.TOKEN_SECRET,
    );
    return hasSession ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    if (!loggedIn) {
      return NextResponse.json({ detail: "Not authenticated" }, { status: 401 });
    }
    // The browser only ever talks to this origin; the cookie becomes a bearer token here.
    const headers = new Headers(request.headers);
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (token) headers.set("authorization", `Bearer ${token}`);
    else headers.delete("authorization");
    headers.delete("cookie");
    return NextResponse.rewrite(new URL(`${pathname}${search}`, API_URL), {
      request: { headers },
    });
  }

  return loggedIn ? NextResponse.next() : NextResponse.redirect(new URL("/login", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
