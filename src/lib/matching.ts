import { supabase, type ChatMode, type ConnectionRow } from './supabase';

// How long a connection can remain "connected" before we treat it as
// abandoned (tab closed, crash, lost network) rather than a long chat.
// Generous on purpose — this is a safety net, not the primary exit path.
const STALE_CONNECTED_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Affinity-based matching. Uses the server-side `match_partner` function which
 * scores waiting users by similarity to the caller's past partners (institution
 * type, age band, school). Falls back to oldest-first if no affinity data.
 *
 * Flow:
 *  1. Insert self into waiting_room.
 *  2. Call match_partner(mode) RPC to get the best partner user_id.
 *  3. If a partner is returned, atomically claim them by deleting their waiting
 *     row; if exactly 1 row deleted, we won the race and create a connection as
 *     initiator.
 *  4. If no partner / lost race, subscribe to incoming connection inserts where
 *     we are the responder (someone else claims us).
 */
export async function findMatch(
  myId: string,
  mode: ChatMode
): Promise<{ conn: ConnectionRow; asInitiator: boolean } | null> {
  // Insert self into waiting room
  const { error: insErr } = await supabase
    .from('waiting_room')
    .insert({ user_id: myId, mode });
  if (insErr) throw new Error('Failed to join waiting room: ' + insErr.message);

  // Ask the affinity matcher for the best partner
  const { data: partnerId, error: rpcErr } = await supabase.rpc('match_partner', { p_mode: mode });
  if (rpcErr) throw new Error('Matching failed: ' + rpcErr.message);

  if (partnerId) {
    // Claim the partner by deleting their waiting row (atomic race)
    const { count, error: delErr } = await supabase
      .from('waiting_room')
      .delete({ count: 'exact' })
      .eq('user_id', partnerId);
    if (delErr) throw new Error('Failed to claim partner: ' + delErr.message);

    if (count === 1) {
      // Remove self from waiting room
      await supabase.from('waiting_room').delete().eq('user_id', myId);
      // Create connection as initiator
      const { data: conn, error: cErr } = await supabase
        .from('connections')
        .insert({
          initiator_id: myId,
          responder_id: partnerId,
          mode,
          status: 'pending',
        })
        .select()
        .single();
      if (cErr) throw new Error('Failed to create connection: ' + cErr.message);
      return { conn: conn as ConnectionRow, asInitiator: true };
    }
    // Lost the race; fall through to wait.
  }

  return null;
}

export async function leaveWaitingRoom(myId: string) {
  await supabase.from('waiting_room').delete().eq('user_id', myId);
}

/**
 * Marks a connection as ended so the partner's realtime subscription
 * (listening for status === 'ended') can boot them out of the room.
 * Safe to call even if the connection is already ended/missing.
 */
export async function endConnection(connectionId: string | null | undefined) {
  if (!connectionId) return;
  await supabase
    .from('connections')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('id', connectionId)
    .in('status', ['pending', 'connected']); // don't touch already-ended rows
}

export function subscribeToIncomingMatches(
  myId: string,
  onMatched: (conn: ConnectionRow) => void
): () => void {
  const channel = supabase
    .channel(`incoming-${myId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'connections', filter: `responder_id=eq.${myId}` },
      (payload) => {
        onMatched(payload.new as ConnectionRow);
      }
    )
    .subscribe();
  return () => {
    supabase.channel(`incoming-${myId}`).unsubscribe();
    void channel;
  };
}

export async function pruneStaleWaiting(maxAgeMs = 60000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  await supabase.from('waiting_room').delete().lt('created_at', cutoff);
}

export async function pruneStaleConnections(maxAgeMs = 90000) {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  // Pending connections that never got accepted (e.g. offer/answer never completed)
  await supabase
    .from('connections')
    .delete()
    .eq('status', 'pending')
    .lt('created_at', cutoff);

  // Connections that have been "connected" for a very long time with no
  // explicit end are almost certainly abandoned (tab closed, network drop,
  // crash) rather than a marathon chat. End them so any partner still
  // sitting in the room gets released, and so stats don't grow unbounded.
  await supabase
    .from('connections')
    .update({ status: 'ended', ended_at: new Date().toISOString() })
    .eq('status', 'connected')
    .lt('created_at', new Date(Date.now() - STALE_CONNECTED_MS).toISOString());
}

/**
 * Records an affinity history entry for a completed connection so future
 * matching learns from who the user talked to.
 */
export async function recordAffinity(
  myId: string,
  partnerId: string,
  connectionId: string,
  durationSec: number
) {
  // Fetch partner's profile snapshot
  const { data: partner } = await supabase
    .from('profiles')
    .select('institution_type, age, school_name')
    .eq('user_id', partnerId)
    .maybeSingle();

  if (!partner) return;

  const band = ageBandLocal(partner.age as number);
  await supabase.from('affinity_history').insert({
    user_id: myId,
    partner_id: partnerId,
    partner_institution_type: partner.institution_type,
    partner_age_band: band,
    partner_school_name: partner.school_name,
    connection_id: connectionId,
    duration_sec: Math.round(durationSec),
  });
}

function ageBandLocal(age: number): string {
  if (age < 16) return 'under16';
  if (age <= 17) return '16_17';
  if (age <= 22) return '18_22';
  return '23_plus';
}
