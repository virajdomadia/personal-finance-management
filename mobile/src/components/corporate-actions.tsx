import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { Button, Dialog, HelperText, Portal, Text, TextInput } from "react-native-paper";

import { ChunkyBox, ChunkyButton, Chip } from "@/components/chunky";
import { Banner } from "@/components/form-parts";
import { SectionTitle } from "@/components/investment-parts";
import { errorMessage, formatRupees, splitErrors } from "@/lib/accounts";
import { ApiError, apiFetch } from "@/lib/api";
import {
  type ActionList,
  type CorporateAction,
  type Stock,
  type StockActions,
  canConfirm,
  cleanPercent,
  describeAction,
  describePreview,
  dividendLabel,
  isUpcoming,
  needsTarget,
  ratioProblem,
} from "@/lib/investments";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";
import { formatDate, todayIndia } from "@/lib/transactions";

// What the target dialog adds to the PATCH that confirms a merger or demerger.
type TargetFields = { target_stock_id: number; ratio_new: string; ratio_old: string; cost_share_pct?: string };
type Change = { status?: "pending" | "applied" | "dismissed" } & Partial<TargetFields>;

// What to show for a failed request: a 409 or 422 carries the server's own words.
function failureText(err: unknown): string {
  if (err instanceof ApiError && err.status === 422) {
    const { fields, general } = splitErrors(err.detail, ["target_stock_id", "cost_share_pct", "ratio_new", "ratio_old"]);
    const all = [...Object.values(fields), ...general];
    if (all.length > 0) return all.join(" ");
  }
  return errorMessage(err instanceof ApiError ? { detail: err.detail } : err);
}

// Sends one change to an action. Returns the error text, or null when it worked. A 401 signs out.
function useUpdateAction() {
  const { token, logOut } = useSession();
  return useCallback(
    async (id: number, body: Change): Promise<string | null> => {
      try {
        await apiFetch(`/investments/actions/${id}`, { method: "PATCH", token: token ?? undefined, body });
        return null;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          void logOut();
          return "";
        }
        return failureText(err);
      }
    },
    [token, logOut],
  );
}

