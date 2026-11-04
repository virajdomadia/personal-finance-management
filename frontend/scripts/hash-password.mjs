// Prints the APP_PASSWORD_HASH value for a password piped in on stdin, e.g.
//   npm run --silent hash-password < file-containing-password
import { text } from "node:stream/consumers";

import { hashPassword } from "../src/lib/auth.ts";

const password = (await text(process.stdin)).replace(/\r?\n$/, "");
if (!password) {
  console.error("No password received on stdin.");
  process.exit(1);
}
console.log(hashPassword(password));
