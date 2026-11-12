import type { Metadata } from "next";

import { CategoriesView } from "@/components/categories/categories-view";

export const metadata: Metadata = {
  title: "Categories",
};

export default function CategoriesPage() {
  return <CategoriesView />;
}
