import { StyleSheet, View } from "react-native";
import Svg, { Circle, Ellipse, Path, Rect } from "react-native-svg";

import { BRAND } from "@/lib/theme";

// The Gullak mark on its yellow tile; the same drawing as the website.
// Pass `decorative` when the word "Gullak" is shown beside it, so it is not read twice.
export function Logo({ size, decorative = false }: { size: number; decorative?: boolean }) {
  const mark = size * 0.62;
  return (
    <View
      {...(decorative
        ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" as const }
        : { accessible: true, accessibilityRole: "image" as const, accessibilityLabel: "Gullak" })}
      style={[styles.tile, { width: size, height: size, borderRadius: size * 0.22 }]}
    >
      <Svg viewBox="20 6 80 102" width={mark} height={mark}>
        <Ellipse cx="60" cy="74" rx="34" ry="28" fill={BRAND.orange} stroke={BRAND.ink} strokeWidth="5" />
        <Rect x="44" y="40" width="32" height="12" rx="5" fill={BRAND.orange} stroke={BRAND.ink} strokeWidth="5" />
        <Rect x="50" y="62" width="20" height="6" rx="3" fill={BRAND.ink} />
        <Circle cx="60" cy="24" r="11" fill={BRAND.green} stroke={BRAND.ink} strokeWidth="5" />
        <Path d="M40 84 q20 10 40 0" fill="none" stroke={BRAND.ink} strokeWidth="4" strokeLinecap="round" opacity={0.35} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    backgroundColor: BRAND.yellow,
    flexShrink: 0,
  },
});
