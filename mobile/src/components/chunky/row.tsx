import type { ReactNode } from "react";
import { Pressable, Text as NativeText, StyleSheet, View, type AccessibilityActionEvent, type AccessibilityActionInfo } from "react-native";
import { Text } from "react-native-paper";

import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

import { ChunkyBox, TONE_SQUARE, type Tone } from "./chunky-box";

type Props = {
  emoji: string;
  tone: Tone;
  title: string;
  meta?: ReactNode; // lines under the title
  amount?: string;
  amountTone?: "gain" | "loss";
  caption?: string; // a small word above the amount, like "Owed"
  sub?: ReactNode; // lines under the amount
  highlight?: boolean; // a due-yellow row
  onPress?: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  // A tappable row is one accessibility node, so it speaks this instead of its pieces.
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityActions?: AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  children?: ReactNode; // below the main line, like a row of actions
};

const AMOUNT_COLOR = { gain: BRAND.gain, loss: BRAND.loss } as const;

// A list row: an emoji square, a title with detail lines, and an amount on the right. The amount
// column takes up to 55% and wraps, so a 13 digit figure never clips or runs under the title.
export function Row({
  emoji,
  tone,
  title,
  meta,
  amount,
  amountTone,
  caption,
  sub,
  highlight = false,
  onPress,
  onLongPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  accessibilityActions,
  onAccessibilityAction,
  children,
}: Props) {
  const content = (pressed: boolean) => (
    <ChunkyBox
      pressed={pressed}
      radius={INPUT_RADIUS}
      offset={SHADOW_OFFSET_SM}
      style={[styles.box, highlight ? { backgroundColor: BRAND.due } : null]}
    >
      <View style={styles.line}>
        <View style={[styles.square, { backgroundColor: TONE_SQUARE[tone] }]}>
          <NativeText
            style={styles.emoji}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {emoji}
          </NativeText>
        </View>
        <View style={styles.main}>
          <Text variant="titleMedium" style={styles.title}>
            {title}
          </Text>
          {meta ? <View style={styles.lines}>{typeof meta === "string" ? <Text variant="bodySmall" style={styles.meta}>{meta}</Text> : meta}</View> : null}
        </View>
        {amount !== undefined || caption || sub ? (
          <View style={styles.amounts}>
            {caption ? (
              <Text variant="labelSmall" style={styles.meta}>
                {caption}
              </Text>
            ) : null}
            {amount !== undefined ? (
              <Text
                variant="titleMedium"
                style={[styles.amount, amountTone ? { color: AMOUNT_COLOR[amountTone] } : null]}
              >
                {amount}
              </Text>
            ) : null}
            {sub ? <View style={styles.subLines}>{typeof sub === "string" ? <Text variant="bodySmall" style={[styles.meta, styles.right]}>{sub}</Text> : sub}</View> : null}
          </View>
        ) : null}
      </View>
      {children}
    </ChunkyBox>
  );

  if (!onPress && !onLongPress) {
    return <View accessible={accessibilityLabel ? true : undefined} accessibilityLabel={accessibilityLabel}>{content(false)}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityActions={accessibilityActions}
      onAccessibilityAction={onAccessibilityAction}
      accessibilityState={{ disabled }}
    >
      {({ pressed }) => content(pressed && !disabled)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 12, paddingVertical: 10 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  square: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: { fontSize: 18, lineHeight: 24 },
  main: { flex: 1, minWidth: 0 },
  title: { color: BRAND.ink, fontSize: 16, lineHeight: 22 },
  lines: { gap: 1 },
  meta: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  amounts: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  amount: { color: BRAND.ink, fontSize: 16, lineHeight: 22, textAlign: "right", fontVariant: ["tabular-nums"] },
  subLines: { alignItems: "flex-end" },
  right: { textAlign: "right" },
});
