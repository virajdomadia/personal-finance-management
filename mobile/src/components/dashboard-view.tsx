import { router } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "react-native-paper";

import { ChunkyBox, ChunkyButton, Row, ScreenHeader, StackedBar, Tile } from "@/components/chunky";
import { SetupChecklist } from "@/components/setup-checklist";
import { type AssetSplit, type Dashboard, formatDueDate } from "@/lib/accounts";
import { cardBillText, reviewCountText } from "@/lib/review";
import { investmentSticker, streakLabel } from "@/lib/fun";
import { tileGoal } from "@/lib/goals";
import { formatPercent } from "@/lib/investments";
import { whole } from "@/lib/recurring";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

const GROUP_LABELS: Record<AssetSplit["group"], string> = {
  bank_cash: "Bank & cash",
  deposits: "Deposits",
  stocks: "Stocks",
  funds: "Funds",
  crypto: "Crypto",
};

// The streak chip, hidden when there is no streak.
export function StreakPill({ days }: { days: number | null }) {
  const label = days === null ? null : streakLabel(days);
  if (!label) return null;
  return (
    <View accessible accessibilityLabel={`${days}-day streak`}>
      <ChunkyBox radius={999} offset={SHADOW_OFFSET_SM} style={styles.pill}>
        <Text variant="labelLarge" style={styles.pillText}>
          {label}
        </Text>
      </ChunkyBox>
    </View>
  );
}

function Grid({ children }: { children: ReactNode[] }) {
  const items = children.filter(Boolean);
  const rows: ReactNode[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <>
      {rows.map((row, i) => (
        <View key={i} style={styles.gridRow}>
          {row.map((cell, j) => (
            <View key={j} style={styles.cell}>
              {cell}
            </View>
          ))}
        </View>
      ))}
    </>
  );
}

type Props = {
  data: Dashboard;
  streak: number | null;
  failed: boolean;
  onOpenAccounts: () => void;
  dueList?: ReactNode; // the due and coming-up reminders
};

// The dashboard's content, without any loading or fetching, so it can be shown with fixture data.
export function DashboardView({ data, streak, failed, onOpenAccounts, dueList }: Props) {
  const bill = data.card_bill ?? null;
  // The statement's bill says more than the card's due day, so the card isn't listed twice.
  const due = data.next_card_due && data.next_card_due.account_id !== bill?.account_id ? data.next_card_due : null;
  const toReview = data.to_review ?? 0;
  const used = data.credit_used;
  const negative = data.net_worth.startsWith("-");
  const picked = tileGoal(data.goals ?? []);
  const split = (data.asset_split ?? []).map((s) => ({ label: GROUP_LABELS[s.group], value: Number(s.value) }));
  const hasSplit = split.some((s) => s.value > 0);
  const inv = data.investments;

  const goalTile = picked ? (
    <Tile
      tone="purple"
      emoji="🎯"
      label={picked.goal.name}
      value={picked.done ? "100%" : `${picked.goal.percent ?? 0}%`}
      sticker={picked.done ? "DONE!" : null}
      accessibilityExtra={picked.done ? "done" : undefined}
      onPress={() => router.push("/goals")}
    />
  ) : (
    <Tile tone="purple" label="🎯 Set a goal" onPress={() => router.push("/goal-form")}>
      <Text variant="labelMedium" style={styles.hint}>
        Tap to start one
      </Text>
    </Tile>
  );

  return (
    <View style={styles.wrap}>
      <ScreenHeader title="Hey there!" right={<StreakPill days={streak} />} />
      <View style={styles.body}>
        {failed ? (
          <Text variant="bodyMedium" accessibilityRole="alert" style={styles.error}>
            We couldn&apos;t load your dashboard. Pull down to try again.
          </Text>
        ) : null}

        <SetupChecklist />

        {toReview > 0 ? (
          <Tile
            tone="orange"
            emoji="📩"
            label="To review"
            value={String(toReview)}
            accessibilityExtra={reviewCountText(toReview)}
            onPress={() => router.push("/review")}
          >
            <Text variant="labelMedium" style={styles.hint}>
              {reviewCountText(toReview)} from your bank SMS
            </Text>
          </Tile>
        ) : null}

        <Tile tone={negative ? "pink" : "green"} label="Net worth" value={whole(data.net_worth)} size="huge">
          {data.investments ? (
            <Text variant="bodySmall" style={styles.note}>
              Includes investments at their latest price (or cost if no price yet)
            </Text>
          ) : null}
          {!data.has_accounts ? (
            <ChunkyButton label="Add your first account" variant="alt" onPress={onOpenAccounts} style={styles.addFirst} />
          ) : null}
        </Tile>

        <Grid>
          {[
            data.has_accounts ? (
              <Tile key="have" tone="yellow" emoji="🏦" label="You have" value={whole(data.total_have)} onPress={onOpenAccounts} />
            ) : null,
            data.has_accounts ? (
              <Tile key="owe" tone="pink" emoji="💳" label="You owe" value={whole(data.total_owe)} onPress={onOpenAccounts} />
            ) : null,
            inv ? (
              <Tile
                key="inv"
                tone="blue"
                label="Investments"
                value={whole(inv.value)}
                sticker={investmentSticker(inv.unrealised_percent)}
                accessibilityExtra={[`unrealised ${formatPercent(inv.unrealised_percent)}`, investmentSticker(inv.unrealised_percent)]
                  .filter(Boolean)
                  .join(", ")}
                onPress={() => router.navigate("/investments")}
              >
                <Text variant="labelMedium" style={styles.hint}>
                  {formatPercent(inv.unrealised_percent)}
                </Text>
              </Tile>
            ) : null,
            <View key="goal">{goalTile}</View>,
          ]}
        </Grid>

        {hasSplit ? (
          <Tile label="Where it is" emoji="🧭">
            <StackedBar items={split} label="Where your money is" />
          </Tile>
        ) : null}

        {dueList}

        {bill || due || used ? (
          <View style={styles.group}>
            <Text variant="titleSmall" accessibilityRole="header" style={styles.groupTitle}>
              Needs attention
            </Text>
            {bill ? (
              <Row
                emoji="🧾"
                tone="orange"
                title={cardBillText(bill)}
                highlight
                onPress={onOpenAccounts}
                accessibilityLabel={cardBillText(bill)}
              />
            ) : null}
            {due ? (
              <Row
                emoji="💳"
                tone="orange"
                title={`${due.name} due ${formatDueDate(due.due_date)}`}
                highlight
                onPress={onOpenAccounts}
                accessibilityLabel={`${due.name} due ${formatDueDate(due.due_date)}`}
              />
            ) : null}
            {used ? (
              <Row
                emoji="📊"
                tone="card"
                title={`${used.percent}% of credit limit used`}
                onPress={onOpenAccounts}
                accessibilityLabel={`${used.percent}% of credit limit used`}
              />
            ) : null}
          </View>
        ) : null}

        <ChunkyButton label="+ Add transaction" onPress={() => router.push("/transaction-form")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  body: { paddingHorizontal: 16, gap: 12 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: BRAND.yellow, borderRadius: INPUT_RADIUS },
  pillText: { color: BRAND.ink },
  gridRow: { flexDirection: "row", gap: 12 },
  cell: { flex: 1, minWidth: 0 },
  hint: { color: "#FFFFFF", marginTop: 2 },
  note: { color: "#FFFFFF", marginTop: 4 },
  error: { color: BRAND.loss },
  addFirst: { marginTop: 12, alignSelf: "flex-start" },
  group: { gap: 8 },
  groupTitle: { color: BRAND.ink },
});
