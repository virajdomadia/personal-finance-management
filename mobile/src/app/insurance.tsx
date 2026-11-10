import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Appbar, Button, Card, Dialog, Divider, Portal, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { type Policy, cardBillText, fundingText, renewalText } from "@/lib/insurance";
import { whole } from "@/lib/recurring";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/transactions";

const FAILED = "We couldn't load your policies.";

type Asking = { kind: "lapse" | "delete"; policy: Policy };

function Fact({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.fact}>
      <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
        {label}
      </Text>
      <Text variant="bodyMedium" style={styles.factValue}>
        {value}
      </Text>
    </View>
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
  const { colors } = useTheme();
  const renewal = renewalText(policy);
  const funding = fundingText(policy);
  const cardBill = cardBillText(policy);
  const periods = [...policy.periods].sort((a, b) => (a.period_start < b.period_start ? 1 : -1));
  const name = `${policy.insurer}, ${policy.plan}`;

  return (
    <Card mode="outlined" accessibilityLabel={name}>
      <Card.Content style={styles.card}>
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text variant="titleMedium">{policy.insurer}</Text>
            <Text variant="bodyMedium" style={{ color: colors.onSurfaceVariant }}>
              {policy.plan}
            </Text>
          </View>
          <Text variant="bodyMedium" style={styles.renewal}>
            {renewal ?? "Lapsed"}
          </Text>
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
            <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
              Details
            </Text>
            <Text variant="bodyMedium">{policy.details}</Text>
          </View>
        ) : null}

        {policy.premium_by_fy.length > 0 ? (
          <View style={styles.section}>
            <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
              Premium paid by financial year
            </Text>
            {policy.premium_by_fy.map((fy) => (
              <Text key={fy.fy} variant="bodyMedium">
                FY {fy.fy}: {whole(fy.amount)}
              </Text>
            ))}
            <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
              Health premiums are usually deductible under section 80D.
            </Text>
          </View>
        ) : null}

        {periods.length > 0 ? (
          <View style={styles.section}>
            <Text variant="labelLarge" style={{ color: colors.onSurfaceVariant }}>
              Policy years
            </Text>
            {periods.map((p, index) => (
              <View key={p.period_start}>
                {index > 0 ? <Divider /> : null}
                <View style={styles.period}>
                  <View style={styles.headText}>
                    <Text variant="bodyMedium">
                      {formatDate(p.period_start)} to {formatDate(p.period_end)}
                    </Text>
                    <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                      {p.transaction_id === null
                        ? `Paid ${formatDate(p.paid_on)}, before using the app`
                        : `Paid ${formatDate(p.paid_on)}`}
                      {" · "}sum insured {whole(p.sum_insured)}
                    </Text>
                  </View>
                  <Text variant="bodyMedium" style={styles.factValue}>
                    {whole(p.premium)}
                  </Text>
                </View>
              </View>
            ))}
            {periods.length > 1 ? (
              <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant }}>
                Renewed by mistake? Delete the latest premium payment in Transactions and the policy goes back a year.
              </Text>
            ) : null}
          </View>
        ) : null}
      </Card.Content>
      <View style={styles.actions}>
        {policy.active ? (
          <Button mode="contained" disabled={disabled} onPress={onRenew} accessibilityLabel={`Renew ${name}`}>
            Renew
          </Button>
        ) : null}
        <Button disabled={disabled} onPress={onEdit} accessibilityLabel={`Edit ${name}`}>
          Edit
        </Button>
        {policy.active ? (
          <Button disabled={disabled} onPress={onLapse} accessibilityLabel={`Mark ${name} lapsed`}>
            Mark lapsed
          </Button>
        ) : null}
        <Button disabled={disabled} onPress={onDelete} accessibilityLabel={`Delete ${name}`}>
          Delete
        </Button>
      </View>
    </Card>
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

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <Appbar.Header>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title="Insurance" />
        <Appbar.Action icon="plus" accessibilityLabel="Add policy" onPress={() => go("/policy-form")} />
      </Appbar.Header>

      {policies === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading policies" />
        </View>
      ) : policies === null ? (
        <View style={styles.center}>
          <Text variant="bodyLarge" style={styles.centerText}>
            {FAILED}
          </Text>
          <Button mode="contained" onPress={() => void refresh()} loading={refreshing} disabled={refreshing}>
            Try again
          </Button>
        </View>
      ) : (
        <ScrollView
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}
        >
          {failed ? <Banner messages={[`${FAILED} Pull down to try again.`]} /> : null}
          {notice !== null ? <Banner messages={[notice]} /> : null}
          {policies.length === 0 ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">No policies yet</Text>
              <Text variant="bodyMedium" style={[styles.centerText, { color: colors.onSurfaceVariant }]}>
                Add your health insurance to get a renewal reminder, see what each year cost, and check your premium fund
                covers it.
              </Text>
              <Button mode="contained" onPress={() => go("/policy-form")}>
                Add policy
              </Button>
            </View>
          ) : (
            policies.map((policy) => (
              <PolicyCard
                key={policy.id}
                policy={policy}
                disabled={working}
                onRenew={() => go({ pathname: "/renew-form", params: { policyId: String(policy.id) } })}
                onEdit={() => go(withId("/policy-form", policy.id))}
                onLapse={() => setAsking({ kind: "lapse", policy })}
                onDelete={() => setAsking({ kind: "delete", policy })}
              />
            ))
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
  empty: { alignItems: "center", gap: 12, paddingVertical: 32 },
  card: { gap: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  headText: { flex: 1, flexShrink: 1 },
  renewal: { flexShrink: 1, textAlign: "right" },
  facts: { flexDirection: "row", flexWrap: "wrap", columnGap: 16, rowGap: 8 },
  fact: { minWidth: "40%", flexGrow: 1 },
  factValue: { fontWeight: "600" },
  section: { gap: 4 },
  period: { flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 4, padding: 8 },
});
