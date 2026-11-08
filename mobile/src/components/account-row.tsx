import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text, TouchableRipple, useTheme } from "react-native-paper";

import {
  type Account,
  OWED_TYPES,
  TYPE_LABELS,
  formatDueDate,
  formatRupees,
  maskLast4,
  nextDueDate,
} from "@/lib/accounts";
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

type Props = {
  account: Account;
  onPress?: () => void;
  showType?: boolean;
  action?: ReactNode;
};

// Amounts sit in a column that may take up to 55% of the row and wrap, so a 13-digit figure never
// clips or runs under the name.
export function AccountRow({ account, onPress, showType = false, action }: Props) {
  const { colors } = useTheme();
  const owed = OWED_TYPES.has(account.type);
  const paidOff = account.type === "loan" && account.balance === "0.00";
  const detail = detailLine(account, showType);
  const loan = loanLine(account);
  const amount = formatRupees(account.balance);
  const available = owed && account.available_credit !== null ? formatRupees(account.available_credit) : null;

  return (
    <TouchableRipple
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${account.name}, ${owed ? "owed" : "balance"} ${amount}`}
    >
      <View>
        <View style={styles.row}>
          <View style={styles.main}>
            <Text variant="titleMedium">{account.name}</Text>
            {detail ? (
              <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                {detail}
              </Text>
            ) : null}
            {loan ? (
              <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                {loan}
              </Text>
            ) : null}
          </View>
          <View style={styles.amounts}>
            {owed ? (
              <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
                {paidOff ? "Paid off" : "Owed"}
              </Text>
            ) : null}
            <Text variant="titleMedium" style={styles.amount}>
              {amount}
            </Text>
            {available ? (
              <Text variant="bodySmall" style={[styles.amount, { color: colors.onSurfaceVariant }]}>
                Available {available}
              </Text>
            ) : null}
          </View>
        </View>
        {action ? <View style={styles.action}>{action}</View> : null}
      </View>
    </TouchableRipple>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  main: {
    flex: 1,
    gap: 2,
  },
  amounts: {
    flexShrink: 1,
    maxWidth: "55%",
    alignItems: "flex-end",
  },
  amount: {
    textAlign: "right",
  },
  action: {
    alignItems: "flex-end",
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
});
