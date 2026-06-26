import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export interface ModeStats {
  waiting: number;
  chatting: number;
  online: number;
}

export interface ChatStats {
  video: ModeStats;
  text: ModeStats;
}

export function useChatStats() {
  const [stats, setStats] = useState<ChatStats>({
    video: { waiting: 0, chatting: 0, online: 0 },
    text: { waiting: 0, chatting: 0, online: 0 },
  });
  const [loading, setLoading] = useState(true);

  const updateStats = async () => {
    try {
      // 1. Fetch all users currently in the waiting room queue
      const { data: waitingRoom, error: wError } = await supabase
        .from('waiting_room')
        .select('mode');

      // 2. Fetch all active ongoing connections
      const { data: connections, error: cError } = await supabase
        .from('connections')
        .select('mode')
        .eq('status', 'connected');

      if (wError || cError) throw wError || cError;

      const newStats: ChatStats = {
        video: { waiting: 0, chatting: 0, online: 0 },
        text: { waiting: 0, chatting: 0, online: 0 },
      };

      // Count waiting room instances
      waitingRoom?.forEach((row) => {
        if (row.mode === 'video') newStats.video.waiting++;
        if (row.mode === 'text') newStats.text.waiting++;
      });

      // Count users chatting (Each connected row contains 2 users)
      connections?.forEach((row) => {
        if (row.mode === 'video') newStats.video.chatting += 2;
        if (row.mode === 'text') newStats.text.chatting += 2;
      });

      // Calculate totals
      newStats.video.online = newStats.video.waiting + newStats.video.chatting;
      newStats.text.online = newStats.text.waiting + newStats.text.chatting;

      setStats(newStats);
    } catch (err) {
      console.error('Error updating live chat statistics:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Initial data fetch
    updateStats();

    // Subscribe to database changes across waiting room and active pairs
    const waitingChannel = supabase
      .channel('public:waiting_room_stats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'waiting_room' }, () => {
        updateStats();
      })
      .subscribe();

    const connectionsChannel = supabase
      .channel('public:connections_stats')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'connections' }, () => {
        updateStats();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(waitingChannel);
      supabase.removeChannel(connectionsChannel);
    };
  }, []);

  return { stats, loading };
}