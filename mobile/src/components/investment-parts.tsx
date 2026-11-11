import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, Text } from "react-native-paper";
import Svg, { Circle, Polyline } from "react-native-svg";

import { ChunkyBox, ChunkyButton, Row, Tile, type Tone } from "@/components/chunky";
import { Signed, signedLabel } from "@/components/signed";
import { formatDate } from "@/lib/transactions";
import { formatPercent, formatSigned, tone } from "@/lib/investments";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM, TONE_COLORS } from "@/lib/theme";

// Pieces the investments tab and the stock, fund and coin screens share.

export function SectionTitle({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionTitle}>
        {label.toUpperCase()}
      </Text>
      {action}
    </View>
  );
}

// "+₹1,234.50 · +12.5%" in gain or loss colour, on a white pill so it reads on any tile.
export function GainPill({ unrealised, percent, label = "Unrealised" }: { unrealised: string; percent: string; label?: string }) {
  const t = tone(unrealised);
  const color = t === "flat" ? BRAND.ink : TONE_COLORS[t];
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${signedLabel(unrealised)}, ${signedLabel(percent, true)}`}
      style={styles.pillWrap}
    >
      <ChunkyBox radius={999} offset={SHADOW_OFFSET_SM} style={styles.pill}>
        <Text variant="labelLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={[styles.pillText, { color }]}>
          {formatSigned(unrealised)} · {formatPercent(percent)}
        </Text>
      </ChunkyBox>
    </View>
  );
}

// A small "word  figure" line for the white text on a tile.
export function TileLine({ label, value, accessibilityLabel }: { label: string; value: string; accessibilityLabel?: string }) {
  return (
    <View style={styles.tileLine} accessible accessibilityLabel={accessibilityLabel ?? `${label} ${value}`}>
      <Text variant="labelLarge" style={styles.tileLabel}>
        {label}
      </Text>
      <Text variant="titleMedium" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={styles.tileValue}>
        {value}
      </Text>
    </View>
  );
}

// The big "what it is worth" tile, with the gain on a pill underneath.
export function WorthTile({
  tone: tileTone = "blue",
  label,
  value,
  sticker,
  children,
}: {
  tone?: Tone;
  label: string;
  value: string;
  sticker?: string | null;
  children?: ReactNode;
}) {
  return (
    <Tile tone={tileTone} label={label} value={value} size="huge" sticker={sticker}>
      {children}
    </Tile>
  );
}

// One label and figure with a note underneath, in a card of stats.
export function StatLine({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.statLine} accessible accessibilityLabel={`${label}, ${value}${note ? `, ${note}` : ""}`}>
      <Text variant="labelLarge" style={styles.statLabel}>
        {label}
      </Text>
      <View style={styles.statEnd}>
        <Text variant="titleMedium" style={styles.statValue}>
          {value}
        </Text>
        {note ? (
          <Text variant="bodySmall" style={styles.statNote}>
            {note}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function StatsCard({ children }: { children: ReactNode }) {
  return (
    <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.stats}>
      {children}
    </ChunkyBox>
  );
}

type Point = { date: string; value: string };

// The price (or NAV) over time. Points come oldest first. It needs two points to be a line.
export function PriceLine({ points, title, format }: { points: Point[]; title: string; format: (value: string) => string }) {
  const [width, setWidth] = useState(0);
  if (points.length < 2) return null;
  const values = points.map((p) => Number(p.value));
  if (values.some((v) => !Number.isFinite(v))) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const height = 96;
  const pad = 10;
  const innerW = Math.max(width - pad * 2, 1);
  const innerH = height - pad * 2;
  const coords = values.map((v, i) => ({
    x: pad + (i / (values.length - 1)) * innerW,
    y: max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * innerH,
  }));
  const last = coords[coords.length - 1];
  const first = points[0];
  const end = points[points.length - 1];
  return (
    <ChunkyBox
      radius={INPUT_RADIUS}
      offset={SHADOW_OFFSET_SM}
      containerStyle={styles.lineWrap}
      style={styles.lineCard}
    >
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${title}: ${format(first.value)} on ${formatDate(first.date)}, ${format(end.value)} on ${formatDate(end.date)}`}
      >
        <Text variant="labelLarge" style={styles.statLabel}>
          {title}
        </Text>
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height }}>
          {width > 0 ? (
            <Svg width={width} height={height}>
              <Polyline
                points={coords.map((c) => `${c.x},${c.y}`).join(" ")}
                fill="none"
                stroke={BRAND.ink}
                strokeWidth={3}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              <Circle cx={last.x} cy={last.y} r={6} fill={BRAND.yellow} stroke={BRAND.ink} strokeWidth={2.5} />
            </Svg>
          ) : null}
        </View>
        <View style={styles.lineEnds}>
          <Text variant="bodySmall" style={styles.statNote}>
            {formatDate(first.date)}
          </Text>
          <Text variant="bodySmall" style={styles.statNote}>
            {formatDate(end.date)}
          </Text>
        </View>
      </View>
    </ChunkyBox>
  );
}

