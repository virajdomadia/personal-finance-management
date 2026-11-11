import type { ConfigContext, ExpoConfig } from "expo/config";

// Two installable apps from one codebase. EAS's "development" profile sets APP_VARIANT=development and
// builds "Gullak Dev": its own package name, so it sits next to the real app instead of replacing it,
// and a blue DEV icon so the two can't be mixed up. Everything else comes from app.json unchanged.
const IS_DEV = process.env.APP_VARIANT === "development";

export default ({ config }: ConfigContext): ExpoConfig => {
  if (!IS_DEV) return config as ExpoConfig;
  return {
    ...(config as ExpoConfig),
    name: "Gullak Dev",
    scheme: "personalfinance-dev",
    icon: "./assets/icon-dev.png",
    android: {
      ...config.android,
      package: "com.virajdomadia.personalfinance.dev",
      adaptiveIcon: {
        ...config.android?.adaptiveIcon,
        backgroundColor: "#1CB0F6",
        foregroundImage: "./assets/android-icon-foreground-dev.png",
        backgroundImage: "./assets/android-icon-background-dev.png",
      },
    },
  };
};
