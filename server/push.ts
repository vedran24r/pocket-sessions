import webpush, { type PushSubscription } from "web-push";
import { save, state } from "./store.ts";

if (!state.vapid) {
  state.vapid = webpush.generateVAPIDKeys();
  save();
}
webpush.setVapidDetails("mailto:pocket@localhost", state.vapid.publicKey, state.vapid.privateKey);

export const publicKey = state.vapid.publicKey;

export function subscribe(subscription: PushSubscription): void {
  state.subscriptions = state.subscriptions.filter((existing) => existing.endpoint !== subscription.endpoint);
  state.subscriptions.push(subscription);
  save();
}

export interface Notice {
  title: string;
  body: string;
  url: string;
  tag: string;
  /** Buttons on the notification (Android): handled by the service worker. */
  actions?: { action: string; title: string }[];
  session?: string;
}

/** Payloads are end-to-end encrypted by the Web Push protocol; the push service can't read them. */
export async function notify(notice: Notice): Promise<void> {
  const payload = JSON.stringify(notice);
  const gone: string[] = [];
  await Promise.all(
    state.subscriptions.map((subscription) =>
      webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: "high" }).catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) gone.push(subscription.endpoint);
        else console.error("push failed", err.statusCode, err.body);
      }),
    ),
  );
  if (gone.length) {
    state.subscriptions = state.subscriptions.filter((subscription) => !gone.includes(subscription.endpoint));
    save();
  }
}