// One recorded price or NAV: the date, the figure and a delete button.
export function HistoryRow({
  date,
  value,
  note,
  onDelete,
  deleteLabel,
}: {
  date: string;
  value: string;
  note?: string;
  onDelete: () => void;
  deleteLabel: string;
}) {
  return (
    <View style={styles.rowWrap}>
      <ChunkyBox radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.history}>
        <View style={styles.historyMain}>
          <Text variant="titleMedium" style={styles.historyDate}>
            {formatDate(date)}
          </Text>
          {note ? (
            <Text variant="bodySmall" style={styles.statNote}>
              {note}
            </Text>
          ) : null}
        </View>
        <Text variant="titleMedium" style={styles.historyValue}>
          {value}
        </Text>
        <Pressable onPress={onDelete} accessibilityRole="button" accessibilityLabel={deleteLabel} hitSlop={4} style={styles.delete}>
          <Icon source="delete-outline" size={22} color={BRAND.ink} />
        </Pressable>
      </ChunkyBox>
    </View>
  );
}

// One account's holding of an instrument, with its own Sell or Redeem button.
export function HeldRow({
  emoji,
  title,
  lines,
  value,
  atCost,
  unrealised,
  unrealisedPercent,
  action,
}: {
  emoji: string;
  title: string;
  lines: string[];
  value: string;
  atCost: boolean;
  unrealised: string;
  unrealisedPercent: string;
  action?: ReactNode;
}) {
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={emoji}
        tone="blue"
        title={title}
        meta={
          <>
            {lines.map((line) => (
              <Text key={line} variant="bodySmall" style={styles.statNote}>
                {line}
              </Text>
            ))}
          </>
        }
        amount={value}
        sub={
          <>
            {atCost ? (
              <Text variant="bodySmall" style={styles.right}>
                at cost
              </Text>
            ) : null}
            <Signed value={unrealised} variant="bodySmall" style={styles.signed} />
            <Signed value={unrealisedPercent} percent variant="bodySmall" style={styles.signed} />
          </>
        }
      >
        {action ? <View style={styles.action}>{action}</View> : null}
      </Row>
    </View>
  );
}

type TradeProps = {
  emoji: string;
  title: string;
  details: string[];
  cash: string;
  amount: string;
  realised: string | null;
  archived: boolean;
  archivedNote: string;
  archivedLabel: string;
  hint: string;
  onPress: () => void;
};

// One buy or sell. Tapping opens it; one in an archived account is locked until the account is restored.
export function TradeRow({ emoji, title, details, cash, amount, realised, archived, archivedNote, archivedLabel, hint, onPress }: TradeProps) {
  return (
    <View style={styles.rowWrap}>
      <Row
        emoji={emoji}
        tone="purple"
        title={title}
        meta={
          <>
            <Text variant="bodySmall" style={styles.statNote}>
              {details.join(" · ")}
            </Text>
            {archived ? (
              <Text variant="labelSmall" style={styles.statNote}>
                {archivedNote}
              </Text>
            ) : null}
          </>
        }
        caption={cash}
        amount={amount}
        sub={realised !== null ? <Signed value={realised} variant="bodySmall" style={styles.signed} /> : undefined}
        onPress={archived ? undefined : onPress}
        accessibilityLabel={`${title}, ${details.join(", ")}, ${cash} ${amount}${realised !== null ? `, realised ${signedLabel(realised)}` : ""}${archived ? `, ${archivedLabel}` : ""}`}
        accessibilityHint={archived ? undefined : hint}
      />
    </View>
  );
}

// A line of body text that stands in for an empty section, with an optional button.
export function EmptyBox({ text, action }: { text: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.emptyBox}>
      <Text variant="bodyMedium" style={styles.emptyText}>
        {text}
      </Text>
      {action ? <ChunkyButton variant="alt" label={action.label} onPress={action.onPress} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6, gap: 8 },
  sectionTitle: { flex: 1, color: BRAND.ink, letterSpacing: 0.6 },
  pillWrap: { alignSelf: "flex-start", maxWidth: "100%", marginTop: 10 },
  pill: { backgroundColor: BRAND.card, paddingHorizontal: 12, paddingVertical: 4, minHeight: 32, justifyContent: "center" },
  pillText: { fontVariant: ["tabular-nums"] },
  tileLine: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8, marginTop: 8 },
  tileLabel: { color: "#FFFFFF" },
  tileValue: { flexShrink: 1, color: "#FFFFFF", textAlign: "right", fontVariant: ["tabular-nums"] },
  stats: { padding: 14, gap: 12 },
  statLine: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  statLabel: { color: BRAND.ink },
  statEnd: { flexShrink: 1, alignItems: "flex-end" },
  statValue: { color: BRAND.ink, textAlign: "right", fontVariant: ["tabular-nums"] },
  statNote: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  lineWrap: { marginHorizontal: 16, marginTop: 8 },
  lineCard: { padding: 14 },
  lineEnds: { flexDirection: "row", justifyContent: "space-between", gap: 8, marginTop: 4 },
  rowWrap: { paddingHorizontal: 16, paddingVertical: 4 },
  history: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 12, paddingRight: 4, paddingVertical: 4 },
  historyMain: { flex: 1, minWidth: 0 },
  historyDate: { color: BRAND.ink, fontSize: 16, lineHeight: 22 },
  historyValue: { color: BRAND.ink, flexShrink: 0, maxWidth: "50%", textAlign: "right", fontVariant: ["tabular-nums"] },
  delete: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  signed: { fontSize: 12, lineHeight: 16, textAlign: "right" },
  right: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16, textAlign: "right" },
  action: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingTop: 8 },
  emptyBox: { alignItems: "center", gap: 12, paddingHorizontal: 24, paddingVertical: 16 },
  emptyText: { color: BRAND.zinc600, textAlign: "center" },
});
