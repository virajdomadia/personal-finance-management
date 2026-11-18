/** Where to go after signing in: the page the visitor asked for (set by the proxy), if it is a
 *  same-site path. Anything else ("//evil.example", "https://…", "/\evil") falls back to "/". */
export function afterLoginPath(search: string): string {
  const next = new URLSearchParams(search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")
    ? next
    : "/";
}
