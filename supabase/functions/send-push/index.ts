// public/sw.js
//
// Handles:
//  1. Real Web Push messages arriving via the 'push' event (server-triggered,
//     works even if no tab is open).
//  2. Clicks on notifications and their action buttons (Accept/Ignore/Reply).
//  3. Inline-reply on message notifications, authenticated with the user's
//     actual session token (received from the page via postMessage) so it
//     passes the `auth.uid() = sender_id` RLS policy on messages. Using only
//     the anon key here would silently fail RLS with no error.

const SUPABASE_URL = "https://qqutsylqpkgghmehndjm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_PaZX8ccAVYRQvlYSgd8p2A_0P2k9VTS";

// Cached in memory for as long as the SW stays alive. Refreshed whenever
// the page sends a SESSION_TOKEN message (on load, on token refresh, etc).
let cachedAccessToken = null;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// The page sends us its current Supabase access token so authenticated
// requests (like inline reply) can pass RLS. Service workers have no
// access to localStorage/sessionStorage, so this is the only way they
// can know who's signed in.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SESSION_TOKEN') {
    cachedAccessToken = event.data.accessToken || null;
  }
});

// ---- Real Web Push -----------------------------------------------------
// Fired when a push message arrives from the server (via the Supabase Edge
// Function that triggers on a new match), even with no tab open.
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (e) {
    payload = { title: 'RandomLink', body: event.data ? event.data.text() : 'You have a new notification.' };
  }

  const title = payload.title || 'RandomLink';
  const options = {
    body: payload.body || '',
    icon: payload.icon || undefined,
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    data: payload.data || {},
    actions: payload.actions || [],
    requireInteraction: !!payload.requireInteraction,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ---- Notification clicks (including action buttons) -------------------
self.addEventListener('notificationclick', function (event) {
  const action = event.action;
  const data = event.notification.data || {};
  const connectionId = data.connectionId;
  const myId = data.myId;
  event.notification.close();

  // Friend request notification
  if (action === 'friend_accept' && data.friendshipId) {
    event.waitUntil(acceptFriendRequest(data.friendshipId).then(() => focusOrOpen('/')));
    return;
  }
  if (action === 'friend_dismiss') {
    return; // closing it is enough
  }

  // Background-search "you've been paired" notification
  if (action === 'pair_ignore' && connectionId) {
    // Stay queued — nothing to do here, the user is still in waiting_room.
    return;
  }
  if (action === 'pair_accept' && connectionId) {
    event.waitUntil(focusOrOpen('/', { type: 'OPEN_CONNECTION', connectionId }));
    return;
  }

  // Inline reply on a message notification
  if (action === 'reply' && event.reply) {
    event.waitUntil(sendReply(connectionId, myId, event.reply));
    return;
  }

  // Match/chat found notification, or default click (no action button)
  if ((action === 'chat_accept' || action === '' || !action) && connectionId) {
    event.waitUntil(focusOrOpen('/', { type: 'OPEN_CONNECTION', connectionId }));
    return;
  }
  if (action === 'chat_ignore') {
    return;
  }

  // Fallback: just bring the app to the foreground
  event.waitUntil(focusOrOpen('/'));
});

async function acceptFriendRequest(friendshipId) {
  if (!cachedAccessToken) {
    console.warn('[SW] No cached session token; cannot accept friend request from notification.');
    return;
  }
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/friendships?id=eq.${friendshipId}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${cachedAccessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ status: 'accepted' }),
    });
  } catch (err) {
    console.error('[SW Error] Accepting friend request:', err);
  }
}

async function sendReply(connectionId, myId, body) {
  if (!connectionId || !myId) return;
  if (!cachedAccessToken) {
    console.warn('[SW] No cached session token; reply will fail RLS without it.');
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${cachedAccessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        connection_id: connectionId,
        sender_id: myId,
        body,
      }),
    });
    if (!res.ok) {
      console.error('[SW Error] Reply insert failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[SW Error] Sending reply:', err);
  }
}

async function focusOrOpen(url, postMessageData) {
  const clientList = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clientList) {
    if ('focus' in client) {
      await client.focus();
      if (postMessageData) client.postMessage(postMessageData);
      return;
    }
  }
  if (clients.openWindow) {
    const newClient = await clients.openWindow(url);
    if (newClient && postMessageData) {
      setTimeout(() => newClient.postMessage(postMessageData), 1500);
    }
    return newClient;
  }
}
