import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text, useTheme } from "react-native-paper";

import { ChunkyBox, ChunkyButton, EmptyState, HeaderAction, Row, ScreenHeader, StackedBar } from "@/components/chunky";
import { EmptyBox, GainPill, SectionTitle, TileLine, WorthTile } from "@/components/investment-parts";
import { Signed, signedLabel } from "@/components/signed";
import { errorMessage, formatRupees } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type FamilyPortfolio,
  type PersonPortfolio,
  TYPE_EMOJI,
  hasMembers,
  holdingDetails,
  holdingsCountText,
  kindEmoji,
  shareText,
  sharePercent,
  sortHoldings,
  sortPeople,
  switchToText,
  typeSplit,
} from "@/lib/family";
import { useProfile } from "@/lib/profile";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

// Everyone's investments together: the owner's and each family member's, always fetched as the
// owner, whichever profile is chosen. Bank accounts, cards and loans are not part of it.
export default function FamilyScreen() {
  const { token, logOut } = useSession();
  const { profile, switchProfile } = useProfile();
  const { colors } = useTheme();
  const [portfolio, setPortfolio] = useState<FamilyPortfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<FamilyPortfolio>("/family/portfolio", { token: token ?? undefined });
      if (mine !== latest.current) return;
      setPortfolio(result);
      setError(null);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setError(errorMessage(err));
    }
  }, [token, logOut]);

  useFocusEffect(
    useCallback(() => {
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

  const manage = () => router.push("/family-members");
  // To add someone's investments, act as them on the Investments tab.
  const addFor = (person: PersonPortfolio) => {
    if (person.is_me) {
      if (profile === null) router.navigate("/investments");
      else switchProfile(null, "/investments");
    } else if (profile?.id === person.id) {
      router.navigate("/investments");
    } else {
      switchProfile({ id: person.id, name: person.name }, "/investments");
    }
  };

  const header = <ScreenHeader title="Family" right={<HeaderAction icon="account-cog-outline" label="Manage family" onPress={manage} />} />;

  if (portfolio === null) {
    return (
      <View style={styles.screen}>
        {header}
        <View style={styles.center}>
          {error === null ? (
            <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading the family portfolio" />
          ) : (
            <>
              <Text variant="bodyLarge" style={styles.centerText}>
                {error}
              </Text>
              <ChunkyButton label="Try again" onPress={() => void refresh()} loading={refreshing} />
            </>
          )}
        </View>
      </View>
    );
  }

  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />;

  if (!hasMembers(portfolio)) {
    return (
      <View style={styles.screen}>
        {header}
        <ScrollView refreshControl={refreshControl} contentContainerStyle={styles.content}>
          <EmptyState
            emoji="👨‍👩‍👧"
            title="See your family's investments together"
            body="Add your parents, spouse or children as family members. Each gets their own profile for their demat, funds, PPF and deposits, kept apart from your own figures, and this tab adds everyone up."
            action={{ label: "Manage family", onPress: manage }}
          />
        </ScrollView>
      </View>
    );
  }

  const total = portfolio.overall.value;
  const people = sortPeople(portfolio.people);
  const types = typeSplit(portfolio.by_type, total);

  return (
    <View style={styles.screen}>
      {header}
      <ScrollView refreshControl={refreshControl} contentContainerStyle={styles.content}>
        {error ? (
          <Text variant="bodyMedium" accessibilityRole="alert" style={styles.error}>
            {error} Pull down to try again.
          </Text>
        ) : null}
        <View style={styles.pad}>
          <WorthTile tone="purple" label="👨‍👩‍👧 Family investments" value={formatRupees(total)}>
            <GainPill unrealised={portfolio.overall.unrealised} percent={portfolio.overall.unrealised_percent} label="Unrealised P&L" />
            <TileLine label="Invested" value={formatRupees(portfolio.overall.invested)} />
          </WorthTile>
        </View>

        <SectionTitle label="By person" />
        <View style={styles.pad}>
          <StackedBar label="Family value by person" items={people.map((p) => ({ label: p.name, value: Number(p.overall.value) || 0 }))} />
        </View>
        <View style={styles.list}>
          {people.map((person) => (
            <PersonCard
              key={person.id}
              person={person}
              total={total}
              expanded={Boolean(open[person.id])}
              onToggle={() => setOpen((o) => ({ ...o, [person.id]: !o[person.id] }))}
              onAdd={() => addFor(person)}
            />
          ))}
        </View>

        <SectionTitle label="By type" />
        {types.length === 0 ? (
          <EmptyBox text="No one has any investments yet." />
        ) : (
          <>
            <View style={styles.pad}>
              <StackedBar label="Family value by type" items={types.map((t) => ({ label: t.label, value: Number(t.figures.value) || 0 }))} />
            </View>
            <View style={styles.list}>
              {types.map((t) => (
                <Row
                  key={t.key}
                  emoji={TYPE_EMOJI[t.key]}
                  tone="blue"
                  title={t.label}
                  meta={
                    <Text variant="bodySmall" style={styles.note}>
                      {t.share} of family value · invested {formatRupees(t.figures.invested)}
                    </Text>
                  }
                  amount={formatRupees(t.figures.value)}
                  sub={t.key === "deposits" ? undefined : <Signed value={t.figures.unrealised} variant="bodySmall" style={styles.signed} />}
                />
              ))}
            </View>
          </>
        )}
        <Text variant="bodySmall" style={[styles.note, styles.footnote]}>
          Each person&apos;s figures are their own Investments tab&apos;s. Deposits count at their balance. Bank accounts, cards and loans are not included.
        </Text>
      </ScrollView>
    </View>
  );
}

type CardProps = {
  person: PersonPortfolio;
  total: string;
  expanded: boolean;
  onToggle: () => void;
  onAdd: () => void;
};

// One person: value, gain and share of the family, with their holdings when opened.
function PersonCard({ person, total, expanded, onToggle, onAdd }: CardProps) {
  const share = shareText(person.overall.value, total);
  const holdings = sortHoldings(person.holdings);
  const label = `${person.name}, ${formatRupees(person.overall.value)}, ${signedLabel(person.overall.unrealised)}, ${share} of family value, ${holdingsCountText(holdings.length)}`;
  return (
    <View>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={expanded ? "Hides their holdings" : "Shows their holdings"}
        accessibilityState={{ expanded }}
      >
        {({ pressed }) => (
          <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.card}>
            <View style={styles.cardTop}>
              <View style={styles.cardName}>
                <Text variant="titleMedium" numberOfLines={1} style={styles.ink}>
                  {person.is_me ? "🙂 Me" : `🧑 ${person.name}`}
                </Text>
                <Text variant="bodySmall" style={styles.note}>
                  {share} of family · {holdingsCountText(holdings.length)}
                </Text>
              </View>
              <View style={styles.cardEnd}>
                <Text variant="titleMedium" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={[styles.ink, styles.figure]}>
                  {formatRupees(person.overall.value)}
                </Text>
                <Signed value={person.overall.unrealised} variant="bodySmall" style={styles.signed} />
                <Signed value={person.overall.unrealised_percent} percent variant="bodySmall" style={styles.signed} />
              </View>
              <Icon source={expanded ? "chevron-up" : "chevron-down"} size={24} color={BRAND.ink} />
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${sharePercent(person.overall.value, total)}%` }]} />
            </View>
          </ChunkyBox>
        )}
      </Pressable>
      {expanded ? (
        holdings.length === 0 ? (
          <EmptyBox
            text={person.is_me ? "You have no investments yet." : switchToText(person.name)}
            action={{ label: person.is_me ? "Add mine" : `Switch to ${person.name}`, onPress: onAdd }}
          />
        ) : (
          <View style={styles.holdings}>
            {holdings.map((h, i) => (
              <Row
                key={`${h.kind}-${h.symbol ?? ""}-${h.name}-${i}`}
                emoji={kindEmoji(h.kind)}
                tone="card"
                title={h.name}
                meta={
                  <Text variant="bodySmall" style={styles.note}>
                    {holdingDetails(h)}
                  </Text>
                }
                amount={formatRupees(h.value)}
              />
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { paddingBottom: 32 },
  pad: { paddingHorizontal: 16 },
  list: { paddingHorizontal: 16, gap: 10, marginTop: 8 },
  error: { color: BRAND.loss, paddingHorizontal: 16, paddingBottom: 8 },
  card: { padding: 14, gap: 10 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardName: { flex: 1, minWidth: 0, gap: 2 },
  cardEnd: { flexShrink: 1, maxWidth: "55%", alignItems: "flex-end" },
  figure: { fontVariant: ["tabular-nums"], textAlign: "right" },
  track: { height: 10, borderRadius: 999, borderWidth: 2, borderColor: BRAND.ink, backgroundColor: BRAND.zinc100, overflow: "hidden" },
  fill: { height: "100%", backgroundColor: BRAND.purple },
  holdings: { gap: 8, paddingTop: 8, paddingLeft: 12 },
  ink: { color: BRAND.ink },
  note: { color: BRAND.zinc600, fontSize: 12, lineHeight: 16 },
  signed: { fontSize: 12, lineHeight: 16, textAlign: "right" },
  footnote: { paddingHorizontal: 16, paddingTop: 16, textAlign: "center" },
});
