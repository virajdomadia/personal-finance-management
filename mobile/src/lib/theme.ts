import { MD3LightTheme, configureFonts, type MD3Theme } from "react-native-paper";

// The Gullak palette, shared with the website (frontend/src/app/globals.css). The -strong shades
// carry white text on tiles; yellow and due carry ink.
export const BRAND = {
  bg: "#FFFDF5",
  ink: "#1A1A1A",
  card: "#FFFFFF",
  green: "#58CC02",
  yellow: "#FFC800",
  pink: "#FF4B8B",
  blue: "#1CB0F6",
  purple: "#A560FF",
  orange: "#FF7A00",
  due: "#FFF1C2",
  greenStrong: "#2F7D00",
  pinkStrong: "#CC2860",
  blueStrong: "#0C6FA8",
  purpleStrong: "#7A35D9",
  orangeStrong: "#B34F00",
  gain: "#2C8000",
  loss: "#C41E34",
  zinc100: "#F4F1E6",
  zinc200: "#E6E2D6",
  zinc500: "#6B675C",
  zinc600: "#565247",
} as const;

export const FONT = {
  bold: "Nunito_700Bold",
  extraBold: "Nunito_800ExtraBold",
  black: "Nunito_900Black",
} as const;

// The ink border, the card radius and the depth of the hard shadow. Android has no offset shadow,
// so ChunkyBox draws it as an ink view sitting behind.
export const CHUNKY = {
  borderWidth: 2.5,
  borderColor: BRAND.ink,
  borderRadius: 18,
} as const;
export const SHADOW_OFFSET = 4;
export const SHADOW_OFFSET_SM = 3;
export const INPUT_RADIUS = 14;

// Nunito ships one file per weight, so each variant names its file and keeps a normal weight
// (a numeric weight on a custom family would ask Android to fake a bolder face).
const FAMILY: Record<keyof typeof MD3LightTheme.fonts, string> = {
  displayLarge: FONT.black,
  displayMedium: FONT.black,
  displaySmall: FONT.black,
  headlineLarge: FONT.black,
  headlineMedium: FONT.black,
  headlineSmall: FONT.black,
  titleLarge: FONT.black,
  titleMedium: FONT.extraBold,
  titleSmall: FONT.extraBold,
  labelLarge: FONT.extraBold,
  labelMedium: FONT.extraBold,
  labelSmall: FONT.extraBold,
  bodyLarge: FONT.bold,
  bodyMedium: FONT.bold,
  bodySmall: FONT.bold,
  default: FONT.bold,
};
const config = Object.fromEntries(
  Object.entries(FAMILY).map(([variant, fontFamily]) => [
    variant,
    { ...MD3LightTheme.fonts[variant as keyof typeof FAMILY], fontFamily, fontWeight: "normal" as const },
  ]),
) as Record<keyof typeof FAMILY, MD3Theme["fonts"]["default"]>;
const fonts = configureFonts({ config });

// The app is light only.
export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  roundness: 4, // Paper multiplies this by 3.5 for its rounded corners, about 14px
  fonts,
  colors: {
    ...MD3LightTheme.colors,
    primary: BRAND.ink,
    onPrimary: "#FFFFFF",
    primaryContainer: BRAND.yellow,
    onPrimaryContainer: BRAND.ink,
    secondary: BRAND.yellow,
    onSecondary: BRAND.ink,
    secondaryContainer: BRAND.due,
    onSecondaryContainer: BRAND.ink,
    tertiary: BRAND.pinkStrong,
    onTertiary: "#FFFFFF",
    tertiaryContainer: BRAND.due,
    onTertiaryContainer: BRAND.ink,
    background: BRAND.bg,
    onBackground: BRAND.ink,
    surface: BRAND.bg,
    onSurface: BRAND.ink,
    surfaceVariant: BRAND.zinc100,
    onSurfaceVariant: BRAND.zinc600,
    surfaceDisabled: BRAND.zinc200,
    onSurfaceDisabled: BRAND.zinc500,
    error: BRAND.loss,
    onError: "#FFFFFF",
    errorContainer: "#FFE3E6",
    onErrorContainer: "#7A0F1E",
    outline: BRAND.ink,
    outlineVariant: BRAND.zinc200,
    elevation: {
      level0: "transparent",
      level1: BRAND.card,
      level2: BRAND.card,
      level3: BRAND.card,
      level4: BRAND.card,
      level5: BRAND.card,
    },
  },
};

// Profit and loss text colours, picked for contrast on the cream background and on white.
export const TONE_COLORS = { gain: BRAND.gain, loss: BRAND.loss } as const;
