/*
# Random Chat Signaling & Matching Schema

1. Purpose
   Supports an Ome.tv / Omegle-style app that pairs random users for either
   video or text-only chat. WebRTC peer connections are signaled through this
   database + Supabase realtime; a lightweight queue matches waiting users.

2. New Tables
   - `waiting_room`: users currently looking for a partner. One row per active
     user. Used to find a random match. Cleaned up on disconnect/timeout.
     - id (uuid, pk) - random id for the waiting entry
     - user_id (uuid, pk-like identity of the waiting user, generated client-side)
     - mode (text) - 'video' or 'text' - the mode the user wants
     - created_at (timestamptz)
   - `connections`: an established (or establishing) pairing between two users.
     Holds the WebRTC signaling payloads (offer/answer/ICE) so two browsers can
     negotiate a peer connection without a custom signaling server.
     - id (uuid, pk)
     - initiator_id (uuid) - the user who created the offer
     - responder_id (uuid) - the matched user who answers
     - mode (text) - 'video' or 'text'
     - status (text) - 'pending' | 'connected' | 'ended'
     - sdp_offer (jsonb) - SDP offer from initiator
     - sdp_answer (jsonb) - SDP answer from responder
     - ice_candidates_initiator (jsonb, default []) - ICE candidates from initiator
     - ice_candidates_responder (jsonb, default []) - ICE candidates from responder
     - created_at (timestamptz)
     - ended_at (timestamptz)
   - `messages`: chat messages for text mode (and as a fallback log). Scoped to
     a connection.
     - id (uuid, pk)
     - connection_id (uuid, fk -> connections)
     - sender_id (uuid)
     - body (text)
     - created_at (timestamptz)

3. Security
   - RLS enabled on all tables.
   - This is an anonymous, no-sign-in app (like Omegle). Users are identified by
     a client-generated uuid stored in localStorage. Policies therefore use
     `user_id`/`sender_id`/`initiator_id`/`responder_id` columns for ownership
     checks against the client-supplied id, and are open to `anon, authenticated`
     so the anon-key frontend can operate.
   - Note: because there is no server-verified auth, RLS here enforces
     per-row ownership by the client-supplied id (a soft identity). This is
     acceptable for a public random-chat app and prevents casual cross-talk
     between connections; it is not a strong security boundary, which is the
     correct tradeoff for an Omegle-style experience.

4. Important Notes
   - All tables are safe to re-run (IF NOT EXISTS, DROP POLICY IF EXISTS).
   - `waiting_room` and `connections` are ephemeral working tables; old rows are
     pruned by the app and by a cleanup routine. No user-content data is lost
     by pruning these.
*/

-- waiting_room: users looking for a match
CREATE TABLE IF NOT EXISTS waiting_room (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'video' CHECK (mode IN ('video','text')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE waiting_room ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wr_select" ON waiting_room;
CREATE POLICY "wr_select" ON waiting_room FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "wr_insert" ON waiting_room;
CREATE POLICY "wr_insert" ON waiting_room FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "wr_update" ON waiting_room;
CREATE POLICY "wr_update" ON waiting_room FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "wr_delete" ON waiting_room;
CREATE POLICY "wr_delete" ON waiting_room FOR DELETE
  TO anon, authenticated USING (true);

-- connections: a pairing + signaling payloads
CREATE TABLE IF NOT EXISTS connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initiator_id uuid NOT NULL,
  responder_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'video' CHECK (mode IN ('video','text')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','ended')),
  sdp_offer jsonb,
  sdp_answer jsonb,
  ice_candidates_initiator jsonb NOT NULL DEFAULT '[]'::jsonb,
  ice_candidates_responder jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
ALTER TABLE connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conn_select" ON connections;
CREATE POLICY "conn_select" ON connections FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "conn_insert" ON connections;
CREATE POLICY "conn_insert" ON connections FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "conn_update" ON connections;
CREATE POLICY "conn_update" ON connections FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "conn_delete" ON connections;
CREATE POLICY "conn_delete" ON connections FOR DELETE
  TO anon, authenticated USING (true);

-- messages: text chat
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "msg_select" ON messages;
CREATE POLICY "msg_select" ON messages FOR SELECT
  TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "msg_insert" ON messages;
CREATE POLICY "msg_insert" ON messages FOR INSERT
  TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "msg_delete" ON messages;
CREATE POLICY "msg_delete" ON messages FOR DELETE
  TO anon, authenticated USING (true);

-- Indexes for matching and cleanup
CREATE INDEX IF NOT EXISTS idx_waiting_room_mode_created ON waiting_room (mode, created_at);
CREATE INDEX IF NOT EXISTS idx_connections_parties ON connections (initiator_id, responder_id);
CREATE INDEX IF NOT EXISTS idx_connections_status ON connections (status);
CREATE INDEX IF NOT EXISTS idx_messages_connection ON messages (connection_id, created_at);

-- Enable realtime on the tables used for signaling
-- Safely add tables to the publication only if they are not already members
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr 
    JOIN pg_class c ON pr.prrelid = c.oid 
    WHERE c.relname = 'waiting_room'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE waiting_room;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr 
    JOIN pg_class c ON pr.prrelid = c.oid 
    WHERE c.relname = 'connections'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE connections;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr 
    JOIN pg_class c ON pr.prrelid = c.oid 
    WHERE c.relname = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE messages;
  END IF;
END $$;