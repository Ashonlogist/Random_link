import { supabase } from './supabase';

// Must match the VAPID_PUBLIC_KEY set as a secret on the send-push edge
// function. This one is safe to be public — it's how the browser encrypts
// the subscription, not a secret credential.
const VAPID_PUBLIC_KEY = 'BD2Ip7k9qhyrHd1_WtoiKIUc_DUblpZisJgBmtirqFcrcOIWOFinJBvlSFlGYkkk74J1cZvTnguUeepgioVHP5I';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Subscribes the current browser to Web Push and saves the subscription
 * to Supabase, so the send-push edge function can reach this device even
 * when the tab is fully closed. Call this once notification permission is
 * granted. Safe to call repeatedly (upserts).
 */
export async function subscribeToPush(myId: string): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (Notification.permission !== 'granted') return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    const subJson = subscription.toJSON();
    if (!subJson.endpoint || !subJson.keys?.p256dh || !subJson.keys?.auth) return false;

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_id: myId,
          endpoint: subJson.endpoint,
          p256dh: subJson.keys.p256dh,
          auth: subJson.keys.auth,
        },
        { onConflict: 'user_id,endpoint' }
      );

    if (error) {
      console.error('[push] Failed to save subscription:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[push] Subscription failed:', err);
    return false;
  }
}

/**
 * Sends the current session's access token to the service worker so it
 * can authenticate requests it makes on its own (e.g. inline reply,
 * accepting a friend request from a notification action button).
 * Call on app load and whenever the session refreshes.
 */
export async function syncSessionTokenToServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) return;
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: 'SESSION_TOKEN', accessToken: token });
  } catch (err) {
    console.error('[push] Failed to sync session token to SW:', err);
  }
}

/**
 * Invokes the send-push edge function to deliver a real push notification
 * to another user, even if their tab/browser is fully closed. Fails
 * silently (logs only) since push is a best-effort enhancement — the
 * in-page Notification API and Realtime are still the primary channel
 * when the recipient's tab is open.
 */
export async function sendPushTo(
  targetUserId: string,
  payload: {
    title: string;
    body: string;
    tag?: string;
    data?: Record<string, unknown>;
    actions?: { action: string; title: string }[];
    requireInteraction?: boolean;
  }
): Promise<void> {
  try {
    const { error } = await supabase.functions.invoke('send-push', {
      body: { targetUserId, ...payload },
    });
    if (error) console.error('[push] send-push invocation failed:', error);
  } catch (err) {
    console.error('[push] send-push invocation threw:', err);
  }
}
