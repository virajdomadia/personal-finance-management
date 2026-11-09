import { type StyleProp, type TextStyle } from "react-native";
import { Text, useTheme } from "react-native-paper";

import { formatPercent, formatSigned, tone } from "@/lib/investments";
import { TONE_COLORS } from "@/lib/theme";

const TONE_WORD = { gain: "gain", loss: "loss", flat: "no change" } as const;

type Props = {
  value: string;
  percent?: boolean;
  variant?: React.ComponentProps<typeof Text>["variant"];
  style?: StyleProp<TextStyle>;
};

// A profit or loss: always signed, green or red, and named for screen readers, so colour is
// never the only signal.
export function Signed({ value, percent = false, variant = "bodyMedium", style }: Props) {
  const { dark } = useTheme();
  const t = tone(value);
  const text = percent ? formatPercent(value) : formatSigned(value);
  const color = t === "flat" ? undefined : TONE_COLORS[dark ? "dark" : "light"][t];
  return (
    <Text variant={variant} accessibilityLabel={`${text} ${TONE_WORD[t]}`} style={[color ? { color } : null, style]}>
      {text}
    </Text>
  );
}
