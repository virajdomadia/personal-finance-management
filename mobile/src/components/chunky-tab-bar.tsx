import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { BottomTabBarProps } from "expo-router/tabs";
import { Pressable, StyleSheet, View } from "react-native";

import { ChunkyBox } from "@/components/chunky";
import { BRAND, INPUT_RADIUS } from "@/lib/theme";

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>["name"];

const TAB_ICONS: Record<string, { focusedIcon: string; unfocusedIcon: string }> = {
  index: { focusedIcon: "view-dashboard", unfocusedIcon: "view-dashboard-outline" },
  accounts: { focusedIcon: "wallet", unfocusedIcon: "wallet-outline" },
  transactions: { focusedIcon: "swap-horizontal-bold", unfocusedIcon: "swap-horizontal" },
  investments: { focusedIcon: "chart-line", unfocusedIcon: "chart-line-variant" },
  profile: { focusedIcon: "account", unfocusedIcon: "account-outline" },
};

// A floating bar: an ink-bordered card with an icon per tab and a yellow pill on the selected one.
// The label stays as the accessibility label; the bar sits in the layout, so no screen goes under it.
export function ChunkyTabBar({ state, descriptors, emitter, navigateToTab, insets }: BottomTabBarProps) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 8), paddingLeft: 12 + insets.left, paddingRight: 12 + insets.right }]}>
      <ChunkyBox style={styles.box}>
        {state.routes.map((route, index) => {
          const focused = state.index === index;
          const icons = TAB_ICONS[route.name];
          const title = descriptors[route.key].options.title ?? route.name;
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityLabel={title}
              accessibilityState={{ selected: focused }}
              hitSlop={{ top: 6, bottom: 6 }}
              onPress={() => {
                const event = emitter.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!focused && !event.defaultPrevented) navigateToTab(route.key);
              }}
              style={[styles.tab, focused ? styles.tabOn : null]}
            >
              <MaterialCommunityIcons
                name={(focused ? icons?.focusedIcon : icons?.unfocusedIcon) as IconName}
                size={26}
                color={BRAND.ink}
              />
            </Pressable>
          );
        })}
      </ChunkyBox>
    </View>
  );
}


const styles = StyleSheet.create({
  bar: { paddingTop: 4, backgroundColor: "transparent" },
  box: { flexDirection: "row", justifyContent: "space-around", alignItems: "center", padding: 6 },
  tab: {
    minWidth: 52,
    height: 44,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: INPUT_RADIUS - 2,
    borderWidth: 2.5,
    borderColor: "transparent",
  },
  tabOn: { backgroundColor: BRAND.yellow, borderColor: BRAND.ink },
});
