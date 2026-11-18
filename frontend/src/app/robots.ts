import type { MetadataRoute } from "next";

// A private finance app: nothing here is meant for search engines.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
