import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Text, useTheme } from "react-native-paper";

import { HeaderAction, ScreenHeader } from "@/components/chunky";
import { TransactionsList } from "@/components/transactions-list";

export default function TransactionsScreen() {
  const { colors } = useTheme();
  const [choosing, setChoosing] = useState(false);
  const navigating = useRef(false);

  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
    }, []),
  );

  // Drops a second push from a double tap until the screen regains focus.
  const go = (target: Parameters<typeof router.push>[0]) => {
    setChoosing(false);
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader
        title="Transactions"
        right={<HeaderAction icon="tray-arrow-down" label="Import transactions" onPress={() => setChoosing(true)} />}
      />
      <TransactionsList />
      <Portal>
        <Dialog visible={choosing} onDismiss={() => setChoosing(false)}>
          <Dialog.Title>Import</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              A statement from any bank or card (CSV, Excel or PDF), or your own Excel file made from the template.
              You check everything before it is saved.
            </Text>
          </Dialog.Content>
          <Dialog.Actions style={styles.actions}>
            <Button mode="contained" icon="bank-outline" onPress={() => go("/statement-import")} style={styles.choice}>
              Bank or card statement
            </Button>
            <Button
              mode="outlined"
              icon="file-excel-outline"
              onPress={() => go({ pathname: "/excel-import", params: { kind: "transactions" } })}
              style={styles.choice}
            >
              Excel file
            </Button>
            <Button onPress={() => setChoosing(false)}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  actions: { flexDirection: "column", alignItems: "stretch" },
  choice: { marginBottom: 8 },
});
