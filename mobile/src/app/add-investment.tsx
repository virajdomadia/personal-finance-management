import { router } from "expo-router";
import { useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Row, ScreenHeader, type Tone } from "@/components/chunky";
import { accountEmoji, investmentEmoji } from "@/lib/fun";
import { BRAND } from "@/lib/theme";

type Choice = {
  title: string;
  text: string;
  emoji: string;
  tone: Tone;
  // The next step: the trade form for a first purchase, the account form for a deposit, or the SIP form.
  next: Parameters<typeof router.replace>[0];
};

const CHOICES: Choice[] = [
  {
    title: "Stock",
    text: "Shares held with a broker",
    emoji: investmentEmoji("stock"),
    tone: "blue",
    next: { pathname: "/trade-form", params: { kind: "stock", mode: "buy", new: "1" } },
  },
  {
    title: "Mutual fund",
    text: "A lump sum, or units you already hold",
    emoji: investmentEmoji("mutual_fund"),
    tone: "blue",
    next: { pathname: "/trade-form", params: { kind: "mutual_fund", mode: "buy", new: "1" } },
  },
  {
    title: "Crypto",
    text: "Coins on an exchange",
    emoji: investmentEmoji("crypto"),
    tone: "blue",
    next: { pathname: "/trade-form", params: { kind: "crypto", mode: "buy", new: "1" } },
  },
  {
    title: "PPF",
    text: "Public Provident Fund account",
    emoji: accountEmoji("ppf"),
    tone: "orange",
    next: { pathname: "/account-form", params: { type: "ppf" } },
  },
  {
    title: "Recurring deposit",
    text: "A monthly RD at a bank or post office",
    emoji: accountEmoji("rd"),
    tone: "orange",
    next: { pathname: "/account-form", params: { type: "rd" } },
  },
  {
    title: "Start a SIP",
    text: "Before its first instalment. Each month it shows as due.",
    emoji: "🗓️",
    tone: "purple",
    next: { pathname: "/sip-form" },
  },
];

// Add investment, step 1: what kind. The step it opens takes this screen's place, so saving there (or
// going back) returns to the Investments tab. That step picks or creates the stock, fund or coin, with
// the live-price search, and records its first purchase in the same save.
export default function AddInvestmentScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const leaving = useRef(false);

  const pick = (choice: Choice) => {
    // A double tap would replace twice.
    if (leaving.current) return;
    leaving.current = true;
    router.replace(choice.next);
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Add investment" back />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <Text variant="bodyLarge" style={{ color: BRAND.zinc600 }}>
          What are you adding?
        </Text>
        {CHOICES.map((choice) => (
          <Row
            key={choice.title}
            emoji={choice.emoji}
            tone={choice.tone}
            title={choice.title}
            meta={choice.text}
            onPress={() => pick(choice)}
            accessibilityLabel={`${choice.title}. ${choice.text}`}
            accessibilityHint="Opens the next step"
          />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 16, gap: 12 },
});
