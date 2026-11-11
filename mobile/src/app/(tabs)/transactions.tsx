import { StyleSheet, View } from "react-native";
import { useTheme } from "react-native-paper";

import { ScreenHeader } from "@/components/chunky";
import { TransactionsList } from "@/components/transactions-list";

export default function TransactionsScreen() {
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Transactions" />
      <TransactionsList />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
