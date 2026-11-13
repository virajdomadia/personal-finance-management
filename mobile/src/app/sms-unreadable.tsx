import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, Portal, Snackbar, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { errorMessage } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import { readTimeText, samplePayload } from "@/lib/review";
import { useSession } from "@/lib/session";
import { loadClipboard, NEEDS_UPDATE } from "@/lib/native";
import { loadSmsSettings, updateSmsSettings } from "@/lib/sms/settings";
import type { RawSms } from "@/lib/sms/sync";
import { BRAND } from "@/lib/theme";

// Bank messages no parser understood. They live on this phone only; "Send sample" shares a masked
// copy so the parser can learn the format.
export default function SmsUnreadableScreen() {
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<RawSms[] | null>(null);
  const [sending, setSending] = useState<RawSms | null>(null);
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const busy = useRef(false);

  const reload = useCallback(async () => {
    setMessages((await loadSmsSettings()).unreadable);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // The dialog renders above the app's lock cover, so it must not stay open when the app leaves.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && !busy.current) setSending(null);
    });
    return () => subscription.remove();
  }, []);

  async function copy(message: RawSms) {
    // Loaded here, not at the top: Expo Router imports every screen at start-up, and a build
    // without expo-clipboard would otherwise crash the whole app.
    const Clipboard = loadClipboard();
    if (Clipboard === null) {
      setToast(NEEDS_UPDATE);
      return;
    }
    await Clipboard.setStringAsync(message.body);
    setToast("Copied");
  }

  async function send(message: RawSms) {
    if (busy.current) return;
    busy.current = true;
    setPosting(true);
    setNotice(null);
    try {
      // Only the masked copy leaves the phone, exactly as the dialog showed it.
      await apiFetch("/sms/samples", { method: "POST", token: token ?? undefined, body: samplePayload(message) });
      const next = await updateSmsSettings((current) => ({ unreadable: current.unreadable.filter((m) => m.id !== message.id) }));
      setMessages(next.unreadable);
      setToast("Sample sent. Thanks!");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      setNotice(err instanceof ApiError ? errorMessage({ detail: err.detail }) : "Couldn't send it. Check your connection and try again.");
    } finally {
      busy.current = false;
      setPosting(false);
      setSending(null);
    }
  }

  const preview = sending ? samplePayload(sending) : null;

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Couldn't read" back />
      {messages === null ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
          <Text variant="bodyMedium" style={styles.muted}>
            Bank messages Gullak didn&apos;t understand. They stay on this phone. Send a sample to help it learn the format:
            numbers and names are hidden first.
          </Text>
          {notice !== null ? <Banner messages={[notice]} /> : null}
          {messages.length === 0 ? (
            <View style={styles.empty}>
              <Text variant="titleMedium">Nothing here</Text>
              <Text variant="bodyMedium" style={[styles.muted, styles.centerText]}>
                Every bank message so far was read.
              </Text>
            </View>
          ) : (
            messages.map((m) => (
              <ChunkyBox key={m.id} style={styles.card}>
                <View style={styles.headLine}>
                  <Text variant="titleSmall" style={styles.sender}>
                    {m.address}
                  </Text>
                  <Text variant="bodySmall" style={styles.muted}>
                    {readTimeText(m.date)}
                  </Text>
                </View>
                <Text variant="bodyMedium" selectable style={styles.text}>
                  {m.body}
                </Text>
                <View style={styles.actions}>
                  <ChunkyButton compact variant="alt" icon="content-copy" label="Copy" onPress={() => void copy(m)} />
                  <ChunkyButton
                    compact
                    variant="green"
                    icon="send"
                    label="Send sample"
                    disabled={posting}
                    onPress={() => setSending(m)}
                  />
                </View>
              </ChunkyBox>
            ))
          )}
        </ScrollView>
      )}

      <Portal>
        <Dialog visible={preview !== null} onDismiss={() => (posting ? undefined : setSending(null))}>
          <Dialog.Title>Send this sample?</Dialog.Title>
          <Dialog.ScrollArea style={styles.dialogArea}>
            <ScrollView contentContainerStyle={styles.dialogContent}>
              <Text variant="bodyMedium">Only this masked copy is sent. Numbers became X and names became &lt;name&gt;.</Text>
              {preview ? (
                <View style={styles.preview}>
                  <Text variant="labelLarge" style={styles.sender}>
                    {preview.sender}
                  </Text>
                  <Text variant="bodyMedium" style={styles.text}>
                    {preview.text}
                  </Text>
                </View>
              ) : null}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setSending(null)} disabled={posting}>
              Cancel
            </Button>
            <Button onPress={() => sending && void send(sending)} loading={posting} disabled={posting}>
              Send
            </Button>
          </Dialog.Actions>
        </Dialog>
        <Snackbar visible={toast !== null} onDismiss={() => setToast(null)} duration={2500}>
          {toast ?? ""}
        </Snackbar>
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  centerText: { textAlign: "center" },
  content: { padding: 16, gap: 12 },
  muted: { color: BRAND.zinc600 },
  empty: { alignItems: "center", gap: 8, paddingVertical: 32 },
  card: { padding: 14, gap: 8 },
  headLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 8 },
  sender: { color: BRAND.ink, flexShrink: 1 },
  text: { color: BRAND.ink },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 8 },
  dialogArea: { paddingHorizontal: 0, maxHeight: 360 },
  dialogContent: { paddingHorizontal: 24, paddingVertical: 12, gap: 12 },
  preview: { borderWidth: 1.5, borderColor: BRAND.ink, borderRadius: 12, padding: 10, gap: 4, backgroundColor: BRAND.zinc100 },
});
