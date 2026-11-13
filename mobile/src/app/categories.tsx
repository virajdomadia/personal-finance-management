import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, HeaderAction, ScreenHeader, Segmented, Tag } from "@/components/chunky";
import { CategoryIcon } from "@/components/category-icon";
import { Banner } from "@/components/form-parts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  CATEGORIES_PATH,
  CATEGORY_KINDS,
  type Category,
  type CategoryKind,
  type CategoryTree,
  categorySections,
  usageText,
} from "@/lib/categories";
import { useSession } from "@/lib/session";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";

const FAILED = "We couldn't load your categories.";

function CategoryRow({ category, sub = false, onPress }: { category: Category; sub?: boolean; onPress: () => void }) {
  const usage = usageText(category.transaction_count);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[category.name, sub ? "subcategory" : null, usage, category.fixed ? "built in" : null].filter(Boolean).join(", ")}
      accessibilityHint="Opens the category"
      style={sub ? styles.sub : null}
    >
      {({ pressed }) => (
        <ChunkyBox pressed={pressed} radius={INPUT_RADIUS} offset={SHADOW_OFFSET_SM} style={styles.row}>
          <CategoryIcon icon={category.icon} colour={category.colour} size={sub ? 32 : 38} />
          <View style={styles.main}>
            <Text variant="titleMedium" style={styles.name}>
              {category.name}
            </Text>
            <Text variant="bodySmall" style={styles.muted}>
              {usage}
            </Text>
            {category.fixed ? <Tag label="Built in" /> : null}
          </View>
          <Icon source="chevron-right" size={22} color={BRAND.ink} />
        </ChunkyBox>
      )}
    </Pressable>
  );
}

export default function CategoriesScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [tree, setTree] = useState<CategoryTree | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef(0);
  const navigating = useRef(false);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const result = await apiFetch<CategoryTree>(CATEGORIES_PATH, { token: token ?? undefined });
      if (mine !== latest.current) return;
      setTree(result);
      setFailed(false);
    } catch (err) {
      if (mine !== latest.current) return;
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setFailed(true);
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

  const go = (params: { id?: string; kind?: string }) => {
    if (navigating.current) return;
    navigating.current = true;
    router.push({ pathname: "/category-form", params });
  };
  const add = () => go({ kind });

  const sections = tree ? categorySections(tree[kind]) : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Categories" back right={<HeaderAction icon="plus" label="New category" onPress={add} />} />

      {tree === null && !failed ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading categories" />
        </View>
      ) : sections === null ? (
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
          <Segmented label="Kind of category" value={kind} onChange={setKind} options={CATEGORY_KINDS} />

          {sections.live.length === 0 ? (
            <Text variant="bodyMedium" style={[styles.muted, styles.centerText]}>
              No categories here yet.
            </Text>
          ) : (
            <View style={styles.list}>
              {sections.live.map((group) => (
                <View key={group.parent.id} style={styles.group}>
                  <CategoryRow category={group.parent} onPress={() => go({ id: String(group.parent.id) })} />
                  {group.children.map((child) => (
                    <CategoryRow key={child.id} category={child} sub onPress={() => go({ id: String(child.id) })} />
                  ))}
                </View>
              ))}
            </View>
          )}

          <ChunkyButton label="New category" icon="plus" variant="alt" onPress={add} />

          {sections.archived.length > 0 ? (
            <>
              <Text variant="titleSmall" accessibilityRole="header" style={styles.section}>
                ARCHIVED
              </Text>
              <Text variant="bodySmall" style={styles.muted}>
                Archived categories keep their transactions but aren&apos;t offered when you pick one.
              </Text>
              <View style={styles.list}>
                {sections.archived.map((c) => (
                  <CategoryRow key={c.id} category={c} onPress={() => go({ id: String(c.id) })} />
                ))}
              </View>
            </>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  list: { gap: 10 },
  group: { gap: 8 },
  sub: { marginLeft: 28 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  main: { flex: 1, minWidth: 0 },
  name: { color: BRAND.ink, fontSize: 16, lineHeight: 22 },
  muted: { color: BRAND.zinc600 },
  section: { color: BRAND.ink, letterSpacing: 0.6, marginTop: 8 },
});
