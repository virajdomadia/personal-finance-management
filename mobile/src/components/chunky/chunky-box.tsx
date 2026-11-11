import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { BRAND, CHUNKY, SHADOW_OFFSET } from "@/lib/theme";

export type Tone = "card" | "green" | "yellow" | "pink" | "blue" | "purple" | "orange" | "due";

// Tiles that carry white text use the deeper shades (the same ones the website uses); yellow and due carry ink.
export const TONE_BG: Record<Tone, string> = {
  card: BRAND.card,
  green: BRAND.greenStrong,
  yellow: BRAND.yellow,
  pink: BRAND.pinkStrong,
  blue: BRAND.blueStrong,
  purple: BRAND.purpleStrong,
  orange: BRAND.orangeStrong,
  due: BRAND.due,
};

export const TONE_FG: Record<Tone, string> = {
  card: BRAND.ink,
  green: "#FFFFFF",
  yellow: BRAND.ink,
  pink: "#FFFFFF",
  blue: "#FFFFFF",
  purple: "#FFFFFF",
  orange: "#FFFFFF",
  due: BRAND.ink,
};

// Small emoji squares hold only an emoji, so they use the bright fills.
export const TONE_SQUARE: Record<Tone, string> = {
  card: BRAND.card,
  green: BRAND.green,
  yellow: BRAND.yellow,
  pink: BRAND.pink,
  blue: BRAND.blue,
  purple: BRAND.purple,
  orange: BRAND.orange,
  due: BRAND.due,
};

type Props = {
  // The visible box: padding, fill, direction. Defaults to a white card.
  style?: StyleProp<ViewStyle>;
  // The wrapper that takes part in the parent layout: flex, width, margins.
  containerStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
  // Pressed: the box moves down onto where its shadow was, and the shadow goes.
  pressed?: boolean;
  // No shadow and no movement, for a disabled control.
  flat?: boolean;
  radius?: number;
  offset?: number;
};

// An ink border and a hard offset shadow. Android has no offset shadows, so the shadow is an ink
// view behind the box, shifted down; the wrapper keeps room for it below.
export function ChunkyBox({
  style,
  containerStyle,
  children,
  pressed = false,
  flat = false,
  radius = CHUNKY.borderRadius,
  offset = SHADOW_OFFSET,
}: Props) {
  return (
    <View style={[{ marginBottom: offset }, containerStyle]}>
      {pressed || flat ? null : (
        <View pointerEvents="none" style={[styles.shadow, { top: offset, bottom: -offset, borderRadius: radius }]} />
      )}
      <View
        style={[
          {
            backgroundColor: BRAND.card,
            borderWidth: CHUNKY.borderWidth,
            borderColor: CHUNKY.borderColor,
            borderRadius: radius,
            transform: [{ translateY: pressed ? offset : 0 }],
          },
          style,
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: { position: "absolute", left: 0, right: 0, backgroundColor: BRAND.ink },
});
