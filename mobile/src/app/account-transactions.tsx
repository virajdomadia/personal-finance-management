import { router, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { Appbar, useTheme } from "react-native-paper";

import { TransactionsList } from "@/components/transactions-list";

export default function AccountTransactionsScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={name ?? "Transactions"} />
      </Appbar.Header>
      <TransactionsList fixedAccountId={Number(id)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
