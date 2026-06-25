import { useEffect, useState, useCallback } from 'react';
import { supabase, type Profile } from './supabase';

export type Session = {
  user: { id: string; email: string } | null;
  profile: Profile | null;
};

export function useSession(): {
  session: Session;
  loading: boolean;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
} {
  const [session, setSession] = useState<Session>({ user: null, profile: null });
  const [loading, setLoading] = useState(true);

  const loadProfile = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return data as Profile | null;
  }, []);

  const refreshProfile = useCallback(async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      setSession({ user: null, profile: null });
      return;
    }
    const profile = await loadProfile(data.user.id);
    setSession({ user: { id: data.user.id, email: data.user.email ?? '' }, profile });
  }, [loadProfile]);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!active) return;
      if (data.user) {
        const profile = await loadProfile(data.user.id);
        if (!active) return;
        setSession({ user: { id: data.user.id, email: data.user.email ?? '' }, profile });
      }
      setLoading(false);
    })();

    // onAuthStateChange: wrap async work to avoid deadlock
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      (async () => {
        if (!session?.user) {
          setSession({ user: null, profile: null });
          return;
        }
        const profile = await loadProfile(session.user.id);
        setSession({ user: { id: session.user.id, email: session.user.email ?? '' }, profile });
      })();
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession({ user: null, profile: null });
  }, []);

  return { session, loading, refreshProfile, signOut };
}
