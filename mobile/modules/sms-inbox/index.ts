import { requireOptionalNativeModule } from "expo";

// The SMS inbox reader. Optional: an APK built before this module existed has no native side, and
// then `isAvailable()` is false and nothing here throws.

export type InboxSms = { id: string; address: string; body: string; date: number };

type SmsInboxNative = {
  readInbox(sinceMillis: number, limit: number): Promise<InboxSms[]>;
};

const native = requireOptionalNativeModule<SmsInboxNative>("SmsInbox");

export function isAvailable(): boolean {
  return native !== null;
}

// Received SMS newer than `sinceMillis`, newest first, at most `limit`. Rejects without READ_SMS.
export function readInbox(sinceMillis: number, limit: number): Promise<InboxSms[]> {
  if (native === null) return Promise.reject(new Error("The SMS reader is not in this app version."));
  return native.readInbox(sinceMillis, limit);
}
