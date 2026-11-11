import { type StyleProp, type TextStyle } from "react-native";
import { Text } from "react-native-paper";

import { formatPercent, formatSigned, tone } from "@/lib/investments";
import { TONE_COLORS } from "@/lib/theme";

const TONE_WORD = { gain: "gain", loss: "loss", flat: "no change" } as const;

type Props = {
  value: string;
  percent?: boolean;
  variant?: React.ComponentProps<typeof Text>["variant"];
  style?: StyleProp<TextStyle>;
};

// What a screen reader says for a profit or loss, like "+₹1,234.50 gain". Rows that are a single
// accessibility node put this in their own label, since Android reads only that.
export function signedLabel(value: string, percent = false): string {
  return `${percent ? formatPercent(value) : formatSigned(value)} ${TONE_WORD[tone(value)]}`;
}

// A profit or loss: always signed, green or red, and named for screen readers, so colour is
// never the only signal.
export function Signed({ value, percent = false, variant = "bodyMedium", style }: Props) {
  const t = tone(value);
  const text = percent ? formatPercent(value) : formatSigned(value);
  const color = t === "flat" ? undefined : TONE_COLORS[t];
  return (
    <Text variant={variant} accessibilityLabel={signedLabel(value, percent)} style={[{ fontVariant: ["tabular-nums"] }, color ? { color } : null, style]}>
      {text}
    </Text>
  );
}
