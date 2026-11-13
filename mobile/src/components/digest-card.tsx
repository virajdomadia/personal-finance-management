import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "react-native-paper";

import { ChunkyBox } from "@/components/chunky";
import { ApiError, apiFetch } from "@/lib/api";
import { DIGEST_PATH, type Digest, changeBadge, changeTone, dueSummary, hiddenKey, riskSummary, weekRange } from "@/lib/digest";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

const BADGE = { more: BRAND.pinkStrong, less: BRAND.greenStrong, same: BRAND.zinc600 } as const;

function isHidden(d: Digest): boolean {
  try {
    return SecureStore.getItem(hiddenKey(d.user_id, d.week_start)) !== null;
  } catch {
    return false;
  }
}

// "Your week" on the dashboard: the server's headline, spent against the usual, and one line each
// for budgets at risk and what's due. Tapping opens the digest screen. The server's default week
// turns over on Sunday at 6 pm, so a new card appears each Sunday evening until it is hidden for
// that week. It hides on any error: the dashboard never waits on it. `refreshKey` changes whenever
// the dashboard reloads, and the card fetches again with it.
export function DigestCard({ refreshKey }: { refreshKey: number }) {
  const { token, logOut } = useSession();
  const [data, setData] = useState<Digest | null>(null);
  const [hidden, setHidden] = useState(true);
  const latest = useRef(0);

  useEffect(() => {
    const mine = ++latest.current;
    apiFetch<Digest>(DIGEST_PATH, { token: token ?? undefined }).then(
      (result) => {
        if (mine !== latest.current) return;
        setData(result);
        setHidden(isHidden(result));
      },
      (err: unknown) => {
        if (mine !== latest.current) return;
        if (err instanceof ApiError && err.status === 401) void logOut();
      },
    );
  }, [token, logOut, refreshKey]);

  if (data === null || hidden) return null;

  const hide = () => {
    try {
      SecureStore.setItem(hiddenKey(data.user_id, data.week_start), "1");
    } catch {
      // Not remembered; it still goes away until the app restarts.
    }
    setHidden(true);
  };

  const badge = changeBadge(data.change);
  const risky = data.budgets.at_risk.length > 0;

  return (
    <View>
      <Pressable
        onPress={() => router.push("/digest")}
        accessibilityRole="button"
        accessibilityLabel={`Your week. ${data.headline} ${riskSummary(data)}. ${dueSummary(data)}.`}
        accessibilityHint="Opens your weekly summary"
      >
        {({ pressed }) => (
          <ChunkyBox pressed={pressed} style={styles.box}>
            <View style={styles.head}>
              <Text variant="labelMedium" style={styles.label}>
                🗞️ Your week · {weekRange(data.week_start, data.through)}
              </Text>
              <Icon source="chevron-right" size={20} color="#FFFFFF" />
            </View>
            <Text variant="titleMedium" style={styles.headline}>
              {data.headline}
            </Text>
            {badge ? (
              <View style={[styles.badge, { backgroundColor: BADGE[changeTone(data.change)] }]}>
                <Text variant="labelMedium" style={styles.label}>
                  {badge}
                </Text>
              </View>
            ) : null}
            <View style={styles.lines}>
              <Text variant="bodySmall" style={[styles.label, risky ? styles.strong : null]}>
                {risky ? "⚠️ " : "✅ "}
                {riskSummary(data)}
              </Text>
              <Text variant="bodySmall" style={styles.label}>
                📅 {dueSummary(data)}
              </Text>
            </View>
          </ChunkyBox>
        )}
      </Pressable>
      <Pressable
        onPress={hide}
        accessibilityRole="button"
        accessibilityLabel="Hide this week's summary"
        hitSlop={8}
        style={styles.hide}
      >
        <Text variant="labelMedium" style={styles.hideText}>
          Hide for this week
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: 14, gap: 6, backgroundColor: BRAND.purpleStrong },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { color: "#FFFFFF", fontSize: 12, lineHeight: 16 },
  strong: { fontWeight: "800" },
  headline: { color: "#FFFFFF", fontSize: 18, lineHeight: 24 },
  badge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 2,
    borderColor: BRAND.ink,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  lines: { gap: 2, marginTop: 2 },
  hide: { alignSelf: "flex-end", paddingVertical: 6, paddingHorizontal: 4, minHeight: 32, justifyContent: "center" },
  hideText: { color: BRAND.zinc600, textDecorationLine: "underline" },
});
