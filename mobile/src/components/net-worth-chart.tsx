import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";
import Svg, { Circle, Polyline } from "react-native-svg";

import { ApiError, apiFetch } from "@/lib/api";
import { type NetWorthHistory, type NetWorthPoint, type NetWorthRange, changeSpoken, changeText, lineRuns } from "@/lib/net-worth";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

// The history for a range, loaded whenever the screen comes into focus. The request also writes
// today's snapshot on the server the first time each day. A failure keeps the last data.
export function useNetWorth(range: NetWorthRange) {
  const { token, logOut } = useSession();
  const [data, setData] = useState<NetWorthHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<NetWorthHistory>(`/net-worth?range=${range}`, { token: token ?? undefined });
      if (mine !== latest.current) return;
      setData(result);
      setFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setFailed(true);
    }
  }, [range, token, logOut]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return { data, failed, load };
}

type LineProps = {
  points: NetWorthPoint[];
  height: number;
  color: string; // the real line
  estimatedColor: string;
  dotFill?: string; // the hollow estimated dots' fill
  showDots?: boolean;
};

// The net worth line, drawn at its box's width: real stretches solid, estimated ones dashed with
// hollow dots, and today as a yellow dot.
export function NetWorthLine({ points, height, color, estimatedColor, dotFill = BRAND.card, showDots = false }: LineProps) {
  const [width, setWidth] = useState(0);
  const { dots, runs } = lineRuns(points, width, height, 8);
  const last = dots[dots.length - 1];
  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height }}>
      {width > 0 && last ? (
        <Svg width={width} height={height}>
          {runs.map((run, i) => (
            <Polyline
              key={i}
              points={run.points}
              fill="none"
              stroke={run.estimated ? estimatedColor : color}
              strokeWidth={run.estimated ? 3 : 3.5}
              strokeDasharray={run.estimated ? "6 5" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {showDots
            ? dots.map((d, i) =>
                d.estimated ? (
                  <Circle key={i} cx={d.x} cy={d.y} r={4} fill={dotFill} stroke={estimatedColor} strokeWidth={2.5} />
                ) : null,
              )
            : null}
          <Circle cx={last.x} cy={last.y} r={6} fill={BRAND.yellow} stroke={BRAND.ink} strokeWidth={2.5} />
        </Svg>
      ) : null}
    </View>
  );
}

// Under the dashboard's net worth: a year's sparkline and the change since last month. Tapping it
// opens the history. Hidden until it loads, and when there is nothing yet.
export function NetWorthTrend() {
  const { data } = useNetWorth("1y");
  if (data === null || data.points.length === 0) return null;
  const change = data.since_last_month;
  const text = changeText(change) ?? "Your trend starts today";
  return (
    <Pressable
      onPress={() => router.push("/net-worth")}
      accessibilityRole="button"
      accessibilityLabel={`Net worth trend, ${changeSpoken(change) ?? "your trend starts today"}`}
      accessibilityHint="Opens your net worth history"
      style={({ pressed }) => [styles.trend, pressed ? styles.pressed : null]}
    >
      {data.points.length > 1 ? (
        <NetWorthLine points={data.points} height={44} color="#FFFFFF" estimatedColor="rgba(255,255,255,0.75)" dotFill={BRAND.greenStrong} />
      ) : null}
      <View style={styles.pill}>
        <Text variant="labelMedium" style={styles.pillText}>
          {text} ›
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  trend: { marginTop: 8, gap: 6 },
  pressed: { opacity: 0.8 },
  pill: {
    alignSelf: "flex-start",
    backgroundColor: BRAND.card,
    borderColor: BRAND.ink,
    borderWidth: 2,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  pillText: { color: BRAND.ink, fontVariant: ["tabular-nums"] },
});
