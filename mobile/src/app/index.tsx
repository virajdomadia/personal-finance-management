import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { ActivityIndicator, Appbar, Icon, List, Menu, Text, useTheme } from "react-native-paper";

import { ApiError, apiFetch, type HealthResponse } from "@/lib/api";
import { useSession } from "@/lib/session";

type Status =
  | { kind: "loading" }
  | { kind: "connected"; health: HealthResponse }
  | { kind: "failed"; message: string };

function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) {
    return "The server is up, but its database isn't responding.";
  }
  return "Can't reach the server.";
}

export default function HomeScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  const checkStatus = useCallback(async () => {
    try {
      // Health is public, so the session check is what catches an expired login.
      await apiFetch("/auth/session", { token: token ?? undefined });
      const health = await apiFetch<HealthResponse>("/health");
      setStatus({ kind: "connected", health });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await logOut();
        return;
      }
      setStatus({ kind: "failed", message: failureMessage(error) });
    }
  }, [token, logOut]);

  useEffect(() => {
    // Deferred so the state updates land after this effect, not during it.
    const timer = setTimeout(checkStatus);
    return () => clearTimeout(timer);
  }, [checkStatus]);

  async function refresh() {
    setRefreshing(true);
    await checkStatus();
    setRefreshing(false);
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Appbar.Header>
        <Appbar.Content title="Personal Finance" />
        <Menu
          visible={menuOpen}
          onDismiss={() => setMenuOpen(false)}
          anchor={
            <Appbar.Action
              icon="dots-vertical"
              accessibilityLabel="More options"
              onPress={() => setMenuOpen(true)}
            />
          }
        >
          <Menu.Item leadingIcon="logout" title="Log out" onPress={logOut} />
        </Menu>
      </Appbar.Header>

      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            colors={[colors.primary]}
            progressBackgroundColor={colors.surfaceVariant}
          />
        }
      >
        {status.kind === "loading" && <ActivityIndicator style={{ marginTop: 48 }} />}

        {status.kind === "connected" && (
          <List.Section>
            <List.Subheader>Connection</List.Subheader>
            <List.Item
              title="Server"
              description={`Running in ${status.health.environment}`}
              left={() => <StatusIcon name="cloud-check-outline" color={colors.primary} />}
            />
            <List.Item
              title="Database"
              description={status.health.database === "ok" ? "Connected" : status.health.database}
              left={() => <StatusIcon name="database-check-outline" color={colors.primary} />}
            />
          </List.Section>
        )}

        {status.kind === "failed" && (
          <View
            style={{
              margin: 16,
              padding: 16,
              gap: 4,
              borderRadius: 12,
              backgroundColor: colors.tertiaryContainer,
            }}
          >
            <Text variant="titleMedium" style={{ color: colors.onTertiaryContainer }}>
              {status.message}
            </Text>
            <Text variant="bodyMedium" style={{ color: colors.onTertiaryContainer }}>
              Pull down to try again.
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function StatusIcon({ name, color }: { name: string; color: string }) {
  return (
    <View style={{ justifyContent: "center", paddingLeft: 16 }}>
      <Icon source={name} size={24} color={color} />
    </View>
  );
}
