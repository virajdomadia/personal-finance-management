// Which bank an SMS sender is. Indian business senders look like "VM-HDFCBK-S": a two-letter
// operator and circle prefix, the six-letter header the bank registered, and a -S/-T/-P/-G suffix
// for the message category. Only the header names the bank.

// Header → the parser key sent to the server as `bank`. Card alerts come from the bank's own
// header for most issuers; SBI Card is a separate company with its own.
const HEADERS: Record<string, string> = {
  HDFCBK: "hdfc",
  SBIINB: "sbi",
  SBIUPI: "sbi",
  ATMSBI: "sbi",
  CBSSBI: "sbi",
  SBIPSG: "sbi",
  SBICRD: "sbicard",
  ICICIB: "icici",
  ICICIT: "icici",
  AXISBK: "axis",
  KOTAKB: "kotak",
  BOIIND: "boi",
  BOISMS: "boi",
  BOBTXN: "bob",
  BOBSMS: "bob",
  BOBCRD: "bob",
  PNBSMS: "pnb",
  CANBNK: "canara",
  UNIONB: "union",
  IDFCFB: "idfc",
  YESBNK: "yes",
  INDUSB: "indusind",
  FEDBNK: "federal",
  FEDFIB: "federal",
};

export function senderBank(address: string): string | null {
  const text = address.trim().toUpperCase();
  // A person's number (or nothing): never a bank.
  if (!/[A-Z]/.test(text)) return null;
  const header = text.replace(/^[A-Z]{2}-/, "").replace(/-[STPG]$/, "");
  if (header.startsWith("CDSL")) return "cdsl";
  if (header.startsWith("NSDL")) return "nsdl";
  return HEADERS[header] ?? null;
}
