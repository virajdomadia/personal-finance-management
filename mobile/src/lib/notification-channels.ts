// Every Android notification channel the app makes. Each one is private on the lock screen: on a
// phone with a PIN, pattern or fingerprint, the lock screen shows only that Gullak has a
// notification, and the amounts and payees appear once the phone is unlocked.
//
// Android won't let an app change an existing channel's lock-screen visibility, so the private
// channels have new ids and the old (public) ones are deleted. Anything still scheduled on an old
// channel is laid down again on the new one by its own refresh. Nothing else may call
// setNotificationChannelAsync (notify.test.mjs checks), so a new channel can't skip this.
import type * as NotificationsPackage from "expo-notifications";

export type ChannelSpec = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  // The public channel this one replaced, deleted when this one is made.
  readonly retiredId: string;
};

type ChannelApi = Pick<
  typeof NotificationsPackage,
  "AndroidImportance" | "AndroidNotificationVisibility" | "setNotificationChannelAsync" | "deleteNotificationChannelAsync"
>;

export async function ensurePrivateChannel(n: ChannelApi, channel: ChannelSpec): Promise<void> {
  await n.setNotificationChannelAsync(channel.id, {
    name: channel.name,
    description: channel.description,
    importance: n.AndroidImportance.DEFAULT,
    lockscreenVisibility: n.AndroidNotificationVisibility.PRIVATE,
  });
  // Already gone, or never made on this phone: either way there's nothing to do.
  await n.deleteNotificationChannelAsync(channel.retiredId).catch(() => {});
}
