// Sample bank, card and depository SMS with what the parser should read from each.
//
// `expect` is the one line a message gives, a list of lines (CDSL can list several shares),
// "ignore" or "unreadable". Each line names kind, amount, last4, payee, ref and date; balance,
// dueDate, isin and quantity are checked when given. Messages are read as if received at
// RECEIVED unless a fixture says otherwise.
//
// The owner's real samples come first. Their account digits and reference numbers are replaced by
// fake ones of the same length; everything else is byte for byte. The rest follow publicly shown
// formats and carry the note "format from public examples, not yet checked against a real SMS".

export const RECEIVED = "2026-11-12T10:00:00+05:30";

export const OWNER = {
  boiUpiDebit: {
    sender: "JD-BOIIND-S",
    bank: "boi",
    body: "Rs.243.00 debited A/cXX4721 and credited to Blinkit via UPI Ref No 631500274119 on 11Nov26. Call 18001031906, if not done by you. -BOI",
    expect: { kind: "debit", amount: "243.00", last4: "4721", payee: "Blinkit", ref: "631500274119", date: "2026-11-11", balance: null },
  },
  federalImpsDebit: {
    sender: "AX-FEDBNK-S",
    bank: "federal",
    body: "Debited Rs 20000.00 from a/c X3388 on 11Nov26 11:09 via IMPS to XX472.Ref 631577120384. Bal Rs 38857.54. Not you?Call 18004251199 -Federal Bank",
    expect: { kind: "debit", amount: "20000.00", last4: "3388", payee: "XX472", ref: "631577120384", date: "2026-11-11", balance: "38857.54" },
  },
  federalImpsCredit: {
    sender: "AX-FEDBNK-S",
    bank: "federal",
    body: "Rs 15000 credited to your A/c XX3388 via IMPS on 01NOV2026 08:23:07 IMPS Ref no 630566219837 Bal:Rs 34518.36 -Federal Bank",
    expect: { kind: "credit", amount: "15000.00", last4: "3388", payee: null, ref: "630566219837", date: "2026-11-01", balance: "34518.36" },
  },
  federalCardSpend: {
    sender: "AX-FEDBNK-S",
    bank: "federal",
    body: "INR 491.00 spent on your credit card ending with 5530 at 667608351294    interg on 06-11-2026. Available limit Rs.14,333.20. Not you, call 18004201199 -Federal Bank",
    expect: { kind: "card_spend", amount: "491.00", last4: "5530", payee: "interg", ref: null, date: "2026-11-06", balance: null },
  },
  hdfcCardSpend: {
    sender: "VM-HDFCBK-S",
    bank: "hdfc",
    body: "Spent Rs.42926.27 On HDFC Bank Card 7242 At RSP*AMITY On 2026-03-24:09:41:49.Not You? To Block+Reissue Call 18002586161/SMS BLOCK CC 7242 to 7308080808",
    expect: { kind: "card_spend", amount: "42926.27", last4: "7242", payee: "RSP*AMITY", ref: null, date: "2026-03-24", balance: null },
  },
  cdslDebit: {
    sender: "CDSLTX",
    bank: "cdsl",
    body: "CDSL: Debit in a/c *00418277 for 221-HINDUSTAN CO EQ RE.1 on 08SEP",
    expect: [
      { kind: "demat", amount: null, last4: "8277", payee: "HINDUSTAN CO", ref: "debit", date: "2026-09-08", isin: null, quantity: "221" },
    ],
  },
};

const PUBLIC = "format from public examples, not yet checked against a real SMS";

