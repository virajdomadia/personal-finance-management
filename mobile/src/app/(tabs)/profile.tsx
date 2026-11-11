import { router } from "expo-router";
import { View } from "react-native";
import { List } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useSession } from "@/lib/session";

export default function ProfileScreen() {
  const { logOut } = useSession();
  const { top } = useSafeAreaInsets();

  return (
    <View style={{ paddingTop: top }}>
      <List.Item
        title="Recurring"
        description="Rent, salary and other regular payments"
        left={(props) => <List.Icon {...props} icon="calendar-sync-outline" />}
        onPress={() => router.push("/recurring")}
        accessibilityRole="button"
      />
      <List.Item
        title="Insurance"
        description="Health policies and renewals"
        left={(props) => <List.Icon {...props} icon="shield-check-outline" />}
        onPress={() => router.push("/insurance")}
        accessibilityRole="button"
      />
      <List.Item
        title="Goals"
        description="Money set aside and holdings for what you're saving for"
        left={(props) => <List.Icon {...props} icon="flag-outline" />}
        onPress={() => router.push("/goals")}
        accessibilityRole="button"
      />
      <List.Item
        title="Log out"
        left={(props) => <List.Icon {...props} icon="logout" />}
        onPress={logOut}
        accessibilityRole="button"
      />
    </View>
  );
}
