import { DateTimePickerAndroid } from "@react-native-community/datetimepicker";
import { Pressable, StyleSheet, View } from "react-native";
import { Chip, HelperText, TextInput } from "react-native-paper";

import { dateToIso, isoToDate } from "@/lib/dates";
import { formatDate, todayIndia } from "@/lib/transactions";

export type DateChip = { label: string; value: string };

type Props = {
  label: string;
  // ISO "YYYY-MM-DD", or "" when no date is chosen yet.
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
  // ISO date the picker can't go past. Pass todayIndia() where the server refuses future dates.
  maxDate?: string;
  // ISO date the picker can't go before.
  minDate?: string;
  error?: string | null;
  // Red outline only, for a form whose own wrapper already shows the message under the field.
  invalid?: boolean;
  // Shortcuts under the field. Defaults to Today.
  chips?: DateChip[];
  helper?: string;
};

// One date input for the whole app: shows the date, opens the system date dialog on press, and keeps
// the Today shortcut. The value stays ISO text, so callers and payloads are unchanged.
export function DateField({ label, value, onChange, disabled = false, maxDate, minDate, error, invalid = false, chips, helper }: Props) {
  const shortcuts = chips ?? [{ label: "Today", value: todayIndia() }];

  const open = () => {
    if (disabled) return;
    DateTimePickerAndroid.open({
      value: isoToDate(value, isoToDate(maxDate ?? todayIndia())),
      mode: "date",
      maximumDate: maxDate ? isoToDate(maxDate) : undefined,
      minimumDate: minDate ? isoToDate(minDate) : undefined,
      onValueChange: (_event, date) => onChange(dateToIso(date)),
    });
  };

  return (
    <View>
      <Pressable
        onPress={open}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value === "" ? "not chosen" : formatDate(value)}. Change date`}
      >
        <View pointerEvents="none">
          <TextInput
            mode="outlined"
            label={label}
            value={value === "" ? "" : formatDate(value)}
            placeholder="Choose a date"
            editable={false}
            error={invalid || Boolean(error)}
            disabled={disabled}
            right={<TextInput.Icon icon="calendar" />}
          />
        </View>
      </Pressable>
      <View style={styles.chips}>
        {shortcuts.map((option) => (
          <Chip
            key={option.label}
            selected={value === option.value}
            showSelectedCheck
            disabled={disabled}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === option.value, disabled }}
          >
            {option.label}
          </Chip>
        ))}
      </View>
      {helper && !error ? (
        <HelperText type="info" visible>
          {helper}
        </HelperText>
      ) : null}
      {error ? (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
});
