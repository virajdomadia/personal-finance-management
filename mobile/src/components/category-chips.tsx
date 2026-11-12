import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { Chip } from "@/components/chunky";
import { type CategoryGroup, iconName } from "@/lib/categories";
import { BRAND } from "@/lib/theme";

type Props = {
  groups: CategoryGroup[];
  selected: (name: string) => boolean;
  onPick: (name: string) => void;
  disabled?: boolean;
  before?: ReactNode; // extra chips at the start, like "Any"
};

// A category picker: one chip per category, in the server's order, with a parent's subcategories
// set in under it. Archived categories are left out by the caller (pickerGroups).
export function CategoryChips({ groups, selected, onPick, disabled = false, before }: Props) {
  const chip = (name: string, icon: string | null, sub = false) => (
    <Chip
      key={name}
      label={name}
      icon={iconName(icon)}
      selected={selected(name)}
      disabled={disabled}
      onPress={() => onPick(name)}
      accessibilityRole="radio"
      accessibilityLabel={sub ? `${name}, subcategory` : name}
    />
  );

  // Runs of categories without subcategories share one wrapping line; a parent starts its own block.
  const blocks: ReactNode[] = [];
  let run: ReactNode[] = before ? [before] : [];
  const flush = () => {
    if (run.length > 0) blocks.push(<View key={`run-${blocks.length}`} style={styles.wrap}>{run}</View>);
    run = [];
  };
  for (const g of groups) {
    if (g.children.length === 0) {
      run.push(chip(g.parent.name, g.parent.icon));
      continue;
    }
    flush();
    blocks.push(
      <View key={`group-${g.parent.id}-${g.parent.name}`} style={styles.group}>
        <View style={styles.wrap}>{chip(g.parent.name, g.parent.icon)}</View>
        <View style={[styles.wrap, styles.children]}>{g.children.map((c) => chip(c.name, c.icon, true))}</View>
      </View>,
    );
  }
  flush();

  return (
    <View style={styles.blocks} accessibilityRole="radiogroup">
      {blocks}
    </View>
  );
}

const styles = StyleSheet.create({
  blocks: { gap: 8, marginTop: 8 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  group: { gap: 6 },
  children: { marginLeft: 12, paddingLeft: 10, borderLeftWidth: 2.5, borderLeftColor: BRAND.ink },
});
