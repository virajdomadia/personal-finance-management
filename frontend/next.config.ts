import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
