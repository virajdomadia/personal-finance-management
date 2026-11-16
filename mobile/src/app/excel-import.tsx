import { useLocalSearchParams } from "expo-router";
import { memo, useCallback, useRef, useState } from "react";
import { FlatList, StyleSheet, View } from "react-native";
import { Text, useTheme } from "react-native-paper";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ChunkyBox, ChunkyButton, ScreenHeader, Tag, Tile, type Tone } from "@/components/chunky";
import { Banner, useBlockBack } from "@/components/form-parts";
import { ApiError, apiUpload } from "@/lib/api";
import { ExportError, exportError } from "@/lib/data-export";
import {
  type HoldingRow,
  IMPORTS,
  type ImportKind,
  type ImportReport,
  type ImportRow,
  type ImportStatus,
  XLSX_TYPE,
  canImport,
  importButton,
  importError,
  importKind,
  importedMessage,
  previewSummary,
  problemLines,
  rowCard,
  statusLabel,
  summaryCounts,
} from "@/lib/excel-import";
import { shareDownload } from "@/lib/export-share";
import { pickErrorMessage, pickFile } from "@/lib/file-pick";
import { useSession } from "@/lib/session";
import { BRAND } from "@/lib/theme";

type AnyRow = ImportRow | HoldingRow;
type Busy = "template" | "pick" | "preview" | "import" | null;

const INTRO: Record<ImportKind, string> = {
  transactions:
    "Get the template, fill it in Excel or Google Sheets, then choose the file here. You'll see every row before anything is saved, and rows already saved are skipped.",
  holdings:
    "For stocks, mutual funds and crypto you already own. Get the template, fill it in Excel or Google Sheets, then choose the file here. You'll see every row before anything is saved.",
};

const COUNT_TONE: Record<ImportStatus, Tone> = { ok: "green", duplicate: "card", error: "pink" };

