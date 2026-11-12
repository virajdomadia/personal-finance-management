import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "react-native-paper";

import { ChunkyBox } from "@/components/chunky";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";
import { SAFE_TO_SPEND_PATH, type SafeToSpend, isShort, safeText, untilText } from "@/lib/upcoming";

// The dashboard's safe to spend: the server's figure and until when, opening the breakdown, with a
// small link to the next 30 days under it. It loads itself and hides when it can't, so the
// dashboard never waits on it.
export function SafeToSpendCard() {
  const { token, logOut } = useSession();
  const [data, setData] = useState<SafeToSpend | null>(null);
  const latest = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const mine = ++latest.current;
      apiFetch<SafeToSpend>(SAFE_TO_SPEND_PATH, { token: token ?? undefined }).then(
        (result) => {
          if (mine === latest.current) setData(result);
        },
        (err: unknown) => {
          if (mine !== latest.current) return;
          if (err instanceof ApiError && err.status === 401) void logOut();
          // Anything else keeps what is shown, or nothing.
        },
      );
    }, [token, logOut]),
  );

  if (data === null) return null;

  const short = isShort(data.amount);
  const figure = safeText(data.amount);
  const until = untilText(data);

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => router.push("/safe-to-spend")}
        accessibilityRole="button"
        accessibilityLabel={`Safe to spend, ${figure}, ${until}`}
        accessibilityHint="Shows how it is worked out"
      >
        {({ pressed }) => (
          <ChunkyBox pressed={pressed} style={[styles.box, { backgroundColor: short ? BRAND.pinkStrong : BRAND.blueStrong }]}>
            <View style={styles.head}>
              <Text variant="labelMedium" style={styles.label}>
                🛟 Safe to spend
              </Text>
              <Icon source="chevron-right" size={20} color="#FFFFFF" />
            </View>
            <Text variant="titleLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5} style={styles.value}>
              {figure}
            </Text>
            <Text variant="bodySmall" style={styles.label}>
              {until}, after bills, goals and budgets
            </Text>
          </ChunkyBox>
        )}
      </Pressable>
      <Pressable
        onPress={() => router.push("/upcoming")}
        accessibilityRole="button"
        accessibilityLabel="Next 30 days"
        accessibilityHint="Lists what is due, with your balance after each"
      >
        {({ pressed }) => (
          <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.link}>
            <Text variant="labelLarge" style={styles.linkText}>
              📅 Next 30 days
            </Text>
            <Icon source="chevron-right" size={20} color={BRAND.ink} />
          </ChunkyBox>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  box: { padding: 14, gap: 4 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { color: "#FFFFFF", fontSize: 12, lineHeight: 16 },
  value: { color: "#FFFFFF", fontSize: 32, lineHeight: 38, fontVariant: ["tabular-nums"] },
  link: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 10 },
  linkText: { color: BRAND.ink },
});
