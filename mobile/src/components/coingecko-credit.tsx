import { Linking, StyleSheet } from "react-native";
import { Text } from "react-native-paper";

import { BRAND } from "@/lib/theme";

// CoinGecko's free API plan requires this credit wherever its crypto prices are shown.
export function CoinGeckoCredit() {
  return (
    <Text
      variant="bodySmall"
      style={styles.credit}
      accessibilityRole="link"
      accessibilityLabel="Crypto prices by CoinGecko. Opens coingecko.com"
      onPress={() => void Linking.openURL("https://www.coingecko.com/")}
    >
      Crypto prices by <Text style={styles.link}>CoinGecko</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  credit: { color: BRAND.zinc600, paddingVertical: 12, textAlign: "center" },
  link: { textDecorationLine: "underline", fontWeight: "700" },
});
