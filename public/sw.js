// public/sw.js
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  
  const action = event.action;
  const notificationData = event.notification.data || {};
  const { connectionId, myId, partnerId, friendshipId } = notificationData;

  // Supabase REST Configurations (Replace with your actual keys)
  const supabaseUrl = "https://YOUR_SUPABASE_PROJECT_ID.supabase.co";
  const supabaseKey = "YOUR_SUPABASE_ANON_KEY";

  const headers = {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
  };

  // Handle Match Found Actions
  if (action === 'chat_accept') {
    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
        for (let client of clientList) {
          if ('focus' in client) return client.focus();
        }
        if (clients.openWindow) return clients.openWindow('/');
      })
    );
    return;
  }

  if (action === 'chat_ignore') {
    event.waitUntil(
      fetch(`${supabaseUrl}/rest/v1/connections?id=eq.${connectionId}`, {
        method: 'PATCH',
        headers: headers,
        body: JSON.stringify({ status: 'ended', ended_at: new Date().toISOString() })
      }).catch(err => console.error('[SW] Ignore match failed:', err))
    );
    return;
  }

  // Handle Inline DM Replies
  if (action === 'reply' && event.reply) {
    event.waitUntil(
      fetch(`${supabaseUrl}/rest/v1/messages`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          connection_id: connectionId,
          sender_id: myId,
          body: event.reply
        })
      }).catch(err => console.error('[SW] DM quick reply failed:', err))
    );
    return;
  }

  // Handle Friend Request Notifications
  if (action === 'friend_accept') {
    event.waitUntil(
      fetch(`${supabaseUrl}/rest/v1/friendships?id=eq.${friendshipId}`, {
        method: 'PATCH',
        headers: headers,
        body: JSON.stringify({ status: 'accepted' })
      }).catch(err => console.error('[SW] Accept friend request failed:', err))
    );
    return;
  }

  // Default fallback: Focus or Open App Window
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
