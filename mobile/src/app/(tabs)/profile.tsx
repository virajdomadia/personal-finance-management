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
        title="Log out"
        left={(props) => <List.Icon {...props} icon="logout" />}
        onPress={logOut}
        accessibilityRole="button"
      />
    </View>
  );
}
