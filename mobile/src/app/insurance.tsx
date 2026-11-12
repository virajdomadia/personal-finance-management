import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, EmptyState, HeaderAction, Row, ScreenHeader, Tile } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Policy, cardBillText, fundingText, renewalText } from "@/lib/insurance";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { formatDate } from "@/lib/transactions";

const FAILED = "We couldn't load your policies.";

// A policy renewing within this many days (or already past) is listed under Renew soon.
const RENEW_SOON_DAYS = 60;

type Asking = { kind: "lapse" | "delete"; policy: Policy };

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <Text variant="bodySmall" style={styles.muted}>
        {label}
      </Text>
      <Text variant="bodyMedium" style={styles.factValue}>
        {value}
      </Text>
    </View>
  );
}

function SectionTitle({ label }: { label: string }) {
  return (
    <Text variant="titleSmall" accessibilityRole="header" style={styles.sectionTitle}>
      {label.toUpperCase()}
    </Text>
  );
}

function PolicyCard({
  policy,
  disabled,
  onRenew,
  onEdit,
  onLapse,
  onDelete,
}: {
  policy: Policy;
  disabled: boolean;
  onRenew: () => void;
  onEdit: () => void;
  onLapse: () => void;
  onDelete: () => void;
}) {
  const renewal = renewalText(policy);
  const funding = fundingText(policy);
  const cardBill = cardBillText(policy);
  const periods = [...policy.periods].sort((a, b) => (a.period_start < b.period_start ? 1 : -1));
  const name = `${policy.insurer}, ${policy.plan}`;

  return (
    <ChunkyBox style={styles.card}>
      <View accessible accessibilityLabel={`${name}, ${renewal ?? "Lapsed"}`} style={styles.head}>
        <View style={styles.square}>
          <Text style={styles.emoji} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            {policy.active ? "❤️" : "🛡️"}
          </Text>
        </View>
        <View style={styles.headText}>
          <Text variant="titleMedium" style={styles.insurer}>
            {policy.insurer}
          </Text>
          <Text variant="bodyMedium" style={styles.muted}>
            {policy.plan}
          </Text>
          <Text variant="bodySmall" style={styles.renewal}>
            {renewal ?? "Lapsed"}
          </Text>
        </View>
      </View>

      <View style={styles.facts}>
        <Fact label="Policy number" value={policy.policy_number} />
        <Fact label="Insured" value={policy.insured} />
        <Fact label="Sum insured" value={whole(policy.sum_insured)} />
        <Fact label="Premium" value={`${whole(policy.premium)} a year`} />
      </View>

      {funding ? <Text variant="bodyMedium">{funding}</Text> : null}
      {cardBill ? <Banner tone="info" messages={[`Heads up. ${cardBill}`]} /> : null}

      {policy.details ? (
        <View style={styles.section}>
          <Text variant="labelLarge" style={styles.label}>
            Details
          </Text>
          <Text variant="bodyMedium">{policy.details}</Text>
        </View>
      ) : null}

      {policy.premium_by_fy.length > 0 ? (
        <View style={styles.section}>
          <Text variant="labelLarge" style={styles.label}>
            Premium paid by financial year
          </Text>
          {policy.premium_by_fy.map((fy) => (
            <Text key={fy.fy} variant="bodyMedium">
              FY {fy.fy}: {whole(fy.amount)}
            </Text>
          ))}
          <Text variant="bodySmall" style={styles.muted}>
            Health premiums are usually deductible under section 80D.
          </Text>
        </View>
      ) : null}

      {periods.length > 0 ? (
        <View style={styles.section}>
          <Text variant="labelLarge" style={styles.label}>
            Policy years
          </Text>
          {periods.map((p, index) => (
            <View key={p.period_start} style={[styles.period, index > 0 ? styles.periodDivider : null]}>
              <View style={styles.headText}>
                <Text variant="bodyMedium">
                  {formatDate(p.period_start)} to {formatDate(p.period_end)}
                </Text>
                <Text variant="bodySmall" style={styles.muted}>
                  {p.transaction_id === null
                    ? `Paid ${formatDate(p.paid_on)}, before using the app`
                    : `Paid ${formatDate(p.paid_on)}`}
                  {" · "}sum insured {whole(p.sum_insured)}
                </Text>
              </View>
              <Text variant="bodyMedium" style={styles.periodAmount}>
                {whole(p.premium)}
              </Text>
            </View>
          ))}
          {periods.length > 1 ? (
            <Text variant="bodySmall" style={styles.muted}>
              Renewed by mistake? Delete the latest premium payment in Transactions and the policy goes back a year.
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        {policy.active ? (
          <ChunkyButton
            compact
            variant="green"
            label="Renew"
            disabled={disabled}
            onPress={onRenew}
            accessibilityLabel={`Renew ${name}`}
          />
        ) : null}
        <ChunkyButton compact variant="alt" label="Edit" disabled={disabled} onPress={onEdit} accessibilityLabel={`Edit ${name}`} />
        {policy.active ? (
          <ChunkyButton
            compact
            variant="alt"
            label="Mark lapsed"
            disabled={disabled}
            onPress={onLapse}
            accessibilityLabel={`Mark ${name} lapsed`}
          />
        ) : null}
        <ChunkyButton
          compact
          variant="alt"
          label="Delete"
          disabled={disabled}
          onPress={onDelete}
          accessibilityLabel={`Delete ${name}`}
        />
      </View>
    </ChunkyBox>
  );
}

export default function InsuranceScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [policies, setPolicies] = useState<Policy[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [working, setWorking] = useState(false);
  const busy = useRef(false);
  const navigating = useRef(false);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<{ policies: Policy[] }>("/insurance", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setPolicies(result.policies);
      setFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setFailed(true); // keeps the last data, if any
    }
  }, [token, logOut]);

  useFocusEffect(
    useCallback(() => {
      navigating.current = false;
      void load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves the foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busy.current) setAsking(null);
    });
    return () => subscription.remove();
  }, []);

  const go = (target: Parameters<typeof router.push>[0]) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push(target);
  };
  const withId = (pathname: "/policy-form", id: number) => ({ pathname, params: { id: String(id) } });

  async function confirm() {
    if (asking === null || busy.current) return;
    busy.current = true;
    setWorking(true);
    setNotice(null);
    const { kind, policy } = asking;
    try {
      if (kind === "lapse") {
        await apiFetch(`/insurance/${policy.id}/lapse`, { method: "POST", token: token ?? undefined });
      } else {
        await apiFetch(`/insurance/${policy.id}`, { method: "DELETE", token: token ?? undefined });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else setNotice(errorMessage(err instanceof ApiError ? { detail: err.detail } : err));
    } finally {
      busy.current = false;
      setWorking(false);
      setAsking(null);
    }
    void load();
  }

  const active = (policies ?? []).filter((p) => p.active);
  const lapsed = (policies ?? []).filter((p) => !p.active);
  const soon = active.filter((p) => p.days_to_renewal !== null && p.days_to_renewal <= RENEW_SOON_DAYS);
  const cover = active.reduce((sum, p) => sum + Number(p.sum_insured), 0);

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Insurance" back right={<HeaderAction icon="plus" label="Add policy" onPress={() => go("/policy-form")} />} />

      {policies === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading policies" />
        </View>
      ) : policies === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {FAILED}
          </Text>
          <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {failed ? <Banner messages={[`${FAILED} Pull down to try again.`]} /> : null}
          {notice !== null ? <Banner messages={[notice]} /> : null}
          {policies.length === 0 ? (
            <EmptyState
              emoji="🛡️"
              title="No policies yet"
              body="Add your health insurance to get a reminder before it renews and see what each year cost."
              action={{ label: "Add policy", onPress: () => go("/policy-form") }}
            />
          ) : (
            <>
              <Tile tone="green" emoji="🛡️" label="You're covered for" size="huge" value={whole(String(cover))}>
                <Text variant="bodySmall" style={styles.onTile}>
                  {active.length} active {active.length === 1 ? "policy" : "policies"}
                </Text>
              </Tile>

              {soon.length > 0 ? (
                <View style={styles.list}>
                  <SectionTitle label="Renew soon" />
                  {soon.map((policy) => {
                    const name = `${policy.insurer}, ${policy.plan}`;
                    return (
                      <Row
                        key={policy.id}
                        highlight
                        emoji="❤️"
                        tone="pink"
                        title={policy.insurer}
                        meta={[policy.plan, renewalText(policy)].filter(Boolean).join(" · ")}
                        amount={whole(policy.premium)}
                        sub="a year"
                      >
                        <View style={styles.actions}>
                          <ChunkyButton
                            compact
                            variant="green"
                            label="Renew"
                            disabled={working}
                            accessibilityLabel={`Renew ${name} soon`}
                            onPress={() => go({ pathname: "/renew-form", params: { policyId: String(policy.id) } })}
                          />
                        </View>
                      </Row>
                    );
                  })}
                </View>
              ) : null}

              {[
                { title: "Active policies", list: active },
                { title: "Lapsed", list: lapsed },
              ].map((group) =>
                group.list.length > 0 ? (
                  <View key={group.title} style={styles.list}>
                    <SectionTitle label={group.title} />
                    {group.list.map((policy) => (
                      <PolicyCard
                        key={policy.id}
                        policy={policy}
                        disabled={working}
                        onRenew={() => go({ pathname: "/renew-form", params: { policyId: String(policy.id) } })}
                        onEdit={() => go(withId("/policy-form", policy.id))}
                        onLapse={() => setAsking({ kind: "lapse", policy })}
                        onDelete={() => setAsking({ kind: "delete", policy })}
                      />
                    ))}
                  </View>
                ) : null,
              )}
            </>
          )}
        </ScrollView>
      )}

      <Portal>
        <Dialog visible={asking !== null} onDismiss={() => (working ? undefined : setAsking(null))}>
          <Dialog.Title>
            {asking?.kind === "lapse" ? `Mark ${asking.policy.insurer} as lapsed?` : `Delete ${asking?.policy.insurer ?? ""}?`}
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              {asking?.kind === "lapse"
                ? "Its renewal reminder stops. The policy and its history stay."
                : "The policy and its reminder are removed for good. If premiums have been recorded for it, mark it lapsed instead."}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsking(null)} disabled={working}>
              Cancel
            </Button>
            <Button onPress={() => void confirm()} loading={working} disabled={working}>
              {asking?.kind === "lapse" ? "Mark lapsed" : "Delete"}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  card: { padding: 14, gap: 12 },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  square: {
    width: 38,
    height: 38,
    borderRadius: 10,
    borderWidth: 2.5,
    borderColor: BRAND.ink,
    backgroundColor: BRAND.purple,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: { fontSize: 18, lineHeight: 24 },
  headText: { flex: 1, minWidth: 0 },
  insurer: { color: BRAND.ink },
  renewal: { color: BRAND.ink, fontWeight: "700", marginTop: 2 },
  muted: { color: BRAND.zinc600 },
  label: { color: BRAND.ink },
  onTile: { color: "#FFFFFF", marginTop: 4 },
  list: { gap: 8 },
  sectionTitle: { color: BRAND.ink, letterSpacing: 0.6, paddingTop: 4 },
  facts: { flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 8 },
  fact: { minWidth: "40%", flexGrow: 1, flexShrink: 1 },
  factValue: { fontWeight: "600", color: BRAND.ink },
  section: { gap: 4 },
  period: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 12, paddingVertical: 8 },
  periodDivider: { borderTopWidth: 1.5, borderTopColor: BRAND.zinc200, borderStyle: "dashed" },
  periodAmount: { fontWeight: "600", flexShrink: 0, maxWidth: "45%", textAlign: "right", fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, paddingTop: 4 },
});
