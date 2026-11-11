import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { ChunkyBox, TONE_BG, TONE_FG, type Tone } from "./chunky-box";
import { Sticker } from "./sticker";

type Props = {
  tone?: Tone;
  emoji?: string;
  label: string;
  value?: ReactNode;
  size?: "md" | "huge";
  sticker?: string | null;
  onPress?: () => void;
  children?: ReactNode;
};

// A stat tile: a label, a big figure, and an optional tilted sticker. With onPress it is a button.
export function Tile({ tone = "card", emoji, label, value, size = "md", sticker, onPress, children }: Props) {
  const fg = TONE_FG[tone];
  const hasValue = value !== undefined && value !== null;
  const body = (pressed: boolean) => (
    <ChunkyBox pressed={pressed} style={[styles.box, { backgroundColor: TONE_BG[tone] }]}>
      {sticker ? <Sticker text={sticker} /> : null}
      <Text variant="labelMedium" style={[styles.label, sticker ? styles.stickerGap : null, { color: fg }]}>
        {emoji ? `${emoji} ` : ""}
        {label}
      </Text>
      {hasValue ? (
        typeof value === "string" || typeof value === "number" ? (
          <Text
            variant="titleLarge"
            style={[
              styles.value,
              size === "huge" ? styles.huge : styles.md,
              sticker ? styles.stickerGap : null,
              { color: fg },
            ]}
          >
            {value}
          </Text>
        ) : (
          <View style={styles.valueNode}>{value}</View>
        )
      ) : null}
      {children}
    </ChunkyBox>
  );

  if (!onPress) return <View style={styles.wrap}>{body(false)}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={typeof value === "string" || typeof value === "number" ? `${label}, ${value}` : label}
      style={styles.wrap}
    >
      {({ pressed }) => body(pressed)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { minWidth: 0 },
  box: { padding: 14 },
  label: { fontSize: 12, lineHeight: 16 },
  value: { fontVariant: ["tabular-nums"], marginTop: 2, flexShrink: 1 },
  md: { fontSize: 22, lineHeight: 28 },
  huge: { fontSize: 34, lineHeight: 40 },
  stickerGap: { paddingRight: 56 },
  valueNode: { marginTop: 2 },
});
