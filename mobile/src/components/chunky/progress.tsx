import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "react-native-paper";
import Svg, { Circle } from "react-native-svg";

import { BRAND } from "@/lib/theme";

function clamp(percent: number | null): { value: number; width: number } {
  const value = Math.round(percent ?? 0);
  return { value, width: Math.max(0, Math.min(value, 100)) };
}

// Saved against the target. The bar stops at full; the text beside it says when a goal is past 100%.
export function ProgressBar({
  percent,
  reached,
  label,
  warn = false,
  style,
}: {
  percent: number | null;
  reached: boolean;
  label: string;
  warn?: boolean; // a pink fill, for a bar that is filling up in a bad way
  style?: StyleProp<ViewStyle>;
}) {
  const { value, width } = clamp(percent);
  const fill = warn ? BRAND.pinkStrong : reached ? BRAND.greenStrong : BRAND.green;
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: width, text: reached ? `${value}%, reached` : `${value}%` }}
      style={[styles.track, style]}
    >
      <View
        style={[
          styles.fill,
          { width: `${width}%`, backgroundColor: fill },
          width > 0 && width < 100 ? styles.edge : null,
        ]}
      />
    </View>
  );
}

const RADIUS = 36;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// A round progress dial, like ProgressBar but for the goal tiles.
export function Ring({
  percent,
  reached,
  label,
  size = 110,
}: {
  percent: number | null;
  reached: boolean;
  label: string;
  size?: number;
}) {
  const { value, width } = clamp(percent);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: width,
        text: percent === null ? "No target" : reached ? `${value}%, reached` : `${value}%`,
      }}
      style={{ width: size, height: size + 4, flexShrink: 0 }}
    >
      <View style={[styles.ringShadow, { width: size, height: size, borderRadius: size / 2 }]} />
      <View style={{ width: size, height: size }}>
        <Svg viewBox="0 0 100 100" width={size} height={size}>
          <Circle cx="50" cy="50" r="47" fill="#FFFFFF" stroke={BRAND.ink} strokeWidth="3" />
          <Circle cx="50" cy="50" r={RADIUS} fill="none" stroke={BRAND.zinc200} strokeWidth="11" />
          {width > 0 ? (
            <Circle
              cx="50"
              cy="50"
              r={RADIUS}
              fill="none"
              stroke={reached ? BRAND.greenStrong : BRAND.green}
              strokeWidth="11"
              strokeDasharray={`${(width / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              rotation={-90}
              origin="50, 50"
            />
          ) : null}
          <Circle cx="50" cy="50" r="41.5" fill="none" stroke={BRAND.ink} strokeWidth="2.5" />
          <Circle cx="50" cy="50" r="30.5" fill="#FFFFFF" stroke={BRAND.ink} strokeWidth="2.5" />
        </Svg>
        <View style={styles.ringText} pointerEvents="none">
          <Text
            variant="titleLarge"
            style={{ color: BRAND.ink, fontVariant: ["tabular-nums"], fontSize: Math.max(11, size * 0.18) }}
          >
            {percent === null ? "–" : `${value}%`}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 18,
    width: "100%",
    overflow: "hidden",
    borderRadius: 999,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    backgroundColor: BRAND.zinc200,
  },
  fill: { height: "100%" },
  edge: { borderRightWidth: 2, borderRightColor: BRAND.ink },
  ringShadow: { position: "absolute", top: 4, left: 0, backgroundColor: BRAND.ink },
  ringText: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
});
