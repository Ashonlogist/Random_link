// public/sw.js
const SUPABASE_URL = "https://qqutsylqpkgghmehndjm.supabase.co";
const SUPABASE_KEY = "sb_publishable_PaZX8ccAVYRQvlYSgd8p2A_0P2k9VTS";

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const action = event.action;
  const connectionId = event.notification.data?.connectionId;
  const myId = event.notification.data?.myId;

  if (action === 'chat_accept' || !action) {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
        for (let client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow('/');
      })
    );
  }

  if (action === 'reply' && event.reply) {
    event.waitUntil(
      fetch(`${SUPABASE_URL}/rest/v1/messages`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          connection_id: connectionId,
          sender_id: myId,
          body: event.reply
        })
      }).catch(err => console.error('[SW Error]', err))
    );
  }
});
