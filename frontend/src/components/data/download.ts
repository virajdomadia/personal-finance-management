import { downloadError, fileNameFrom } from "@/lib/data-export";

// Downloads go through the /api proxy, which turns the session cookie into the API's token.
// A failure carries its HTTP status, so a 401 can log out.
export async function saveDownload(path: string, fallback: string): Promise<void> {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw Object.assign(new Error(downloadError(res.status)), { status: res.status });
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = fileNameFrom(res.headers.get("content-disposition"), fallback);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
