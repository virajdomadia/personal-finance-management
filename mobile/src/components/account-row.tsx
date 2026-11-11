import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { Row, type Tone } from "@/components/chunky";

import {
  type Account,
  OWED_TYPES,
  TYPE_LABELS,
  formatDueDate,
  formatRupees,
  headlineBalance,
  maskLast4,
  nextDueDate,
} from "@/lib/accounts";
import { depositLines } from "@/lib/deposits";
import { accountEmoji } from "@/lib/fun";
import { freeBalanceText, overSetAsideText } from "@/lib/goals";
import { BRAND } from "@/lib/theme";

import { GoalTagLine } from "./goal-tag";
import { todayIndia } from "@/lib/transactions";

function detailLine(account: Account, showType: boolean): string {
  const parts: string[] = [];
  if (showType) parts.push(TYPE_LABELS[account.type]);
  if (account.institution && account.institution !== account.name) parts.push(account.institution);
  if (account.bank_kind) parts.push(account.bank_kind.charAt(0).toUpperCase() + account.bank_kind.slice(1));
  if (account.last4) parts.push(maskLast4(account.last4));
  return parts.join(" · ");
}

function loanLine(account: Account): string {
  if (account.type !== "loan") return "";
  const parts: string[] = [];
  if (account.emi_amount) parts.push(`EMI ${formatRupees(account.emi_amount)}`);
  if (account.emis_left !== null) parts.push(`${account.emis_left} left`);
  if (account.due_day !== null && account.balance !== "0.00") {
    parts.push(`next ${formatDueDate(nextDueDate(account.due_day, todayIndia()))}`);
  }
  if (account.interest_rate !== null) parts.push(`${account.interest_rate}% a year`);
  return parts.join(" · ");
}

const TYPE_TONE: Record<Account["type"], Tone> = {
  bank: "blue",
  credit_card: "pink",
  cash: "green",
  broker: "purple",
  wallet: "yellow",
  ppf: "orange",
  rd: "orange",
  loan: "due",
};

type Props = {
  account: Account;
  onPress?: () => void;
  showType?: boolean;
  action?: ReactNode;
};

// Amounts sit in a column that may take up to 55% of the row and wrap, so a 13-digit figure never
// clips or runs under the name.
export function AccountRow({ account, onPress, showType = false, action }: Props) {
  const owed = OWED_TYPES.has(account.type);
  const paidOff = account.type === "loan" && account.balance === "0.00";
  const detail = detailLine(account, showType);
  const loan = loanLine(account);
  const deposit = depositLines(account);
  // The headline is what is free to spend: the balance less what goals have set aside here.
  const amount = formatRupees(headlineBalance(account));
  // Guarded so a response from before goals (no set-aside keys) still renders.
  const free = account.set_aside ? freeBalanceText(account) : null;
  const over = account.free_balance ? overSetAsideText(account) : null;
  const available = owed && account.available_credit !== null ? formatRupees(account.available_credit) : null;

  const meta = (
    <>
      <GoalTagLine tag={account.in_goal} />
      {detail ? <Text variant="bodySmall" style={styles.muted}>{detail}</Text> : null}
      {loan ? <Text variant="bodySmall" style={styles.muted}>{loan}</Text> : null}
      {deposit.map((line) => (
        <Text key={line} variant="bodySmall" style={styles.muted}>
          {line}
        </Text>
      ))}
      {over ? (
        <Text variant="bodySmall" style={styles.over}>
          {over}
        </Text>
      ) : null}
    </>
  );
  const sub =
    free || available ? (
      <>
        {free ? <Text variant="bodySmall" style={[styles.muted, styles.amount]}>{free}</Text> : null}
        {available ? <Text variant="bodySmall" style={[styles.muted, styles.amount]}>Available {available}</Text> : null}
      </>
    ) : undefined;

  return (
    <View style={styles.wrap}>
      <Row
        emoji={accountEmoji(account.type)}
        tone={TYPE_TONE[account.type]}
        title={account.name}
        meta={meta}
        caption={owed ? (paidOff ? "Paid off" : "Owed") : undefined}
        amount={amount}
        sub={sub}
        onPress={onPress}
        accessibilityLabel={`${account.name}, ${owed ? "owed" : free ? "free" : "balance"} ${amount}${free ? `. ${free}` : ""}${over ? `. ${over}` : ""}${account.in_goal ? `. For ${account.in_goal.name}` : ""}`}
      >
        {action ? <View style={styles.action}>{action}</View> : null}
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingVertical: 4 },
  muted: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  over: { color: BRAND.loss, fontSize: 12, lineHeight: 16 },
  amount: { textAlign: "right" },
  action: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: 8,
    paddingTop: 8,
  },
});
