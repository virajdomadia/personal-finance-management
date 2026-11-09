import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from "react-native-paper";

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#0F5C6E",
    onPrimary: "#FFFFFF",
    primaryContainer: "#BDE9F5",
    onPrimaryContainer: "#001F27",
    tertiary: "#8A5A00",
    tertiaryContainer: "#FFDDAE",
    onTertiaryContainer: "#2B1700",
    background: "#F4F8F9",
    surface: "#F4F8F9",
  },
};

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: "#85D2E6",
    onPrimary: "#003640",
    primaryContainer: "#004E5D",
    onPrimaryContainer: "#BDE9F5",
    tertiary: "#FFBA4A",
    tertiaryContainer: "#5A3B00",
    onTertiaryContainer: "#FFDDAE",
    background: "#0E1A1D",
    surface: "#0E1A1D",
  },
};

// Profit and loss text colours, picked for contrast on each theme's background.
export const TONE_COLORS = {
  light: { gain: "#1B6B34", loss: "#B3261E" },
  dark: { gain: "#7FD99A", loss: "#FFB4AB" },
} as const;
