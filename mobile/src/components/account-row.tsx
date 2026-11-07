import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text, TouchableRipple, useTheme } from "react-native-paper";

import { type Account, TYPE_LABELS, formatRupees, maskLast4 } from "@/lib/accounts";

function detailLine(account: Account, showType: boolean): string {
  const parts: string[] = [];
  if (showType) parts.push(TYPE_LABELS[account.type]);
  if (account.institution && account.institution !== account.name) parts.push(account.institution);
  if (account.bank_kind) parts.push(account.bank_kind.charAt(0).toUpperCase() + account.bank_kind.slice(1));
  if (account.last4) parts.push(maskLast4(account.last4));
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
  const owed = account.type === "credit_card";
  const detail = detailLine(account, showType);
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
          </View>
          <View style={styles.amounts}>
            {owed ? (
              <Text variant="labelSmall" style={{ color: colors.onSurfaceVariant }}>
                Owed
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
