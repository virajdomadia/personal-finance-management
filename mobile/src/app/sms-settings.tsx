import { router, useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Linking, PermissionsAndroid, ScrollView, StyleSheet, View } from "react-native";
import { Switch, Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, Row, ScreenHeader } from "@/components/chunky";
import { DateField } from "@/components/date-field";
import { Banner } from "@/components/form-parts";
import { ApiError } from "@/lib/api";
import { bankName, earliestStartDate, readTimeText, smsStatus } from "@/lib/review";
import { useSession } from "@/lib/session";
import { askNotificationPermission, notificationsAllowed } from "@/lib/sms/notifications";
import { loadSmsSettings, saveSmsSettings } from "@/lib/sms/settings";
import type { SmsSettings } from "@/lib/sms/sync";
import { syncSmsNow } from "@/lib/sms/use-sms-sync";
import { BRAND, INPUT_RADIUS, SHADOW_OFFSET_SM } from "@/lib/theme";
import { todayIndia } from "@/lib/transactions";
import { isAvailable, receivesSms, setReceiverEnabled } from "../../modules/sms-inbox";

type Permission = "granted" | "denied" | "blocked";

const DENIED = "Gullak needs permission to read SMS to do this. It stays off until you allow it.";
const BLOCKED = "SMS permission is turned off for Gullak. Allow it in your phone's settings, then switch this on.";

const NOTIFY_DENIED = "Gullak needs permission to send notifications to do this. It stays off until you allow it.";
const NOTIFY_BLOCKED =
  "Notifications are turned off for Gullak. Allow them in your phone's settings, then switch this on.";
const NOTIFY_OFF_IN_SETTINGS =
  "Notifications are turned off for Gullak in your phone's settings, so nothing is shown. SMS are still read.";
const NO_RECEIVE =
  "Without permission to receive SMS, Gullak only notices a new bank SMS when you open the app, and notifies you then.";

function asPermission(result: string | undefined): Permission {
  if (result === PermissionsAndroid.RESULTS.GRANTED) return "granted";
  return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? "blocked" : "denied";
}

// READ_SMS to read the inbox and RECEIVE_SMS to hear a new SMS arrive. Both are in Android's SMS
// group, so the phone asks once. Reading needs only READ_SMS; `receive` says whether arrivals are heard.
async function askForSms(): Promise<{ read: Permission; receive: boolean }> {
  const { READ_SMS, RECEIVE_SMS } = PermissionsAndroid.PERMISSIONS;
  if (!receivesSms()) {
    const read = await PermissionsAndroid.request(READ_SMS, {
      title: "Read bank SMS?",
      message: "Gullak reads messages from banks, cards and CDSL to fill in your transactions. Other messages are never opened.",
      buttonPositive: "Allow",
      buttonNegative: "Not now",
    });
    return { read: asPermission(read), receive: false };
  }
  const results = await PermissionsAndroid.requestMultiple([READ_SMS, RECEIVE_SMS]);
  return { read: asPermission(results[READ_SMS]), receive: results[RECEIVE_SMS] === PermissionsAndroid.RESULTS.GRANTED };
}

function canReceiveSms(): Promise<boolean> {
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECEIVE_SMS);
}

function readResultText(result: { sent: number; unreadable: number } | null): string {
  if (result === null) return "SMS reading is off.";
  const parts = [result.sent === 0 ? "No new bank messages." : `Sent ${result.sent} new ${result.sent === 1 ? "message" : "messages"}.`];
  if (result.unreadable > 0) parts.push(`${result.unreadable} couldn't be read.`);
  return parts.join(" ");
}

