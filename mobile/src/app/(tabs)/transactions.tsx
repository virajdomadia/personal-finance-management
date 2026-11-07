import { StyleSheet, View } from "react-native";
import { Appbar } from "react-native-paper";

import { TransactionsList } from "@/components/transactions-list";

export default function TransactionsScreen() {
  return (
    <View style={styles.screen}>
      <Appbar.Header>
        <Appbar.Content title="Transactions" />
      </Appbar.Header>
      <TransactionsList />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