// Picks the stock a merger or demerger moves into, how many new shares come for how many held (the
// exchange's notice never says) and, for a demerger, the share of cost that goes.
function TargetDialog({
  action,
  onClose,
  onConfirm,
}: {
  action: CorporateAction;
  onClose: () => void;
  onConfirm: (fields: TargetFields) => Promise<string | null>;
}) {
  const { token } = useSession();
  const demerger = action.kind === "demerger";
  const [stocks, setStocks] = useState<Stock[] | null>(null);
  const [target, setTarget] = useState<number | null>(action.target_stock_id);
  const [pct, setPct] = useState(action.cost_share_pct ?? "");
  const [ratioNew, setRatioNew] = useState(action.ratio_new ?? "");
  const [ratioOld, setRatioOld] = useState(action.ratio_old ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    apiFetch<{ stocks: Stock[] }>("/investments/stocks", { token: token ?? undefined })
      .then((res) => setStocks(res.stocks.filter((s) => s.id !== action.stock_id)))
      .catch((err: unknown) => {
        setStocks([]);
        setError(failureText(err));
      });
  }, [token, action.stock_id]);

  async function submit() {
    if (savingRef.current) return;
    if (target === null) {
      setError("Pick the stock the shares move into.");
      return;
    }
    const badRatio = ratioProblem(ratioNew, ratioOld);
    if (badRatio !== null) {
      setError(badRatio);
      return;
    }
    if (demerger && (pct === "" || Number(pct) <= 0 || Number(pct) >= 100)) {
      setError("Enter the share of cost that moves, above 0 and below 100.");
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    const message = await onConfirm({
      target_stock_id: target,
      ratio_new: ratioNew,
      ratio_old: ratioOld,
      ...(demerger ? { cost_share_pct: pct } : {}),
    });
    savingRef.current = false;
    setSaving(false);
    if (message) setError(message);
  }

  return (
    <Dialog visible onDismiss={() => (saving ? undefined : onClose())}>
      <Dialog.Title>
        Confirm {action.symbol} {demerger ? "demerger" : "merger"}
      </Dialog.Title>
      <Dialog.Content>
        <Text variant="bodyMedium" style={styles.dialogLine}>
          {describeAction(action)}
        </Text>
        <Text variant="labelLarge">{demerger ? "New company's stock" : "Merged into"}</Text>
        {stocks === null ? (
          <Text variant="bodySmall" style={styles.muted}>
            Loading...
          </Text>
        ) : stocks.length === 0 ? (
          <Text variant="bodySmall" style={styles.muted}>
            Add the other stock first, then come back.
          </Text>
        ) : (
          <ScrollView style={styles.stockList} contentContainerStyle={styles.stockChips} nestedScrollEnabled>
            {stocks.map((s) => (
              <Chip
                key={s.id}
                label={`${s.symbol} · ${s.name}`}
                selected={target === s.id}
                disabled={saving}
                accessibilityRole="radio"
                onPress={() => setTarget(s.id)}
              />
            ))}
          </ScrollView>
        )}
        <View style={styles.ratio}>
          <TextInput
            mode="outlined"
            label="New shares"
            keyboardType="decimal-pad"
            value={ratioNew}
            disabled={saving}
            onChangeText={(v) => setRatioNew(cleanPercent(v))}
            style={styles.ratioField}
          />
          <TextInput
            mode="outlined"
            label="For shares held"
            keyboardType="decimal-pad"
            value={ratioOld}
            disabled={saving}
            onChangeText={(v) => setRatioOld(cleanPercent(v))}
            style={styles.ratioField}
          />
        </View>
        {demerger ? (
          <TextInput
            mode="outlined"
            label="Share of cost that moves (%)"
            keyboardType="decimal-pad"
            value={pct}
            disabled={saving}
            onChangeText={(v) => setPct(cleanPercent(v))}
            style={styles.pct}
          />
        ) : null}
        {error ? (
          <HelperText type="error" visible accessibilityRole="alert">
            {error}
          </HelperText>
        ) : null}
      </Dialog.Content>
      <Dialog.Actions>
        <Button onPress={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button onPress={() => void submit()} loading={saving} disabled={saving}>
          Confirm
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
}

// Waiting on the user: splits, bonuses and the like the exchange announced. Nothing is applied until
// they confirm. Loads its own list again whenever `reloadKey` changes, and calls onChanged after a
// confirm so the page reloads its figures.
export function ActionsReview({ reloadKey, onChanged }: { reloadKey: unknown; onChanged: () => void }) {
  const { token, logOut } = useSession();
  const update = useUpdateAction();
  const [actions, setActions] = useState<CorporateAction[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targeting, setTargeting] = useState<CorporateAction | null>(null);
  const latest = useRef(0);

  const load = useCallback(() => {
    const mine = ++latest.current;
    apiFetch<ActionList>("/investments/actions?status=pending", { token: token ?? undefined })
      .then((res) => {
        if (mine === latest.current) setActions(res.actions);
      })
      .catch((err: unknown) => {
        // A nicety: if it can't load, the tab carries on without the card.
        if (err instanceof ApiError && err.status === 401) void logOut();
      });
  }, [token, logOut]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  async function change(action: CorporateAction, body: Change): Promise<string | null> {
    setBusy(action.id);
    setError(null);
    const message = await update(action.id, body);
    setBusy(null);
    if (message === null) {
      load();
      onChanged();
    }
    return message;
  }

  async function confirm(action: CorporateAction) {
    if (needsTarget(action)) {
      setTargeting(action);
      return;
    }
    const message = await change(action, { status: "applied" });
    if (message) setError(message);
  }

  async function dismiss(action: CorporateAction) {
    const message = await change(action, { status: "dismissed" });
    if (message) setError(message);
  }

  if (actions.length === 0) return null;
  return (
    <ChunkyBox style={styles.card}>
      <Text variant="titleMedium" accessibilityRole="header">
        {actions.length === 1 ? "A corporate action needs your OK" : `${actions.length} corporate actions need your OK`}
      </Text>
      <Text variant="bodySmall" style={styles.muted}>
        Confirm each one that applies to you and your shares and average cost update.
      </Text>
      {error ? <Banner messages={[error]} /> : null}
      {actions.map((a) => {
        const preview = describePreview(a.preview);
        return (
          <View key={a.id} style={styles.item}>
            <Text
              variant="bodyMedium"
              style={styles.bold}
              accessibilityRole="link"
              onPress={() => router.push({ pathname: "/stock", params: { id: String(a.stock_id), symbol: a.symbol } })}
            >
              {a.symbol} {describeAction(a)}
            </Text>
            {preview ? (
              <Text variant="bodySmall" style={styles.muted}>
                {preview}
              </Text>
            ) : null}
            <View style={styles.buttons}>
              <ChunkyButton
                compact
                variant="alt"
                label="Dismiss"
                accessibilityLabel={`Dismiss ${a.symbol}: ${describeAction(a)}`}
                disabled={busy !== null}
                onPress={() => void dismiss(a)}
              />
              {canConfirm(a) ? (
                <ChunkyButton
                  compact
                  label="Confirm"
                  accessibilityLabel={`Confirm ${a.symbol}: ${describeAction(a)}`}
                  loading={busy === a.id}
                  disabled={busy !== null}
                  onPress={() => void confirm(a)}
                />
              ) : null}
            </View>
          </View>
        );
      })}
      <Portal>
        {targeting ? (
          <TargetDialog
            action={targeting}
            onClose={() => setTargeting(null)}
            onConfirm={async (fields) => {
              const message = await change(targeting, { status: "applied", ...fields });
              if (message === null) setTargeting(null);
              return message;
            }}
          />
        ) : null}
      </Portal>
    </ChunkyBox>
  );
}

const STATUS_BADGE: Record<CorporateAction["status"], string> = {
  pending: "Needs your OK",
  applied: "Applied",
  dismissed: "Dismissed",
};

// How many times to look again while the server is still fetching a new stock's history.
const BACKFILL_RETRIES = 5;
const BACKFILL_WAIT_MS = 4000;

// The stock screen's actions and dividends, with Undo on applied ones and the suspect-drop notice.
export function StockActionsSection({ stock, onChanged }: { stock: { id: number; symbol: string }; onChanged: () => void }) {
  const { token, logOut } = useSession();
  const update = useUpdateAction();
  const [data, setData] = useState<StockActions | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [targeting, setTargeting] = useState<CorporateAction | null>(null);
  const latest = useRef(0);
  const retries = useRef(0);
  const today = todayIndia();

  const load = useCallback(() => {
    const mine = ++latest.current;
    apiFetch<StockActions>(`/investments/stocks/${stock.id}/actions`, { token: token ?? undefined })
      .then((res) => {
        if (mine !== latest.current) return;
        setData(res);
        setFailed(false);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logOut();
        else if (mine === latest.current) setFailed(true);
      });
  }, [stock.id, token, logOut]);

  useEffect(() => {
    load();
  }, [load]);

  // A stock added a moment ago is still having its past actions fetched: look again shortly.
  const backfilled = data?.backfilled ?? true;
  useEffect(() => {
    if (backfilled || retries.current >= BACKFILL_RETRIES) return;
    const timer = setTimeout(() => {
      retries.current += 1;
      load();
    }, BACKFILL_WAIT_MS);
    return () => clearTimeout(timer);
  }, [backfilled, data, load]);

  async function run(id: number, body: Change): Promise<string | null> {
    setBusy(true);
    setError(null);
    const message = await update(id, body);
    setBusy(false);
    if (message === null) {
      load();
      onChanged();
    } else if (message) setError(message);
    return message;
  }

  async function dismissDrop() {
    setBusy(true);
    setError(null);
    try {
      setData(await apiFetch<StockActions>(`/investments/stocks/${stock.id}/suspect-drop`, { method: "DELETE", token: token ?? undefined }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) void logOut();
      else setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  const confirm = (a: CorporateAction) => {
    if (needsTarget(a)) setTargeting(a);
    else void run(a.id, { status: "applied" });
  };

  return (
    <View>
      <SectionTitle label="Actions & dividends" />
      <View style={styles.section}>
        {data && !data.backfilled ? (
          <Text variant="bodySmall" style={styles.muted} accessibilityLiveRegion="polite">
            Checking past corporate actions…
          </Text>
        ) : null}

        {data?.suspect_drop_on ? (
          <ChunkyBox style={styles.notice}>
            <Text variant="bodyMedium" style={styles.bold}>
              Price fell sharply on {formatDate(data.suspect_drop_on)}. Was there a split or bonus?
            </Text>
            <View style={styles.buttons}>
              <ChunkyButton compact variant="alt" label="Dismiss" disabled={busy} onPress={() => void dismissDrop()} />
            </View>
          </ChunkyBox>
        ) : null}

        {error ? <Banner messages={[error]} /> : null}

        {failed && !data ? (
          <View style={styles.item}>
            <Text variant="bodyMedium">We couldn&apos;t load the actions.</Text>
            <View style={styles.buttons}>
              <ChunkyButton compact variant="alt" label="Try again" onPress={load} />
            </View>
          </View>
        ) : data === null ? (
          <Text variant="bodySmall" style={styles.muted}>
            Loading...
          </Text>
        ) : data.actions.length === 0 ? (
          <Text variant="bodyMedium" style={styles.muted}>
            No splits, bonuses or dividends for {stock.symbol} yet.
          </Text>
        ) : (
          data.actions.map((a) => {
            const preview = describePreview(a.preview);
            const money = dividendLabel(a, today);
            return (
              <ChunkyBox key={a.id} style={styles.card}>
                <Text variant="bodyMedium" style={styles.bold}>
                  {describeAction(a)}
                  {isUpcoming(a, today) ? "  (upcoming)" : ""}
                </Text>
                <Text variant="bodySmall" style={styles.muted}>
                  {STATUS_BADGE[a.status]}
                  {money ? ` · ${money}` : ""}
                  {a.status === "applied" && a.dividend && a.dividend.by_account.length > 0
                    ? ` · ${a.dividend.by_account.map((x) => `${x.account_name} ${formatRupees(x.gross)}`).join(", ")}`
                    : ""}
                </Text>
                {preview ? (
                  <Text variant="bodySmall" style={styles.muted}>
                    {preview}
                  </Text>
                ) : null}
                <View style={styles.buttons}>
                  {a.status === "pending" ? (
                    <>
                      <ChunkyButton compact variant="alt" label="Dismiss" disabled={busy} onPress={() => void run(a.id, { status: "dismissed" })} />
                      {canConfirm(a) ? <ChunkyButton compact label="Confirm" disabled={busy} onPress={() => confirm(a)} /> : null}
                    </>
                  ) : null}
                  {a.status === "applied" && a.kind === "dividend" ? (
                    <ChunkyButton
                      compact
                      variant="alt"
                      label="Dismiss"
                      accessibilityLabel={`Dismiss ${describeAction(a)}`}
                      disabled={busy}
                      onPress={() => void run(a.id, { status: "dismissed" })}
                    />
                  ) : null}
                  {a.status === "applied" ? (
                    <ChunkyButton
                      compact
                      variant="alt"
                      label="Undo"
                      accessibilityLabel={`Undo ${describeAction(a)}`}
                      disabled={busy}
                      onPress={() => void run(a.id, { status: "pending" })}
                    />
                  ) : null}
                  {a.status === "dismissed" ? (
                    <ChunkyButton compact variant="alt" label="Restore" disabled={busy} onPress={() => void run(a.id, { status: "pending" })} />
                  ) : null}
                </View>
              </ChunkyBox>
            );
          })
        )}
      </View>
      <Portal>
        {targeting ? (
          <TargetDialog
            action={targeting}
            onClose={() => setTargeting(null)}
            onConfirm={async (fields) => {
              const message = await run(targeting.id, { status: "applied", ...fields });
              if (message === null) setTargeting(null);
              return message;
            }}
          />
        ) : null}
      </Portal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, gap: 4, marginBottom: 4 },
  section: { paddingHorizontal: 16, gap: 8 },
  notice: { padding: 12, gap: 8, backgroundColor: BRAND.due },
  item: { gap: 4, paddingTop: 10 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 6 },
  bold: { fontWeight: "700" },
  muted: { color: BRAND.zinc600 },
  dialogLine: { marginBottom: 10 },
  stockList: { maxHeight: 180, marginTop: 6 },
  stockChips: { gap: 8, paddingVertical: 4 },
  pct: { marginTop: 12 },
  ratio: { flexDirection: "row", gap: 8, marginTop: 12 },
  ratioField: { flex: 1 },
});