export default function SmsSettingsScreen() {
  const { logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const available = isAvailable();
  const [settings, setSettings] = useState<SmsSettings | null>(null);
  const [permissionNote, setPermissionNote] = useState<Permission | null>(null);
  const [revoked, setRevoked] = useState(false);
  // About the notify switch: a refused permission, or notifications turned off in phone settings.
  const [notifyNote, setNotifyNote] = useState<"denied" | "blocked" | "off-in-settings" | "no-receive" | null>(null);
  const [switching, setSwitching] = useState(false);
  const [reading, setReading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const busy = useRef(false);

  const reload = useCallback(async () => {
    const next = await loadSmsSettings();
    setSettings(next);
    // Turned on here once, then the permission was taken away in the phone's settings.
    if (next.enabled && available) {
      const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS);
      setRevoked(!granted);
    } else setRevoked(false);
    // Switched on here, then notifications were turned off in the phone's settings.
    if (next.enabled && next.notify && receivesSms()) {
      const allowed = await notificationsAllowed();
      setNotifyNote((note) => (allowed ? (note === "off-in-settings" ? null : note) : "off-in-settings"));
    }
  }, [available]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  // Reads now and reports how it went. Sync failures are expected (offline, a refused batch), so
  // they show as a line on the screen; the stopped state comes from the stored settings.
  const readNow = useCallback(async () => {
    setReading(true);
    setNotice(null);
    // Without the permission nothing can be read: show "Allow SMS", not a connection error.
    const permitted = () => !available || PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_SMS);
    try {
      if (!(await permitted())) {
        setRevoked(true);
        return;
      }
      const result = await syncSmsNow();
      setNotice({ text: readResultText(result), error: false });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void logOut();
        return;
      }
      if (!(err instanceof ApiError) && !(await permitted())) {
        setRevoked(true);
        return;
      }
      const refused = err instanceof ApiError && err.status === 422;
      setNotice({
        text: refused ? "The server refused these messages, so reading stopped." : "Couldn't read just now. Check your connection and try again.",
        error: true,
      });
    } finally {
      setReading(false);
      await reload();
    }
  }, [available, logOut, reload]);

  async function toggle(on: boolean) {
    if (busy.current) return;
    busy.current = true;
    setSwitching(true);
    setNotice(null);
    try {
      if (!on) {
        setSettings(await saveSmsSettings({ enabled: false }));
        setReceiverEnabled(false);
        setPermissionNote(null);
        setNotifyNote(null);
        return;
      }
      const permission = await askForSms();
      if (permission.read !== "granted") {
        setPermissionNote(permission.read);
        return;
      }
      setPermissionNote(null);
      setRevoked(false);
      let next = await saveSmsSettings({ enabled: true });
      setReceiverEnabled(true);
      // Notifications come on with reading (unless switched off before): ask for them now.
      if (next.notify && receivesSms()) {
        const notify = await askNotificationPermission();
        if (notify !== "granted") {
          next = await saveSmsSettings({ notify: false });
          setNotifyNote(notify === "blocked" ? "blocked" : "denied");
        } else setNotifyNote(permission.receive ? null : "no-receive");
      }
      setSettings(next);
    } finally {
      busy.current = false;
      setSwitching(false);
    }
    if (on) await readNow();
  }

  async function allowAgain() {
    const permission = await askForSms();
    if (permission.read === "granted") {
      setRevoked(false);
      await readNow();
    } else setPermissionNote(permission.read);
  }

  // Off stops the notifications only: an arrived SMS is still read, so balances stay current.
  async function toggleNotify(value: boolean) {
    if (busy.current) return;
    busy.current = true;
    setSwitching(true);
    try {
      if (!value) {
        setSettings(await saveSmsSettings({ notify: false }));
        setNotifyNote(null);
        return;
      }
      let receive = await canReceiveSms();
      if (!receive) receive = (await askForSms()).receive;
      const notify = await askNotificationPermission();
      if (notify !== "granted") {
        setNotifyNote(notify === "blocked" ? "blocked" : "denied");
        return;
      }
      setNotifyNote(receive ? null : "no-receive");
      setSettings(await saveSmsSettings({ notify: true }));
    } finally {
      busy.current = false;
      setSwitching(false);
    }
  }

  async function changeStart(startDate: string) {
    setSettings(await saveSmsSettings({ startDate }));
    // An earlier start date means more to read; a later one changes nothing until new messages come.
    if (settings?.enabled) await readNow();
  }

  if (settings === null) {
    return (
      <View style={[styles.screen, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Bank SMS" back />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.primary} accessibilityLabel="Loading" />
        </View>
      </View>
    );
  }

  const status = smsStatus(settings, available);
  const today = todayIndia();
  const earliest = earliestStartDate(today);
  const on = settings.enabled && available;
  const unreadable = settings.unreadable.length;
  const canNotify = receivesSms();

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Bank SMS" back />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        <ChunkyBox style={styles.card}>
          <View style={styles.switchLine}>
            <Text variant="titleMedium" style={styles.switchLabel}>
              Fill in transactions from bank SMS
            </Text>
            <Switch
              value={on}
              onValueChange={(value) => void toggle(value)}
              disabled={!available || switching}
              color={BRAND.greenStrong}
              accessibilityLabel="Fill in transactions from bank SMS"
            />
          </View>
          {!available ? (
            <Text variant="bodyMedium" style={styles.warn}>
              Needs the latest app version.
            </Text>
          ) : null}
          <Text variant="bodyMedium" style={styles.body}>
            Gullak reads messages from banks, cards, CDSL and NSDL on this phone. Messages from people and other senders are
            never opened.
          </Text>
          <Text variant="bodyMedium" style={styles.body}>
            Only the details are sent: the sender, amount, date, payee, reference, last 4 digits and balance. The message
            text stays on your phone.
          </Text>
          <Text variant="bodyMedium" style={styles.body}>
            Anything Gullak isn&apos;t sure about waits in To review for you.
          </Text>
        </ChunkyBox>

        {on ? (
          <ChunkyBox style={styles.card}>
            <View style={styles.switchLine}>
              <Text variant="titleMedium" style={styles.switchLabel}>
                Notify me when an SMS is recorded
              </Text>
              <Switch
                value={settings.notify && canNotify}
                onValueChange={(value) => void toggleNotify(value)}
                disabled={!canNotify || switching}
                color={BRAND.greenStrong}
                accessibilityLabel="Notify me when an SMS is recorded"
              />
            </View>
            {!canNotify ? (
              <Text variant="bodyMedium" style={styles.warn}>
                Needs the latest app version.
              </Text>
            ) : null}
            <Text variant="bodyMedium" style={styles.body}>
              When a bank SMS arrives, Gullak reads it straight away, even with the app closed, and tells you what it
              recorded or what needs your answer. The message text is never shown. Switched off, new SMS are still read.
            </Text>
          </ChunkyBox>
        ) : null}
        {on && notifyNote === "denied" ? <Banner messages={[NOTIFY_DENIED]} /> : null}
        {on && (notifyNote === "blocked" || notifyNote === "off-in-settings") ? (
          <View style={styles.group}>
            <Banner messages={[notifyNote === "blocked" ? NOTIFY_BLOCKED : NOTIFY_OFF_IN_SETTINGS]} />
            <ChunkyButton variant="alt" label="Open phone settings" onPress={() => void Linking.openSettings()} />
          </View>
        ) : null}
        {on && notifyNote === "no-receive" ? <Banner messages={[NO_RECEIVE]} tone="info" /> : null}

        {permissionNote === "denied" ? <Banner messages={[DENIED]} /> : null}
        {permissionNote === "blocked" ? (
          <View style={styles.group}>
            <Banner messages={[BLOCKED]} />
            <ChunkyButton variant="alt" label="Open phone settings" onPress={() => void Linking.openSettings()} />
          </View>
        ) : null}
        {revoked && permissionNote === null ? (
          <View style={styles.group}>
            <Banner messages={["SMS permission was turned off, so nothing is read. Allow it again to carry on."]} />
            <ChunkyButton variant="alt" label="Allow SMS" onPress={() => void allowAgain()} />
          </View>
        ) : null}

        {status === "stopped" ? (
          <ChunkyBox radius={14} offset={3} style={[styles.stopped, { backgroundColor: colors.errorContainer }]}>
            <Text variant="titleMedium" accessibilityRole="alert" style={{ color: colors.onErrorContainer }}>
              Sync stopped
            </Text>
            <Text variant="bodyMedium" style={{ color: colors.onErrorContainer }}>
              The server refused 3 messages in a row, so reading paused to keep them safe. Nothing is lost: they&apos;re read
              again next time. If this keeps happening, update the app.
            </Text>
            <ChunkyButton label="Read now" onPress={() => void readNow()} loading={reading} style={styles.start} />
          </ChunkyBox>
        ) : null}

        {notice !== null ? <Banner messages={[notice.text]} tone={notice.error ? "error" : "info"} /> : null}

        <DateField
          label="Read messages from"
          value={settings.startDate < earliest ? earliest : settings.startDate}
          onChange={(iso) => void changeStart(iso < earliest ? earliest : iso > today ? today : iso)}
          disabled={!available || reading}
          maxDate={today}
          minDate={earliest}
          chips={[
            { label: "Today", value: today },
            { label: "90 days ago", value: earliest },
          ]}
          helper="Up to 90 days back. Messages already sent are not added twice."
        />

        <ChunkyBox style={styles.card}>
          <View style={styles.fact}>
            <Text variant="labelLarge" style={styles.factLabel}>
              Last read
            </Text>
            <Text variant="bodyMedium" style={styles.factValue}>
              {readTimeText(settings.lastSyncAt)}
            </Text>
          </View>
          <View style={styles.fact}>
            <Text variant="labelLarge" style={styles.factLabel}>
              Banks found
            </Text>
            <Text variant="bodyMedium" style={styles.factValue}>
              {settings.banks.length === 0 ? "None yet" : settings.banks.map(bankName).join(", ")}
            </Text>
          </View>
          {status !== "stopped" ? (
            <ChunkyButton
              variant="alt"
              icon="refresh"
              label="Read now"
              onPress={() => void readNow()}
              loading={reading}
              disabled={!on || switching}
              style={styles.start}
            />
          ) : null}
        </ChunkyBox>

        <View style={styles.group}>
          <Row
            emoji="🤔"
            tone="card"
            title={`Couldn't read (${unreadable})`}
            meta="Bank messages Gullak didn't understand. Kept on this phone."
            amount="›"
            onPress={() => router.push("/sms-unreadable")}
            accessibilityLabel={`Couldn't read, ${unreadable} ${unreadable === 1 ? "message" : "messages"}`}
            accessibilityHint="Opens the list"
          />
          <Row
            emoji="📩"
            tone="orange"
            title="To review"
            meta="Messages waiting for your answer"
            amount="›"
            onPress={() => router.push("/review")}
            accessibilityLabel="To review"
            accessibilityHint="Opens To review"
          />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  content: { padding: 16, gap: 14 },
  card: { padding: 14, gap: 10 },
  switchLine: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchLabel: { flex: 1, color: BRAND.ink },
  body: { color: BRAND.zinc600 },
  warn: { color: BRAND.loss },
  group: { gap: 8 },
  stopped: { padding: 14, gap: 8, borderRadius: INPUT_RADIUS },
  start: { alignSelf: "flex-start", marginTop: SHADOW_OFFSET_SM },
  fact: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  factLabel: { color: BRAND.ink },
  factValue: { flexShrink: 1, textAlign: "right", color: BRAND.ink },
});
