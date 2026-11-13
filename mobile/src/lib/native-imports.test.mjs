// An installed build made before a native module was added doesn't have it. A static import of that
// package runs while the app starts and crashes every screen, so these packages are only ever loaded
// after a check in native.ts. Type-only imports are fine: they vanish when the app is bundled.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const GUARDED = ["expo-sharing", "expo-file-system", "expo-notifications", "expo-clipboard", "expo-crypto"];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("guarded native packages are never imported at the top of a file", () => {
  const offenders = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const pkg of GUARDED) {
      const value = new RegExp(String.raw`^\s*import\s+(?!type\b)[^;]*from\s+["']${pkg}["']`, "m");
      const bare = new RegExp(String.raw`^\s*import\s+["']${pkg}["']`, "m");
      if (value.test(text) || bare.test(text)) offenders.push(`${relative(SRC, file)} imports ${pkg}`);
    }
  }
  assert.deepEqual(offenders, []);
});