export const FIXTURES = [
  ...Object.entries(OWNER).map(([name, f]) => ({ name: `owner ${name}`, ...f })),

  // HDFC Bank
  {
    name: "hdfc upi sent", note: PUBLIC, sender: "VM-HDFCBK", bank: "hdfc",
    body: "Sent Rs.250.00\nFrom HDFC Bank A/C *4321\nTo SWIGGY\nOn 10/11/26\nRef 631412345678\nNot You?\nCall 18002586161/SMS BLOCK UPI to 7308080808",
    expect: { kind: "debit", amount: "250.00", last4: "4321", payee: "SWIGGY", ref: "631412345678", date: "2026-11-10" },
  },
  {
    name: "hdfc upi received", note: PUBLIC, sender: "VM-HDFCBK", bank: "hdfc",
    body: "Money Received - INR 1,500.00 in your HDFC Bank A/c xx4321 on 09-11-26 by a/c linked to VPA rahul.k@okicici (UPI Ref No 631398765432).",
    expect: { kind: "credit", amount: "1500.00", last4: "4321", payee: "rahul.k@okicici", ref: "631398765432", date: "2026-11-09" },
  },
  {
    name: "hdfc card payment", note: PUBLIC, sender: "VM-HDFCBK", bank: "hdfc",
    body: "Payment of Rs. 15,000.00 has been received on your HDFC Bank Credit Card ending 7242 on 05-11-26. Thank you.",
    expect: { kind: "card_payment", amount: "15000.00", last4: "7242", payee: null, ref: null, date: "2026-11-05" },
  },
  {
    name: "hdfc card statement", note: PUBLIC, sender: "VM-HDFCBK", bank: "hdfc",
    body: "HDFC Bank Credit Card XX7242 Statement: Total Amt Due Rs.42,926.27, Min Amt Due Rs.2,150.00, Payment Due Date 15-12-26.",
    expect: { kind: "card_statement", amount: "42926.27", last4: "7242", payee: null, ref: null, date: "2026-11-12", dueDate: "2026-12-15" },
  },

  // State Bank of India
  {
    name: "sbi upi debit", note: PUBLIC, sender: "AD-SBIUPI-S", bank: "sbi",
    body: "Dear UPI user A/C X5678 debited by 20.0 on date 11Nov26 trf to ZOMATO LTD Refno 631587654321. If not u? call 1800111109. -SBI",
    expect: { kind: "debit", amount: "20.00", last4: "5678", payee: "ZOMATO LTD", ref: "631587654321", date: "2026-11-11" },
  },
  {
    name: "sbi upi credit", note: PUBLIC, sender: "AD-SBIUPI-S", bank: "sbi",
    body: "Dear SBI UPI User, ur A/cX5678 credited by Rs500 on 10Nov26 by (Ref no 631476543210)",
    expect: { kind: "credit", amount: "500.00", last4: "5678", payee: null, ref: "631476543210", date: "2026-11-10" },
  },
  {
    name: "sbi atm withdrawal", note: PUBLIC, sender: "VM-ATMSBI", bank: "sbi",
    body: "Dear Customer, Rs.2,000 withdrawn at SBI ATM S1NB000123045 from A/cX5678 on 08Nov26 Txn# 3456. Avl Bal Rs.10,250.50",
    expect: { kind: "debit", amount: "2000.00", last4: "5678", payee: "SBI ATM S1NB000123045", ref: null, date: "2026-11-08", balance: "10250.50" },
  },
  {
    name: "sbi reversal of a failed upi payment is a credit", note: PUBLIC, sender: "VM-SBIINB", bank: "sbi",
    body: "Rs.500.00 credited to your A/c XX5678 on 11-11-26 towards reversal of failed UPI txn Ref 631512340000. -SBI",
    expect: { kind: "credit", amount: "500.00", last4: "5678", payee: null, ref: "631512340000", date: "2026-11-11" },
  },

  // SBI Card
  {
    name: "sbi card spend", note: PUBLIC, sender: "VM-SBICRD", bank: "sbicard",
    body: "Rs.1,299.00 spent on your SBI Credit Card ending 3344 at AMAZON PAY on 07/11/26. Trxn. not done by you? Report at https://sbicard.com/Dispute",
    expect: { kind: "card_spend", amount: "1299.00", last4: "3344", payee: "AMAZON PAY", ref: null, date: "2026-11-07" },
  },
  {
    name: "sbi card statement", note: PUBLIC, sender: "VM-SBICRD", bank: "sbicard",
    body: "SBI Card ending 3344: Statement generated. Total Amount Due Rs 8,450.75. Min Amount Due Rs 423.00. Pay by 02-Dec-26.",
    expect: { kind: "card_statement", amount: "8450.75", last4: "3344", payee: null, ref: null, date: "2026-11-12", dueDate: "2026-12-02" },
  },
  {
    name: "sbi card payment", note: PUBLIC, sender: "VM-SBICRD", bank: "sbicard",
    body: "We have received payment of Rs.5,000.00 towards your SBI Credit Card ending 3344 on 03/11/26. Thank you.",
    expect: { kind: "card_payment", amount: "5000.00", last4: "3344", payee: null, ref: null, date: "2026-11-03" },
  },

  // ICICI Bank
  {
    name: "icici upi debit names the payee before 'credited'", note: PUBLIC, sender: "JM-ICICIB", bank: "icici",
    body: "ICICI Bank Acct XX123 debited for Rs 100.00 on 12-Nov-26; AMAZON credited. UPI:631612345678. Call 18002662 for dispute. SMS BLOCK 123 to 9215676766.",
    expect: { kind: "debit", amount: "100.00", last4: null, payee: "AMAZON", ref: "631612345678", date: "2026-11-12" },
  },
  {
    name: "icici upi credit", note: PUBLIC, sender: "JM-ICICIT", bank: "icici",
    body: "Dear Customer, Acct XX123 is credited with Rs 5,000.00 on 11-Nov-26 from RAHUL SHARMA. UPI:631598765432-ICICI Bank.",
    expect: { kind: "credit", amount: "5000.00", last4: null, payee: "RAHUL SHARMA", ref: "631598765432", date: "2026-11-11" },
  },
  {
    name: "icici card spend", note: PUBLIC, sender: "JM-ICICIB", bank: "icici",
    body: "INR 1,234.50 spent using ICICI Bank Card XX9012 on 10-Nov-26 on AMAZON. Avl Limit: INR 45,000.00. If not you, call 1800 2662/SMS BLOCK 9012 to 9215676766",
    expect: { kind: "card_spend", amount: "1234.50", last4: "9012", payee: "AMAZON", ref: null, date: "2026-11-10", balance: null },
  },
  {
    name: "icici card payment", note: PUBLIC, sender: "JM-ICICIB", bank: "icici",
    body: "Dear Customer, Payment of INR 10,000.00 has been received on your ICICI Bank Credit Card Account 4xxx9012 on 09-Nov-26. Thank you.",
    expect: { kind: "card_payment", amount: "10000.00", last4: "9012", payee: null, ref: null, date: "2026-11-09" },
  },

  // Axis Bank
  {
    name: "axis upi debit on separate lines", note: PUBLIC, sender: "VK-AXISBK-S", bank: "axis",
    body: "INR 100.00 debited\nA/c no. XX7788\n12-11-26, 10:15:32\nUPI/P2A/631612121212/PRIYA S\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank",
    expect: { kind: "debit", amount: "100.00", last4: "7788", payee: "PRIYA S", ref: "631612121212", date: "2026-11-12" },
  },
  {
    name: "axis upi credit", note: PUBLIC, sender: "VK-AXISBK-S", bank: "axis",
    body: "INR 2,500.00 credited\nA/c no. XX7788\n11-11-26, 18:20:11 IST\nUPI/P2A/631512121299/ANIL KUMAR\nNot you? SMS BLOCKUPI Cust ID to 919951860002\nAxis Bank",
    expect: { kind: "credit", amount: "2500.00", last4: "7788", payee: "ANIL KUMAR", ref: "631512121299", date: "2026-11-11" },
  },
  {
    name: "axis card spend", note: PUBLIC, sender: "VK-AXISBK-S", bank: "axis",
    body: "Spent INR 799.00\nAxis Bank Card no. XX4455\n10-11-26 20:01:13 IST\nNETFLIX\nAvl Limit: INR 52,100.00\nNot you? SMS BLOCK 4455 to 919951860002",
    expect: { kind: "card_spend", amount: "799.00", last4: "4455", payee: "NETFLIX", ref: null, date: "2026-11-10" },
  },
  {
    name: "axis card payment", note: PUBLIC, sender: "VK-AXISBK-S", bank: "axis",
    body: "Payment of INR 12,000.00 received towards your Axis Bank Credit Card XX4455 on 08-11-26. Thank you.",
    expect: { kind: "card_payment", amount: "12000.00", last4: "4455", payee: null, ref: null, date: "2026-11-08" },
  },

  // Kotak Mahindra Bank
  {
    name: "kotak upi sent", note: PUBLIC, sender: "BZ-KOTAKB", bank: "kotak",
    body: "Sent Rs.100.00 from Kotak Bank AC X9988 to merchant.store@okaxis on 12-11-26.UPI Ref 631623456789. Not you, https://kotak.com/KBANKT/Fraud",
    expect: { kind: "debit", amount: "100.00", last4: "9988", payee: "merchant.store@okaxis", ref: "631623456789", date: "2026-11-12" },
  },
  {
    name: "kotak upi received", note: PUBLIC, sender: "BZ-KOTAKB", bank: "kotak",
    body: "Received Rs.750.00 in your Kotak Bank AC X9988 from neha.v@oksbi on 11-11-26.UPI Ref:631534567890.",
    expect: { kind: "credit", amount: "750.00", last4: "9988", payee: "neha.v@oksbi", ref: "631534567890", date: "2026-11-11" },
  },
  {
    name: "kotak card spend", note: PUBLIC, sender: "BZ-KOTAKB", bank: "kotak",
    body: "Rs.350.00 spent on your Kotak Credit Card x2233 at SWIGGY on 09/11/2026. Avl limit Rs.47,650.00. Not you? Call 18602662666",
    expect: { kind: "card_spend", amount: "350.00", last4: "2233", payee: "SWIGGY", ref: null, date: "2026-11-09" },
  },

  // Bank of India
  {
    name: "boi upi credit", note: PUBLIC, sender: "JD-BOIIND", bank: "boi",
    body: "BOI - Rs.1,200.00 Credited to your Ac XX4721 on 10-11-26 by UPI ref No.631423456781.Avl Bal 25,000.00",
    expect: { kind: "credit", amount: "1200.00", last4: "4721", payee: null, ref: "631423456781", date: "2026-11-10", balance: "25000.00" },
  },

  // Bank of Baroda
  {
    name: "bob upi debit", note: PUBLIC, sender: "VM-BOBTXN", bank: "bob",
    body: "Rs.500.00 Dr. from A/C XXXXXX6789 and Cr. to swiggy@axisbank. Ref:631234560987. AvlBal:Rs10,000.00(2026:11:12 10:10:10). Not you? Call 18005700-BOB",
    expect: { kind: "debit", amount: "500.00", last4: "6789", payee: "swiggy@axisbank", ref: "631234560987", date: "2026-11-12", balance: "10000.00" },
  },
  {
    name: "bob upi credit", note: PUBLIC, sender: "VM-BOBSMS", bank: "bob", receivedAt: "2026-11-13T09:00:00+05:30",
    body: "Rs.2,000.00 Credited to A/c ...6789 thru UPI/631398761234 by rohit.m@okhdfcbank. Total Bal:Rs.12,000.00CR. Avlbl Amt:Rs.12,000.00(12-11-2026 09:30:00) - Bank of Baroda",
    expect: { kind: "credit", amount: "2000.00", last4: "6789", payee: "rohit.m@okhdfcbank", ref: "631398761234", date: "2026-11-12", balance: "12000.00" },
  },

  // Punjab National Bank
  {
    name: "pnb upi debit", note: PUBLIC, sender: "VM-PNBSMS", bank: "pnb",
    body: "Your A/c XX2468 has been debited by Rs.450.00 on 11-11-26 for UPI txn to BIGBASKET. Ref no. 631545678901. Avl Bal Rs.8,765.43 -PNB",
    expect: { kind: "debit", amount: "450.00", last4: "2468", payee: "BIGBASKET", ref: "631545678901", date: "2026-11-11", balance: "8765.43" },
  },
  {
    name: "pnb neft credit", note: PUBLIC, sender: "VM-PNBSMS", bank: "pnb",
    body: "Your A/c XX2468 is credited with INR 3,000.00 on 10-11-26 by NEFT from ACME PAYROLL. Ref no. N314260012345678. Avl Bal INR 11,765.43 -PNB",
    expect: { kind: "credit", amount: "3000.00", last4: "2468", payee: "ACME PAYROLL", ref: "N314260012345678", date: "2026-11-10", balance: "11765.43" },
  },

  // Canara Bank
  {
    name: "canara debit", note: PUBLIC, sender: "VM-CANBNK", bank: "canara",
    body: "An amount of INR 1,050.00 has been DEBITED to your account XXX1357 on 11/11/2026. Total Avail.bal INR 9,450.00. - Canara Bank",
    expect: { kind: "debit", amount: "1050.00", last4: "1357", payee: null, ref: null, date: "2026-11-11", balance: "9450.00" },
  },
  {
    name: "canara credit", note: PUBLIC, sender: "VM-CANBNK", bank: "canara",
    body: "An amount of INR 2,000.00 has been CREDITED to your account XXX1357 on 10/11/2026 towards UPI Ref 631498765012. Total Avail.bal INR 11,450.00. - Canara Bank",
    expect: { kind: "credit", amount: "2000.00", last4: "1357", payee: null, ref: "631498765012", date: "2026-11-10", balance: "11450.00" },
  },

  // Union Bank of India
  {
    name: "union debit", note: PUBLIC, sender: "VM-UNIONB", bank: "union",
    body: "A/c *3579 Debited for Rs:250.00 on 11-11-2026 10:22:03 by Mob Bk ref no 631534561234 Avl Bal Rs:5,250.00.Never Share OTP/PIN/CVV-Union Bank of India",
    expect: { kind: "debit", amount: "250.00", last4: "3579", payee: null, ref: "631534561234", date: "2026-11-11", balance: "5250.00" },
  },
  {
    name: "union credit", note: PUBLIC, sender: "VM-UNIONB", bank: "union",
    body: "A/c *3579 Credited for Rs:1,000.00 on 10-11-2026 09:12:45 by Mob Bk ref no 631423459876 Avl Bal Rs:6,250.00.Never Share OTP/PIN/CVV-Union Bank of India",
    expect: { kind: "credit", amount: "1000.00", last4: "3579", payee: null, ref: "631423459876", date: "2026-11-10", balance: "6250.00" },
  },

  // IDFC FIRST Bank
  {
    name: "idfc upi debit", note: PUBLIC, sender: "VM-IDFCFB", bank: "idfc",
    body: "Your A/C XXXXXXX1122 is debited by INR 350.00 on 12/11/26 for UPI payment to uber@axis. New balance: INR 4,650.00. UPI Ref No 631645678123. -IDFC FIRST Bank",
    expect: { kind: "debit", amount: "350.00", last4: "1122", payee: "uber@axis", ref: "631645678123", date: "2026-11-12", balance: "4650.00" },
  },
  {
    name: "idfc card spend", note: PUBLIC, sender: "VM-IDFCFB", bank: "idfc",
    body: "INR 640.00 spent on your IDFC FIRST Bank Credit Card ending XX6677 at ZEPTO on 11/11/2026 at 09:15 PM. Available Limit: INR 98,000.00",
    expect: { kind: "card_spend", amount: "640.00", last4: "6677", payee: "ZEPTO", ref: null, date: "2026-11-11" },
  },

  // YES BANK
  {
    name: "yes upi debit", note: PUBLIC, sender: "VM-YESBNK", bank: "yes",
    body: "INR 1,200.00 debited from YES BANK A/c XX5566 on 10-NOV-26 to VPA phonepemerchant@ybl. UPI Ref 631412398745. Avl Bal INR 3,300.00",
    expect: { kind: "debit", amount: "1200.00", last4: "5566", payee: "phonepemerchant@ybl", ref: "631412398745", date: "2026-11-10", balance: "3300.00" },
  },
  {
    name: "yes card transaction", note: PUBLIC, sender: "VM-YESBNK", bank: "yes",
    body: "Transaction of INR 2,999.00 done on YES BANK Credit Card XX8899 at FLIPKART on 09-11-2026. Avl Lmt: INR 57,001.00",
    expect: { kind: "card_spend", amount: "2999.00", last4: "8899", payee: "FLIPKART", ref: null, date: "2026-11-09" },
  },

  // IndusInd Bank
  {
    name: "indusind upi debit", note: PUBLIC, sender: "VM-INDUSB", bank: "indusind",
    body: "Your IndusInd Bank A/C XX3344 is debited for INR 560.00 towards UPI/631534567812/FRESHMART on 11-11-26. Avl Bal: INR 9,440.00",
    expect: { kind: "debit", amount: "560.00", last4: "3344", payee: "FRESHMART", ref: "631534567812", date: "2026-11-11", balance: "9440.00" },
  },
  {
    name: "indusind card spend", note: PUBLIC, sender: "VM-INDUSB", bank: "indusind",
    body: "INR 450.00 spent on IndusInd Credit Card XX1199 at DOMINOS PIZZA on 10/11/2026 20:45:10. Avl Lmt INR 1,20,000.00. Call 18602677777 if not done by you.",
    expect: { kind: "card_spend", amount: "450.00", last4: "1199", payee: "DOMINOS PIZZA", ref: null, date: "2026-11-10" },
  },

  // Federal Bank (the owner's three samples are above)
  {
    name: "federal card statement", note: PUBLIC, sender: "AX-FEDBNK-S", bank: "federal",
    body: "Your Federal Bank Credit Card XX5530 statement is generated. Total amount due: Rs.4,912.40. Minimum amount due: Rs.250.00. Due date: 28-11-2026. -Federal Bank",
    expect: { kind: "card_statement", amount: "4912.40", last4: "5530", payee: null, ref: null, date: "2026-11-12", dueDate: "2026-11-28" },
  },
  {
    name: "federal card payment", note: PUBLIC, sender: "AX-FEDBNK-S", bank: "federal",
    body: "Payment of Rs.4,912.40 received for your Federal Bank Credit Card ending 5530 on 10-11-2026. Thank you -Federal Bank",
    expect: { kind: "card_payment", amount: "4912.40", last4: "5530", payee: null, ref: null, date: "2026-11-10" },
  },

  // CDSL (the owner's debit is above)
  {
    name: "cdsl credit", note: PUBLIC, sender: "CDSLTX", bank: "cdsl",
    body: "CDSL: Credit in a/c *00418277 for 50-INFOSYS LIMITED EQ FV RS.5 on 05NOV",
    expect: [{ kind: "demat", amount: null, last4: "8277", payee: "INFOSYS LIMITED", ref: "credit", date: "2026-11-05", isin: null, quantity: "50" }],
  },
  {
    name: "cdsl debit of two shares", note: PUBLIC, sender: "CDSLTX", bank: "cdsl",
    body: "CDSL: Debit in a/c *00418277 for 10-RELIANCE INDUSTRIES LTD EQ, 5-TATA CONSULTANCY SERV LT EQ RE.1/- on 10NOV",
    expect: [
      { kind: "demat", amount: null, last4: "8277", payee: "RELIANCE INDUSTRIES LTD", ref: "debit", date: "2026-11-10", quantity: "10" },
      { kind: "demat", amount: null, last4: "8277", payee: "TATA CONSULTANCY SERV LT", ref: "debit", date: "2026-11-10", quantity: "5" },
    ],
  },

  // NSDL
  {
    name: "nsdl debit with isin", note: PUBLIC, sender: "VM-NSDLDP", bank: "nsdl",
    body: "NSDL: Debit of 15 shares of ISIN INE009A01021 (INFOSYS LTD) from your demat a/c IN30xxxxxx4321 on 11-Nov-26",
    expect: [{ kind: "demat", amount: null, last4: "4321", payee: "INFOSYS LTD", ref: "debit", date: "2026-11-11", isin: "INE009A01021", quantity: "15" }],
  },
  {
    name: "nsdl credit of fund units", note: PUBLIC, sender: "VM-NSDLDP", bank: "nsdl",
    body: "NSDL: Credit of 20 units of INF846K01EW2 (AXIS BLUECHIP FUND - GROWTH) in your demat a/c IN30xxxxxx4321 on 10-11-2026",
    expect: [{ kind: "demat", amount: null, last4: "4321", payee: "AXIS BLUECHIP FUND - GROWTH", ref: "credit", date: "2026-11-10", isin: "INF846K01EW2", quantity: "20" }],
  },
  {
    name: "nsdl account debited with shares", note: PUBLIC, sender: "VM-NSDLDP", bank: "nsdl",
    body: "NSDL: Your demat a/c IN30xxxxxx4321 has been debited with 5 shares of ISIN INE467B01029 (TATA CONSULTANCY SERVICES LTD) on 09NOV2026",
    expect: [{ kind: "demat", amount: null, last4: "4321", payee: "TATA CONSULTANCY SERVICES LTD", ref: "debit", date: "2026-11-09", isin: "INE467B01029", quantity: "5" }],
  },

  // Messages that are not transactions
  {
    name: "otp for a card payment", note: PUBLIC, sender: "VM-HDFCBK", bank: "hdfc",
    body: "123456 is your OTP for txn of Rs 2,500.00 at AMAZON on HDFC Bank card ending 7242. Valid till 10:15. Do not share OTP for security reasons",
    expect: "ignore",
  },
  {
    name: "otp for login", note: PUBLIC, sender: "VM-SBIINB", bank: "sbi",
    body: "Your OTP for login to SBI YONO is 482913. Do not share it with anyone.",
    expect: "ignore",
  },
  {
    name: "pre-approved loan promotion", note: PUBLIC, sender: "VM-HDFCBK", bank: "hdfc",
    body: "Pre-approved Personal Loan of Rs 5,00,000 is ready for you! Amount credited in 10 seconds. Apply now: http://hdfc.bank.in/pl T&C",
    expect: "ignore",
  },
  {
    name: "cashback promotion", note: PUBLIC, sender: "JM-ICICIB", bank: "icici",
    body: "Get upto 10% cashback on your ICICI Bank Credit Card. Shop now at amazon.in. T&C apply",
    expect: "ignore",
  },
  {
    name: "declined card transaction", note: PUBLIC, sender: "VK-AXISBK", bank: "axis",
    body: "Your transaction of INR 2,000.00 on Axis Bank Card XX4455 at MYNTRA was declined due to insufficient balance.",
    expect: "ignore",
  },
  {
    name: "failed upi payment", note: PUBLIC, sender: "AD-SBIUPI", bank: "sbi",
    body: "UPI transaction of Rs.500.00 from A/c XX5678 to ZOMATO failed. Amount if debited will be refunded within 48 hrs. -SBI",
    expect: "ignore",
  },
  {
    name: "balance alert", note: PUBLIC, sender: "VM-PNBSMS", bank: "pnb",
    body: "Available balance in your A/c XX2468 as on 11-11-26 is Rs.8,765.43. -PNB",
    expect: "ignore",
  },
  {
    name: "card loan offer", note: PUBLIC, sender: "BZ-KOTAKB", bank: "kotak",
    body: "Dear Customer, you are eligible for an instant loan of up to Rs 2,00,000 on your Kotak Credit Card. Click https://kotak.com/l to avail.",
    expect: "ignore",
  },
  {
    name: "mandate that will debit later", note: PUBLIC, sender: "VM-HDFCBK", bank: "hdfc",
    body: "Rs.499.00 will be debited from your A/c XX4321 on 15-11-26 towards NETFLIX mandate. -HDFC Bank",
    expect: "ignore",
  },
  {
    name: "upi collect request", note: PUBLIC, sender: "AD-SBIUPI", bank: "sbi",
    body: "rahul@okicici has requested money from you. On approving, Rs.200.00 will be debited from your account. -SBI",
    expect: "ignore",
  },
  {
    name: "declined federal card", note: PUBLIC, sender: "AX-FEDBNK", bank: "federal",
    body: "Txn of INR 1,000.00 on your Federal Bank card ending 5530 at XYZ STORE was declined. -Federal Bank",
    expect: "ignore",
  },
  {
    name: "cdsl tpin message", note: PUBLIC, sender: "CDSLTX", bank: "cdsl",
    body: "CDSL: Your OTP for e-DIS authorisation is 739201. Do not share it with anyone.",
    expect: "ignore",
  },

  // Says money moved, but in a shape nothing reads
  {
    name: "unknown wording with a bare amount", sender: "VM-ACMEBK", bank: "acme",
    body: "ACME Bank: a/c XX1234 debited. Amt 1,250.00. Bal 9,000.00",
    expect: "unreadable",
  },
];