// Importing transactions or holdings from an Excel workbook: get the template, choose the filled
// file, check the server's report, then import. `kind` is "transactions" or "holdings".
export default function ExcelImportScreen() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const kind = importKind(params.kind);
  const config = IMPORTS[kind];
  const { token, logOut } = useSession();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport<AnyRow> | null>(null);
  const bytes = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useBlockBack(useCallback(() => busyRef.current, []));

  const run = async (step: Exclude<Busy, null>, work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(step);
    setErrors([]);
    setDone(null);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  // A request's failure: 401 signs out, anything else is a banner.
  const fail = (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        void logOut();
        return;
      }
      setErrors([importError(err.status, err.detail)]);
      return;
    }
    setErrors([importError(500, undefined)]);
  };

  const getTemplate = () =>
    run("template", async () => {
      try {
        await shareDownload(
          { path: config.paths.template, fallback: config.fallback, mimeType: XLSX_TYPE, title: config.templateTitle },
          token ?? undefined,
        );
      } catch (err) {
        const failure = err instanceof ExportError ? err.failure : ({ stage: "save" } as const);
        if (failure.stage === "server" && failure.status === 401) void logOut();
        else setErrors([exportError(failure)]);
      }
    });

  const send = async (path: string): Promise<ImportReport<AnyRow> | null> => {
    if (bytes.current === null) return null;
    try {
      return await apiUpload<ImportReport<AnyRow>>(path, {
        token: token ?? undefined,
        bytes: bytes.current,
        contentType: XLSX_TYPE,
      });
    } catch (err) {
      fail(err);
      return null;
    }
  };

  const chooseFile = () =>
    run("pick", async () => {
      let picked;
      try {
        picked = await pickFile([XLSX_TYPE], [".xlsx"], "Choose an Excel file (.xlsx).");
      } catch (err) {
        setErrors([pickErrorMessage(err)]);
        return;
      }
      if (picked === null) return;
      bytes.current = picked.bytes;
      setFileName(picked.name);
      setReport(null);
      setBusy("preview");
      const result = await send(config.paths.preview);
      if (result === null) {
        bytes.current = null;
        setFileName(null);
        return;
      }
      setReport(result);
    });

  const importNow = () =>
    run("import", async () => {
      const result = await send(config.paths.import);
      if (result === null) return;
      // The server re-checks the file; a row that went wrong since the preview is shown, not saved.
      if (result.problems > 0) {
        setReport(result);
        setErrors(["Some rows have problems now, so nothing was added. Fix them in the file and choose it again."]);
        return;
      }
      bytes.current = null;
      setFileName(null);
      setReport(null);
      setDone(importedMessage(result, kind));
    });

  const working = busy !== null;
  const ready = canImport(report);
  const fixes = report ? problemLines(report.rows) : [];

  const header = (
    <View style={styles.header}>
      <Text variant="bodyMedium" style={styles.muted}>
        {INTRO[kind]}
      </Text>
      <Banner messages={errors} />
      <Banner messages={done ? [done] : []} tone="info" />
      <View style={styles.buttons}>
        <ChunkyButton
          label="Get the template"
          icon="download"
          variant="alt"
          onPress={() => void getTemplate()}
          loading={busy === "template"}
          disabled={working}
        />
        <ChunkyButton
          label={report ? "Choose another file" : "Choose a file"}
          icon="file-excel-outline"
          onPress={() => void chooseFile()}
          loading={busy === "pick" || busy === "preview"}
          disabled={working}
        />
      </View>
      {busy === "preview" ? (
        <Text variant="bodyMedium" accessibilityLiveRegion="polite" style={styles.muted}>
          Checking {fileName ?? "the file"}...
        </Text>
      ) : null}

      {report ? (
        <>
          <Text variant="titleSmall" accessibilityRole="header" numberOfLines={1} style={styles.ink}>
            {fileName}
          </Text>
          <View style={styles.tiles}>
            {summaryCounts(report).map((c) => (
              <View key={c.key} style={styles.flex}>
                <Tile tone={c.count > 0 ? COUNT_TONE[c.key] : "card"} label={c.label} value={String(c.count)} />
              </View>
            ))}
          </View>
          <Text variant="bodyMedium" accessibilityLiveRegion="polite" style={styles.ink}>
            {previewSummary(report, kind)}
          </Text>
          {fixes.length > 0 ? (
            <ChunkyBox radius={14} offset={3} style={[styles.fixes, { backgroundColor: colors.errorContainer }]}>
              <Text variant="titleSmall" accessibilityRole="header" style={{ color: colors.onErrorContainer }}>
                What to fix
              </Text>
              {fixes.map((line, i) => (
                <Text key={`${i}-${line}`} variant="bodyMedium" style={{ color: colors.onErrorContainer }}>
                  {line}
                </Text>
              ))}
            </ChunkyBox>
          ) : null}
          {report.rows.length > 0 ? (
            <Text variant="titleSmall" accessibilityRole="header" style={styles.ink}>
              Rows in the file
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <ScreenHeader title={config.title} back backDisabled={working} />
      <FlatList
        data={report?.rows ?? []}
        keyExtractor={(r) => String(r.row)}
        renderItem={({ item }) => <RowCard kind={kind} row={item} />}
        ListHeaderComponent={header}
        contentContainerStyle={{ paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={9}
      />
      {report ? (
        <View style={[styles.bar, { paddingBottom: insets.bottom + 12 }]}>
          <ChunkyButton
            label={busy === "import" ? "Importing..." : importButton(report, kind)}
            onPress={() => void importNow()}
            loading={busy === "import"}
            disabled={!ready || (working && busy !== "import")}
          />
        </View>
      ) : null}
    </View>
  );
}

// One row of the report: what was read, its status and its problems.
const RowCard = memo(function RowCard({ kind, row }: { kind: ImportKind; row: AnyRow }) {
  const card = rowCard(kind, row);
  const status = statusLabel(row.status);
  return (
    <View style={styles.cardWrap}>
      <ChunkyBox radius={14} offset={3} style={styles.card}>
        <View
          accessible
          accessibilityLabel={`Row ${row.row}, ${status}, ${card.title}, ${card.amount}, ${card.meta}${row.errors.length ? `. ${row.errors.join(" ")}` : ""}`}
        >
          <View style={styles.cardTop}>
            <Text variant="labelMedium" style={styles.muted}>
              Row {row.row}
            </Text>
            <Tag label={status} tone={row.status === "duplicate" ? "due" : "card"} />
          </View>
          <View style={styles.cardTop}>
            <Text variant="titleSmall" numberOfLines={1} style={[styles.ink, styles.flex]}>
              {card.title}
            </Text>
            <Text variant="titleSmall" style={[styles.ink, styles.amount]}>
              {card.amount}
            </Text>
          </View>
          {card.meta ? (
            <Text variant="bodySmall" numberOfLines={2} style={styles.muted}>
              {card.meta}
            </Text>
          ) : null}
          {row.errors.map((e, i) => (
            <Text key={i} variant="bodySmall" style={styles.error}>
              {e}
            </Text>
          ))}
        </View>
      </ChunkyBox>
    </View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  flex: { flex: 1, minWidth: 0 },
  header: { padding: 16, gap: 12 },
  buttons: { gap: 12 },
  tiles: { flexDirection: "row", gap: 8 },
  fixes: { padding: 12, gap: 6 },
  muted: { color: BRAND.zinc600 },
  ink: { color: BRAND.ink },
  error: { color: BRAND.loss, marginTop: 4 },
  amount: { fontVariant: ["tabular-nums"] },
  cardWrap: { paddingHorizontal: 16, paddingBottom: 10 },
  card: { padding: 12 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  bar: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: 2.5,
    borderTopColor: BRAND.ink,
    backgroundColor: BRAND.bg,
  },
});
