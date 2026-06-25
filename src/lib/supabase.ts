import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error('Missing Supabase env vars. Ensure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set.');
}

export const supabase = createClient(url, anonKey, {
  realtime: { params: { eventsPerSecond: 20 } },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

export type ChatMode = 'video' | 'text';

export type InstitutionType = 'jhs' | 'shs' | 'uni';

export type Profile = {
  user_id: string;
  age: number;
  institution_type: InstitutionType;
  school_name: string | null;
  display_name: string;
  created_at: string;
};

export type ConnectionRow = {
  id: string;
  initiator_id: string;
  responder_id: string;
  mode: ChatMode;
  status: 'pending' | 'connected' | 'ended';
  sdp_offer: any | null;
  sdp_answer: any | null;
  ice_candidates_initiator: any[] | null;
  ice_candidates_responder: any[] | null;
  created_at: string;
  ended_at: string | null;
};

export type MessageRow = {
  id: string;
  connection_id: string;
  sender_id: string;
  body: string;
  created_at: string;
};

export type WaitingRow = {
  id: string;
  user_id: string;
  mode: ChatMode;
  created_at: string;
};

export type AgeBand = 'under16' | '16_17' | '18_22' | '23_plus';

export function ageBand(age: number): AgeBand {
  if (age < 16) return 'under16';
  if (age <= 17) return '16_17';
  if (age <= 22) return '18_22';
  return '23_plus';
}
