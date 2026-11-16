import { requireOptionalNativeModule } from "expo";

// The SMS inbox reader, and the arrival of a new SMS. Optional: an APK built before this module
// existed has no native side, and then `isAvailable()` is false and nothing here throws. An APK
// built before the arrival receiver existed has the reader but not the receiver: `receivesSms()`
// is false there, and an arrival listener simply never fires.

export type InboxSms = { id: string; address: string; body: string; date: number };

export type Subscription = { remove(): void };

type SmsInboxNative = {
  readInbox(sinceMillis: number, limit: number): Promise<InboxSms[]>;
  // Only on builds with the receiver.
  receivesSms?: boolean;
  setReceiverEnabled?: (enabled: boolean) => void;
  addListener?: (event: "onSmsArrived", listener: () => void) => Subscription;
};

// The headless JS task the receiver runs while the app is in the background.
export const SMS_ARRIVED_TASK = "SmsArrived";

const native = requireOptionalNativeModule<SmsInboxNative>("SmsInbox");

export function isAvailable(): boolean {
  return native !== null;
}

// Whether this build hears an SMS arrive (and so can notify about it).
export function receivesSms(): boolean {
  return native !== null && native.receivesSms === true && typeof native.setReceiverEnabled === "function";
}

// Received SMS newer than `sinceMillis`, oldest first, at most `limit`. Rejects without READ_SMS.
export function readInbox(sinceMillis: number, limit: number): Promise<InboxSms[]> {
  if (native === null) return Promise.reject(new Error("The SMS reader is not in this app version."));
  return native.readInbox(sinceMillis, limit);
}

// Turns the arrival receiver on or off, following the SMS reading switch. No-op on older builds.
export function setReceiverEnabled(enabled: boolean): void {
  if (!receivesSms()) return;
  try {
    native?.setReceiverEnabled?.(enabled);
  } catch {
    // The receiver keeps its last state; the next app start tries again.
  }
}

// Calls `listener` when an SMS arrives while the app is in the front. Null on builds without the
// receiver.
export function addSmsArrivedListener(listener: () => void): Subscription | null {
  if (!receivesSms() || typeof native?.addListener !== "function") return null;
  return native.addListener("onSmsArrived", listener);
}
