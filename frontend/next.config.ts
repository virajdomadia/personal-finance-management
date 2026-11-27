import type { NextConfig } from "next";

/*
 * Security headers on every page. The CSP is the part that cannot break the app: no framing
 * (clickjacking), no <base> hijack, no plugins, forms post only to this origin. A script/style
 * allow-list would also have to cover Google Sign-In (accounts.google.com) and Next's inline
 * bootstrap; add it once it can be checked signed in.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // identity-credentials-get stays allowed: Google Sign-In uses FedCM.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Reminders have their own page again; old links land there (`?add=1` is carried over).
  async redirects() {
    return [{ source: "/recurring", destination: "/reminders", permanent: false }];
  },
  // The app uses no next/image; turning the optimizer off means /_next/image can never spend
  // Vercel Hobby's monthly image-transformation quota.
  images: { unoptimized: true },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
