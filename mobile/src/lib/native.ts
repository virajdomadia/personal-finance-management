// Native modules that an installed build may not contain. A build made before a module was added
// doesn't have it, and importing its package at the top of a file throws while the app starts,
// taking every screen down with it. These loaders check first and load the package only when it's
// there (null otherwise), so an older build keeps working without that one feature. Nothing else
// imports these packages directly; native-imports.test.mjs keeps it that way.
/* eslint-disable @typescript-eslint/no-require-imports -- loading lazily is the point of this file */
import { requireOptionalNativeModule } from "expo";
import type * as ClipboardPackage from "expo-clipboard";
import type * as CryptoPackage from "expo-crypto";
import type * as FileSystemPackage from "expo-file-system";
import type * as NotificationsPackage from "expo-notifications";
import type * as SharingPackage from "expo-sharing";

function has(...names: string[]): boolean {
  try {
    return names.every((name) => requireOptionalNativeModule(name) != null);
  } catch {
    return false;
  }
}

// Sharing an export needs both: the file is written to the cache, then handed to the share sheet.
export function loadFileSharing(): { fs: typeof FileSystemPackage; sharing: typeof SharingPackage } | null {
  if (!has("ExpoSharing", "FileSystem")) return null;
  return { fs: require("expo-file-system"), sharing: require("expo-sharing") };
}

// Every module expo-notifications loads when its package is imported.
const NOTIFICATION_MODULES = [
  "ExpoNotificationScheduler",
  "ExpoNotificationsEmitter",
  "ExpoNotificationsHandlerModule",
  "ExpoNotificationPermissionsModule",
  "ExpoNotificationChannelManager",
  "ExpoNotificationChannelGroupManager",
  "ExpoNotificationPresenter",
  "ExpoNotificationCategoriesModule",
  "ExpoBadgeModule",
  "ExpoPushTokenManager",
  "ExpoBackgroundNotificationTasksModule",
  "NotificationsServerRegistrationModule",
];

export function loadNotifications(): typeof NotificationsPackage | null {
  return has(...NOTIFICATION_MODULES) ? require("expo-notifications") : null;
}

export function loadClipboard(): typeof ClipboardPackage | null {
  return has("ExpoClipboard") ? require("expo-clipboard") : null;
}

// SMS sync hashes each message before sending it.
export function loadCrypto(): typeof CryptoPackage | null {
  return has("ExpoCrypto") ? require("expo-crypto") : null;
}

// The text shown when a feature needs a newer build than the one installed.
export const NEEDS_UPDATE = "This needs the latest version of the app. Install the new build to use it.";
