// A message no parser understood is kept as a masked sample, so the owner can see its shape without
// the numbers or names in it: every run of 3+ digits becomes X's (amounts too), and the words after
// to/from/at/by/VPA (but not "by you"), and any UPI address, become <name>.

const NAME_END = String.raw`(?=\s+(?:via|on|ref(?:no)?|rrn|upi|imps|neft|rtgs|using|for|from|with|avl|avbl|bal|info|thru|is|has|was|and|by|towards|txn)\b|\s*\.(?:\s|$)|\.(?=(?:ref|rrn|avl|avbl|bal|upi|not|call|if|info|total|txn)\b)|\s*[,;(|\n]|\s+-|$)`;
const AFTER_WORD = new RegExp(String.raw`\b(to|from|at|by|vpa)(\s*:?\s+)(?!<name>|(?:you|u|your)\b)(?:.+?)${NAME_END}`, "gi");

export function maskSample(body: string): string {
  return body
    .replace(/[\w.-]+@[\w.-]+/g, "<name>")
    .replace(AFTER_WORD, (_whole, word: string, space: string) => `${word}${space}<name>`)
    .replace(/\d{3,}/g, (digits) => "X".repeat(digits.length));
}
