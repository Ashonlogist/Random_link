import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, MessageSquare, Shuffle, X, Send, Loader2, Camera, ArrowLeft, Sparkles, LogOut, Sun, Moon, Menu, Paperclip, Download, User, Edit, UserPlus, Check, CornerUpLeft, PhoneCall, PhoneOff, UserMinus } from 'lucide-react';
import { supabase, type ChatMode, type ConnectionRow, type MessageRow, type Profile } from './lib/supabase';
import { PeerConnection } from './lib/webrtc';
import {
  findMatch,
  leaveWaitingRoom,
  subscribeToIncomingMatches,
  pruneStaleWaiting,
  pruneStaleConnections,
  recordAffinity,
} from './lib/matching';
import { useSession } from './lib/useSession';
import { useTheme } from './lib/useTheme';
import { AuthScreen } from './components/AuthScreen';
import { Onboarding } from './components/Onboarding';

type Phase = 'lobby' | 'searching' | 'connected';
type ExtendedProfile = Profile & { avatar_url?: string | null };

type ExtendedMessageRow = MessageRow & {
  reply_to_id?: string | null;
  reply_body?: string | null;
};

type SecureConnectionRow = ConnectionRow & {
  is_direct?: boolean;
};

export default function App() {
  const { session, loading, refreshProfile, signOut } = useSession();
  const { theme, toggle } = useTheme();
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [friendsDrawerOpen, setFriendsDrawerOpen] = useState(false);

  // Register background push Service Worker hooks
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(() => console.log('[SW] Background notification system active'))
        .catch(err => console.error('[SW Error] Registration failed:', err));
    }
  }, []);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!session.user) {
    return <AuthScreen theme={theme} onToggleTheme={toggle} />;
  }

  if (session.user && !session.profile) {
    return <Onboarding userId={session.user.id} onDone={refreshProfile} theme={theme} onToggleTheme={toggle} />;
  }

  return (
    <>
      <ChatApp
        myId={session.user.id}
        profile={session.profile as ExtendedProfile}
        email={session.user.email || ''}
        onSignOut={signOut}
        theme={theme}
        onToggleTheme={toggle}
        onOpenProfile={() => setProfileModalOpen(true)}
        friendsDrawerOpen={friendsDrawerOpen}
        setFriendsDrawerOpen={setFriendsDrawerOpen}
      />
      
      {profileModalOpen && (
        <EditProfileModal 
          profile={session.profile as ExtendedProfile} 
          email={session.user.email || ''}
          onClose={() => setProfileModalOpen(false)} 
          onRefresh={refreshProfile}
          onSignOut={signOut}
          theme={theme}
          onToggleTheme={toggle}
        />
      )}
    </>
  );
}

function ChatApp({
  myId,
  profile,
  email,
  onSignOut,
  theme,
  onToggleTheme,
  onOpenProfile,
  friendsDrawerOpen,
  setFriendsDrawerOpen,
}: {
  myId: string;
  profile: ExtendedProfile;
  email: string;
  onSignOut: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenProfile: () => void;
  friendsDrawerOpen: boolean;
  setFriendsDrawerOpen: (v: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>('lobby');
  const [mode, setMode] = useState<ChatMode>('video');
  const [conn, setConn] = useState<SecureConnectionRow | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [incomingInvitation, setIncomingInvitation] = useState<SecureConnectionRow | null>(null);
  const [inviterProfile, setInviterProfile] = useState<any | null>(null);

  const peerRef = useRef<PeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const unsubIncomingRef = useRef<(() => void) | null>(null);
  const pruneTimerRef = useRef<number | null>(null);
  const modeRef = useRef<ChatMode>('video');
  const connRef = useRef<SecureConnectionRow | null>(null);
  const connectedAtRef = useRef<number | null>(null);
  const isInitializingRef = useRef(false);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { connRef.current = conn; }, [conn]);
  useEffect(() => { connectedAtRef.current = connectedAt; }, [connectedAt]);

  useEffect(() => {
    pruneTimerRef.current = window.setInterval(() => {
      pruneStaleWaiting().catch(() => {});
      pruneStaleConnections().catch(() => {});
    }, 15000);
    return () => { if (pruneTimerRef.current) clearInterval(pruneTimerRef.current); };
  }, []);

  // Listen live to dynamic realtime updates on arriving friend requests
  useEffect(() => {
    const friendChannel = supabase.channel('live_friendships_requests')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'friendships', filter: `friend_id=eq.${myId}` }, async (payload) => {
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const { data: sender } = await supabase.from('profiles').select('display_name, avatar_url').eq('user_id', payload.new.user_id).maybeSingle();
          const registration = await navigator.serviceWorker.ready;
          registration.showNotification("Friend Request Received 🤝", {
            body: `${sender?.display_name || 'Someone'} wants to add you as a friend!`,
            icon: sender?.avatar_url || undefined,
            tag: payload.new.id,
            data: { friendshipId: payload.new.id },
            actions: [
              { action: 'friend_accept', title: 'Accept Request' },
              { action: 'friend_dismiss', title: 'Dismiss' }
            ]
          });
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(friendChannel); };
  }, [myId]);

  // Listen for direct friend calls (Completely isolated from pool matching updates)
  useEffect(() => {
    const channel = supabase.channel(`direct_calls_${myId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'connections', filter: `responder_id=eq.${myId}` }, async (payload) => {
        const incomingCall = payload.new as SecureConnectionRow;
        
        if (!incomingCall.is_direct) return;

        if (incomingCall.status === 'pending') {
          setIncomingInvitation(incomingCall);
          const { data } = await supabase.from('profiles').select('*').eq('user_id', incomingCall.initiator_id).maybeSingle();
          if (data) setInviterProfile(data);

          if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            const registration = await navigator.serviceWorker.ready;
            registration.showNotification(`Incoming ${incomingCall.mode} Call 📞`, {
              body: `${data?.display_name || 'A friend'} is calling you!`,
              tag: incomingCall.id,
              renotify: true,
              data: { connectionId: incomingCall.id }
            });
          }
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [myId]);

  const acceptIncomingCall = async () => {
    if (!incomingInvitation || isInitializingRef.current) return;
    isInitializingRef.current = true;
    const directMode = incomingInvitation.mode;
    setMode(directMode);
    setPhase('searching');
    setConn(incomingInvitation);

    let stream: MediaStream | null = null;
    if (directMode === 'video') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        setLocalStream(stream);
      } catch (err) {
        console.error("Camera direct initialization exception:", err);
      }
    }

    setPhase('connected');
    setConnectedAt(Date.now());
    const peer = new PeerConnection(incomingInvitation, myId, {
      onRemoteStream: (s) => setRemoteStream(s),
      onDisconnected: () => handleStop(),
      onError: (e) => console.error(e),
    });
    peerRef.current = peer;
    await peer.attachLocalStream(stream);
    try {
      await peer.acceptOffer();
    } catch (err) {
      console.error(err);
      handleStop();
    } finally {
      isInitializingRef.current = false;
    }
    setIncomingInvitation(null);
  };

  const rejectIncomingCall = async () => {
    if (!incomingInvitation) return;
    await supabase.from('connections').update({ status: 'ended' }).eq('id', incomingInvitation.id);
    setIncomingInvitation(null);
  };

  const pushMatchNotification = useCallback(async (incoming: SecureConnectionRow) => {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const partnerId = incoming.initiator_id === myId ? incoming.responder_id : incoming.initiator_id;
      const { data: partner } = await supabase.from('profiles').select('display_name, avatar_url').eq('user_id', partnerId).maybeSingle();
      const registration = await navigator.serviceWorker.ready;
      registration.showNotification("Match Secured! 🎉", {
        body: `We paired you with ${partner?.display_name || 'a stranger'}. Ready to chat?`,
        icon: partner?.avatar_url || undefined,
        tag: incoming.id,
        data: { connectionId: incoming.id },
        actions: [
          { action: 'chat_accept', title: 'Open Chat' },
          { action: 'chat_ignore', title: 'Ignore' }
        ]
      });
    }
  }, [myId]);

  const stopLocalStream = useCallback(() => {
    localStream?.getTracks().forEach((t) => t.stop());
    setLocalStream(null);
  }, [localStream]);

  const teardownPeer = useCallback(async () => {
    const c = connRef.current;
    const startedAt = connectedAtRef.current;
    if (c && startedAt) {
      const partnerId = c.initiator_id === myId ? c.responder_id : c.initiator_id;
      const dur = (Date.now() - startedAt) / 1000;
      recordAffinity(myId, partnerId, c.id, dur).catch(() => {});
    }
    if (peerRef.current) {
      await peerRef.current.close();
      peerRef.current = null;
    }
    setRemoteStream(null);
  }, [myId]);

  const startSearching = useCallback(
    async (selectedMode: ChatMode) => {
      if (isInitializingRef.current) return;
      
      setError(null);
      setMode(selectedMode);
      setPhase('searching');
      setConn(null);
      setRemoteStream(null);
      setConnectedAt(null);

      let stream: MediaStream | null = null;
      if (selectedMode === 'video') {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          setLocalStream(stream);
        } catch (err: any) {
          setError('Could not access camera/microphone. ' + (err?.message ?? ''));
          setPhase('lobby');
          return;
        }
      }

      unsubIncomingRef.current?.();
      unsubIncomingRef.current = subscribeToIncomingMatches(myId, async (incoming) => {
        if (peerRef.current || isInitializingRef.current) return;
        isInitializingRef.current = true;
        
        pushMatchNotification(incoming);
        setConn(incoming);
        setPhase('connected');
        setConnectedAt(Date.now());
        const peer = new PeerConnection(incoming, myId, {
          onRemoteStream: (s) => setRemoteStream(s),
          onDisconnected: () => handleNext(),
          onError: (e) => console.error('[DIAGNOSTIC] Peer connection issue:', e),
        });
        peerRef.current = peer;
        await peer.attachLocalStream(stream);
        try {
          await peer.acceptOffer();
        } catch (err: any) {
          handleNext();
        } finally {
          isInitializingRef.current = false;
        }
      });

      try {
        const result = await findMatch(myId, selectedMode);
        if (result) {
          if (peerRef.current || isInitializingRef.current) return;
          isInitializingRef.current = true;

          pushMatchNotification(result.conn);
          setConn(result.conn);
          setPhase('connected');
          setConnectedAt(Date.now());
          const peer = new PeerConnection(result.conn, myId, {
            onRemoteStream: (s) => setRemoteStream(s),
            onDisconnected: () => handleNext(),
            onError: (e) => console.error('[DIAGNOSTIC] Peer connection issue:', e),
          });
          peerRef.current = peer;
          await peer.attachLocalStream(stream);
          try {
            await peer.createOffer();
          } catch (err: any) {
            handleNext();
          } finally {
            isInitializingRef.current = false;
          }
        }
      } catch (err: any) {
        setError(err.message);
        setPhase('lobby');
        isInitializingRef.current = false;
      }
    },
    [myId, pushMatchNotification]
  );

  const startDirectCall = useCallback(async (friendId: string, directMode: ChatMode) => {
    if (isInitializingRef.current) return;
    isInitializingRef.current = true;

    setError(null);
    setMode(directMode);
    setPhase('searching');
    setConn(null);
    setRemoteStream(null);
    setConnectedAt(null);
    setFriendsDrawerOpen(false);

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }

    let stream: MediaStream | null = null;
    if (directMode === 'video') {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: { echoCancellation: true, noiseSuppression: true },
        });
        setLocalStream(stream);
      } catch (err) {
        setError('Media devices failed.');
        setPhase('lobby');
        isInitializingRef.current = false;
        return;
      }
    }

    if (directMode === 'text') {
      const { data: existing } = await supabase
        .from('connections')
        .select('*')
        .eq('mode', 'text')
        .eq('is_direct', true)
        .or(`and(initiator_id.eq.${myId},responder_id.eq.${friendId}),and(initiator_id.eq.${friendId},responder_id.eq.${myId})`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        setConn(existing);
        setPhase('connected');
        setConnectedAt(Date.now());
        isInitializingRef.current = false;
        return;
      }
    }

    const { data: directConn, error: cErr } = await supabase
      .from('connections')
      .insert({
        initiator_id: myId,
        responder_id: friendId,
        mode: directMode,
        status: 'pending',
        is_direct: true
      })
      .select()
      .single();

    if (cErr) {
      setError("Couldn't start call session.");
      setPhase('lobby');
      isInitializingRef.current = false;
      return;
    }

    setConn(directConn);
    setPhase('connected');
    setConnectedAt(Date.now());
    const peer = new PeerConnection(directConn, myId, {
      onRemoteStream: (s) => setRemoteStream(s),
      onDisconnected: () => handleStop(),
      onError: (e) => console.error(e),
    });
    peerRef.current = peer;
    await peer.attachLocalStream(stream);
    try {
      await peer.createOffer();
    } catch (err) {
      handleStop();
    } finally {
      isInitializingRef.current = false;
    }
  }, [myId]);

  const handleNext = useCallback(async () => {
    isInitializingRef.current = false;
    await teardownPeer();
    await leaveWaitingRoom(myId);
    unsubIncomingRef.current?.();
    unsubIncomingRef.current = null;
    setConn(null);
    setConnectedAt(null);
    startSearching(modeRef.current);
  }, [myId, teardownPeer, startSearching]);

  const handleStop = useCallback(async () => {
    isInitializingRef.current = false;
    await teardownPeer();
    await leaveWaitingRoom(myId);
    unsubIncomingRef.current?.();
    unsubIncomingRef.current = null;
    stopLocalStream();
    setConn(null);
    setPhase('lobby');
    setConnectedAt(null);
    setError(null);
  }, [myId, teardownPeer, stopLocalStream]);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-ink overflow-x-hidden relative">
      {phase !== 'connected' && (
        <Header
          profile={profile}
          onOpenProfile={onOpenProfile}
          onToggleDrawer={() => setFriendsDrawerOpen(!friendsDrawerOpen)}
        />
      )}

      {incomingInvitation && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-bg-elev border border-line rounded-2xl p-6 w-full max-w-sm text-center shadow-2xl animate-in zoom-in-95">
            <PhoneCall className="h-12 w-12 text-accent mx-auto animate-pulse mb-3" />
            <h3 className="text-lg font-bold">{inviterProfile?.display_name || 'A Friend'}</h3>
            <p className="text-sm text-ink-muted mb-6">Is calling you for a direct {incomingInvitation.mode} chat!</p>
            <div className="flex gap-3">
              <button onClick={rejectIncomingCall} className="flex-1 py-3 rounded-xl border border-line text-rose-500 font-semibold flex items-center justify-center gap-1"><PhoneOff className="h-4 w-4"/> Decline</button>
              <button onClick={acceptIncomingCall} className="flex-1 py-3 rounded-xl bg-accent text-white font-semibold flex items-center justify-center gap-1"><Video className="h-4 w-4"/> Answer</button>
            </div>
          </div>
        </div>
      )}
      
      <main className={`flex flex-1 flex-col items-center justify-center ${phase === 'connected' ? 'p-0 w-full h-screen' : 'px-4 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]'}`}>
        {error && phase !== 'connected' && (
          <div className="mb-4 w-full max-w-md rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-200">
            {error}
          </div>
        )}
        {phase === 'lobby' && <Lobby onStart={startSearching} profile={profile} />}
        {phase === 'searching' && <Searching mode={mode} onCancel={handleStop} />}
        {phase === 'connected' && conn && (
          <ChatRoom
            conn={conn}
            myId={myId}
            mode={mode}
            localStream={localStream}
            remoteStream={remoteStream}
            localVideoRef={localVideoRef}
            remoteVideoRef={remoteVideoRef}
            camOn={camOn}
            micOn={micOn}
            onToggleCam={toggleCam}
            onToggleMic={toggleMic}
            onNext={handleNext}
            onStop={handleStop}
            connectedAt={connectedAt}
          />
        )}
      </main>

      <FriendsDrawer isOpen={friendsDrawerOpen} onClose={() => setFriendsDrawerOpen(false)} myId={myId} onDirectCall={startDirectCall} />

      {phase !== 'connected' && <Footer />}
    </div>
  );
}

function Header({
  profile,
  onOpenProfile,
  onToggleDrawer,
}: {
  profile: ExtendedProfile;
  onOpenProfile: () => void;
  onToggleDrawer: () => void;
}) {
  const [perm, setPerm] = useState<NotificationPermission>('default');
  useEffect(() => { if ('Notification' in window) setPerm(Notification.permission); }, []);
  const enableAlerts = async () => { if ('Notification' in window) setPerm(await Notification.requestPermission()); };

  return (
    <header className="sticky top-0 z-30 w-full border-b border-line bg-bg/80 backdrop-blur-lg">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/20">
            <Sparkles className="h-5 w-5" />
          </div>
          <span className="text-base font-semibold tracking-tight">RandomLink</span>
        </div>

        <div className="flex items-center gap-3">
          {'Notification' in window && (
            <button 
              onClick={enableAlerts} 
              className={`h-9 px-3 text-xs font-semibold rounded-xl border transition ${
                perm === 'granted' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600' : 'border-line bg-bg-elev text-ink-muted'
              }`}
            >
              {perm === 'granted' ? 'Alerts Enabled' : 'Turn On Alerts'}
            </button>
          )}

          <button
            onClick={onOpenProfile}
            className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-bg-elev hover:border-accent transition"
            title="Profile & Settings"
          >
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="Profile" className="h-full w-full object-cover" />
            ) : (
              <User className="h-4 w-4 text-ink-muted" />
            )}
          </button>

          <button
            onClick={onToggleDrawer}
            className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-bg-elev text-ink-muted transition hover:text-ink"
            title="Open DMs"
          >
            <Menu className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

function Lobby({ onStart, profile }: { onStart: (mode: ChatMode) => void; profile: ExtendedProfile }) {
  return (
    <div className="flex w-full max-w-3xl flex-col items-center text-center">
      <h1 className="mt-2 bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
        Hey, {profile.display_name}
      </h1>
      <p className="mt-3 max-w-md text-ink-muted">
        Get paired with someone new. Open the side menu anytime to chat with friends.
      </p>

      <LiveChatStats />

      <div className="mt-8 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          onClick={() => onStart('video')}
          className="group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 text-left transition-all duration-300 hover:scale-[1.02] hover:shadow-xl border-sky-400/30"
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-sky-500/15 text-sky-500 transition-transform duration-300 group-hover:scale-110">
            <Video className="h-7 w-7" />
          </div>
          <h3 className="text-xl font-semibold text-ink">Video Chat</h3>
          <p className="mt-1 text-sm text-ink-muted">Face-to-face with camera and mic</p>
        </button>

        <button
          onClick={() => onStart('text')}
          className="group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 text-left transition-all duration-300 hover:scale-[1.02] hover:shadow-xl border-emerald-400/30"
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 transition-transform duration-300 group-hover:scale-110">
            <MessageSquare className="h-7 w-7" />
          </div>
          <h3 className="text-xl font-semibold text-ink">Text Chat</h3>
          <p className="mt-1 text-sm text-ink-muted">Messaging, no camera needed</p>
        </button>
      </div>
    </div>
  );
}

function FriendsDrawer({ isOpen, onClose, myId, onDirectCall }: { isOpen: boolean; onClose: () => void; myId: string; onDirectCall: (id: string, mode: ChatMode) => void }) {
  const [friends, setFriends] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchFriends = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('friendships')
      .select('*')
      .eq('status', 'accepted');

    if (!error && data) {
      const ids = data.map(f => f.user_id === myId ? f.friend_id : f.user_id);
      if (ids.length > 0) {
        const { data: profiles } = await supabase.from('profiles').select('*').in('user_id', ids);
        if (profiles) setFriends(profiles);
      } else {
        setFriends([]);
      }
    }
    setLoading(false);
  }, [myId]);

  useEffect(() => {
    if (!isOpen) return;
    fetchFriends();

    const channel = supabase.channel('friendships_drawer')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, fetchFriends)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [isOpen, fetchFriends]);

  const handleUnfriend = async (friendId: string) => {
    if (!window.confirm("Are you sure you want to unfriend this user?")) return;
    await supabase
      .from('friendships')
      .delete()
      .or(`and(user_id.eq.${myId},friend_id.eq.${friendId}),and(user_id.eq.${friendId},friend_id.eq.${friendId})`);
    fetchFriends();
  };

  return (
    <>
      {isOpen && <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 transition-opacity" onClick={onClose} />}
      <div className={`fixed top-0 right-0 h-full w-full sm:w-[400px] bg-bg border-l border-line z-50 shadow-2xl flex flex-col transition-transform duration-300 ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="p-4 border-b border-line flex items-center justify-between bg-bg-elev">
          <h3 className="text-base font-bold tracking-tight inline-flex items-center gap-2"><MessageSquare className="h-4 w-4 text-accent"/> Direct DMs</h3>
          <button onClick={onClose} className="p-2 rounded-xl border border-line text-ink-muted hover:text-ink bg-bg"><X className="h-4 w-4" /></button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="flex justify-center items-center h-32"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>
          ) : friends.length === 0 ? (
            <div className="text-center text-ink-faint py-10">
              <User className="h-8 w-8 mx-auto opacity-40 mb-2"/>
              <p className="text-sm">No connected friends yet. Add strangers during chat to build your friend list!</p>
            </div>
          ) : (
            friends.map(f => (
              <div key={f.user_id} className="flex items-center justify-between p-3 rounded-2xl bg-bg-elev border border-line shadow-sm hover:border-accent transition">
                <div className="flex items-center gap-2.5">
                  {f.avatar_url ? (
                    <img src={f.avatar_url} alt="" className="h-10 w-10 rounded-full object-cover border border-line" />
                  ) : (
                    <div className="h-10 w-10 rounded-full bg-accent/10 flex items-center justify-center"><User className="h-5 w-5 text-accent" /></div>
                  )}
                  <span className="text-sm font-semibold tracking-tight">{f.display_name}</span>
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => onDirectCall(f.user_id, 'text')} className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 transition" title="Text Chat"><MessageSquare className="h-4 w-4" /></button>
                  <button onClick={() => onDirectCall(f.user_id, 'video')} className="p-2.5 rounded-xl bg-sky-500/10 text-sky-500 hover:bg-sky-500/20 transition" title="Video Call"><Video className="h-4 w-4" /></button>
                  <button onClick={() => handleUnfriend(f.user_id)} className="p-2.5 rounded-xl bg-rose-500/10 text-rose-500 hover:bg-rose-500/20 transition" title="Unfriend"><UserMinus className="h-4 w-4" /></button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function Searching({ mode, onCancel }: { mode: ChatMode; onCancel: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="relative flex h-24 w-24 items-center justify-center">
        <div className="absolute inset-0 animate-ping rounded-full bg-accent/20" />
        <div className="absolute inset-2 animate-pulse rounded-full bg-accent/30" />
        <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-gradient-to-br from-accent to-accent-2 text-white">
          {mode === 'video' ? <Video className="h-7 w-7" /> : <MessageSquare className="h-7 w-7" />}
        </div>
      </div>
      <h2 className="mt-6 text-2xl font-semibold">Looking…</h2>
      <p className="mt-2 text-sm text-ink-muted">Finding someone for you.</p>

      <LiveChatStats />

      <button
        onClick={onCancel}
        className="mt-8 inline-flex items-center gap-2 rounded-xl border border-line bg-bg-elev px-5 py-2.5 text-sm font-medium text-ink-muted transition hover:text-ink"
      >
        <X className="h-4 w-4" /> Cancel
      </button>
    </div>
  );
}

function ChatRoom({
  conn,
  myId,
  mode,
  localStream,
  remoteStream,
  localVideoRef,
  remoteVideoRef,
  camOn,
  micOn,
  onToggleCam,
  onToggleMic,
  onNext,
  onStop,
  connectedAt,
}: {
  conn: SecureConnectionRow;
  myId: string;
  mode: ChatMode;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  camOn: boolean;
  micOn: boolean;
  onToggleCam: () => void;
  onToggleMic: () => void;
  onNext: () => void;
  onStop: () => void;
  connectedAt: number | null;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [partnerProfile, setPartnerProfile] = useState<any | null>(null);

  useEffect(() => {
    if (!conn) return;
    const partnerId = String(conn.initiator_id) === String(myId) ? conn.responder_id : conn.initiator_id;
    supabase
      .from('profiles')
      .select('*')
      .eq('user_id', partnerId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!error && data) setPartnerProfile(data);
      });
  }, [conn, myId]);

  useEffect(() => {
    if (!connectedAt) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - connectedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [connectedAt]);

  return (
    <div className="flex w-full h-full sm:h-auto sm:max-w-5xl flex-col sm:px-4">
      <div className="hidden sm:flex items-center justify-between mb-3 mt-4">
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          Connected · {formatTime(elapsed)}
        </div>
        <button onClick={onStop} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg-elev px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> Leave
        </button>
      </div>

      {mode === 'video' ? (
        <VideoRoom
          conn={conn}
          myId={myId}
          localStream={localStream}
          remoteStream={remoteStream}
          localVideoRef={localVideoRef}
          remoteVideoRef={remoteVideoRef}
          camOn={camOn}
          micOn={micOn}
          onToggleCam={onToggleCam}
          onToggleMic={onToggleMic}
          onNext={onNext}
          onStop={onStop}
          partnerProfile={partnerProfile}
        />
      ) : (
        <TextRoom conn={conn} myId={myId} onNext={onNext} partnerProfile={partnerProfile} onStop={onStop} />
      )}
    </div>
  );
}

function VideoRoom({
  conn,
  myId,
  localStream,
  remoteStream,
  localVideoRef,
  remoteVideoRef,
  camOn,
  micOn,
  onToggleCam,
  onToggleMic,
  onNext,
  onStop,
  partnerProfile,
}: {
  conn: SecureConnectionRow;
  myId: string;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  camOn: boolean;
  micOn: boolean;
  onToggleCam: () => void;
  onToggleMic: () => void;
  onNext: () => void;
  onStop: () => void;
  partnerProfile: any;
}) {
  const hasRemote = !!remoteStream && remoteStream.getTracks().length > 0;
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);

  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream, localVideoRef]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream, remoteVideoRef]);

  return (
    <div 
      className="flex flex-col gap-3 w-full h-full absolute inset-0 sm:relative sm:h-auto bg-black sm:bg-transparent"
      onTouchStart={(e) => { touchStartX.current = e.targetTouches[0].clientX; }}
      onTouchMove={(e) => { touchEndX.current = e.targetTouches[0].clientX; }}
      onTouchEnd={() => {
        if (touchEndX.current - touchStartX.current > 150) onNext();
        touchStartX.current = 0; touchEndX.current = 0;
      }}
    >
      <div className="relative w-full h-full sm:h-auto sm:aspect-video overflow-hidden sm:rounded-2xl border-0 sm:border border-line bg-neutral-950 shadow-2xl flex-1 sm:flex-initial">
        {hasRemote ? (
          <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover sm:object-contain absolute inset-0" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center text-slate-400 absolute inset-0">
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
            <p className="mt-3 text-sm">Waiting for remote feed…</p>
          </div>
        )}

        <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between bg-black/40 backdrop-blur-md px-3 py-2 rounded-2xl border border-white/10 sm:bg-bg-elev/80 sm:border-line">
          <div className="flex items-center gap-2">
            {partnerProfile?.avatar_url ? (
              <img src={partnerProfile.avatar_url} alt="" className="h-9 w-9 rounded-full object-cover border border-accent" />
            ) : (
              <div className="h-9 w-9 rounded-full bg-accent/20 text-accent flex items-center justify-center border border-accent">
                <User className="h-4 w-4" />
              </div>
            )}
            <span className="text-sm font-semibold text-white sm:text-ink max-w-[100px] truncate">{partnerProfile?.display_name || 'Stranger'}</span>
          </div>
          <FriendActionButton myId={myId} partnerId={conn.initiator_id === myId ? conn.responder_id : conn.initiator_id} />
        </div>

        <div className="absolute right-4 bottom-24 z-20 h-28 w-20 sm:h-32 sm:w-44 overflow-hidden rounded-xl border border-white/20 bg-slate-800 shadow-xl sm:bottom-3 sm:right-3">
          <video ref={localVideoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
          <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">You</span>
        </div>
      </div>

      <div className="absolute bottom-6 left-0 right-0 z-20 flex items-center justify-center gap-3 pt-1 px-4 sm:relative sm:bottom-0 sm:bg-transparent sm:px-0">
        <button onClick={onStop} className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md text-white sm:hidden"><ArrowLeft className="h-5 w-5" /></button>
        <ControlButton onClick={onToggleCam} active={camOn} label="Cam"><Camera className="h-5 w-5" /></ControlButton>
        <ControlButton onClick={onToggleMic} active={micOn} label={micOn ? 'Mute' : 'Unmute'}><MicIcon safeOn={micOn} /></ControlButton>
        <button onClick={onNext} className="inline-flex h-14 items-center gap-2 rounded-2xl bg-gradient-to-r from-accent to-accent-2 px-7 text-sm font-semibold text-white shadow-lg"><Shuffle className="h-5 w-5" /> Next</button>
      </div>
    </div>
  );
}

function FriendActionButton({ myId, partnerId }: { myId: string; partnerId: string }) {
  const [fStatus, setFStatus] = useState<'none' | 'pending_sent' | 'pending_received' | 'accepted'>('none');

  const checkFriendship = useCallback(async () => {
    const { data } = await supabase
      .from('friendships')
      .select('*')
      .or(`and(user_id.eq.${myId},friend_id.eq.${partnerId}),and(user_id.eq.${partnerId},friend_id.eq.${myId})`)
      .maybeSingle();

    if (data) {
      if (data.status === 'accepted') setFStatus('accepted');
      else if (data.user_id === myId) setFStatus('pending_sent');
      else setFStatus('pending_received');
    } else {
      setFStatus('none');
    }
  }, [myId, partnerId]);

  useEffect(() => {
    checkFriendship();

    const channel = supabase.channel(`friendship_room_${partnerId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'friendships' }, checkFriendship)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [partnerId, checkFriendship]);

  const addFriend = async () => {
    if (fStatus === 'none') {
      await supabase.from('friendships').insert({ user_id: myId, friend_id: partnerId, status: 'pending' });
      setFStatus('pending_sent');
    } else if (fStatus === 'pending_received') {
      await supabase.from('friendships').update({ status: 'accepted' }).eq('user_id', partnerId).eq('friend_id', myId);
      setFStatus('accepted');
    }
  };

  if (fStatus === 'accepted') return <span className="text-emerald-400 text-xs font-bold bg-emerald-500/10 px-2 py-1 rounded-xl inline-flex items-center gap-1"><Check className="h-3 w-3"/> Friends</span>;
  return (
    <button onClick={addFriend} className="inline-flex items-center gap-1 bg-accent hover:bg-accent-2 text-white text-xs font-semibold px-3 py-1.5 rounded-xl transition shadow-sm">
      <UserPlus className="h-3.5 w-3.5" />
      {fStatus === 'pending_sent' ? 'Sent' : fStatus === 'pending_received' ? 'Accept Friend' : 'Add Friend'}
    </button>
  );
}

function ControlButton({ onClick, active, label, children }: { onClick: () => void; active: boolean; label: string; children: any }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl border transition active:scale-95 ${
        active ? 'border-line bg-bg-elev text-ink' : 'border-rose-500/40 bg-rose-500/10 text-rose-500 dark:text-rose-300'
      }`}
    >
      {children}
    </button>
  );
}

const isImageUrl = (url: string) => {
  return url.match(/\.(jpeg|jpg|gif|png|webp|svg)/i) != null || url.includes('storage.googleapis.com') || url.includes('supabase.co');
};

function MicIcon({ safeOn }: { safeOn: boolean }) {
  return safeOn ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <line x1="2" y1="2" x2="22" y2="22" />
      <path d="M9 9v1a3 3 0 0 0 5.12 2.12" />
      <path d="M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M5 10a7 7 0 0 0 10.71 5.95" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}

function TextRoom({ conn, myId, onNext, partnerProfile, onStop }: { conn: SecureConnectionRow; myId: string; onNext: () => void; partnerProfile: any; onStop: () => void; }) {
  const [messages, setMessages] = useState<ExtendedMessageRow[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ExtendedMessageRow | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const syncMessages = useCallback(async () => {
    const { data } = await supabase.from('messages').select('*').eq('connection_id', conn.id).order('created_at', { ascending: true });
    if (data) {
      setMessages((data as any[]).map(msg => {
        if (msg.reply_to_id) {
          const q = data.find(m => m.id === msg.reply_to_id);
          return { ...msg, reply_body: q ? q.body : "Message unavailable" };
        }
        return msg;
      }));
    }
  }, [conn.id]);

  useEffect(() => {
    syncMessages();
    const channel = supabase.channel(`realtime_msg_${conn.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `connection_id=eq.${conn.id}` }, (payload) => {
        const newMsg = payload.new as MessageRow;
        if (String(newMsg.sender_id) !== String(myId) && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          navigator.serviceWorker.ready.then((reg) => {
            reg.showNotification(partnerProfile?.display_name || "New Message", {
              body: newMsg.body.startsWith('http') ? "📷 Sent an image attachment" : newMsg.body,
              icon: partnerProfile?.avatar_url || undefined,
              tag: conn.id,
              renotify: true,
              data: { connectionId: conn.id, myId: myId },
              actions: [{ action: 'reply', title: 'Reply', type: 'text', placeholder: 'Type response...' }]
            });
          });
        }
        syncMessages();
      })
      .on('broadcast', { event: 'typing' }, (payload) => {
        if (String(payload.payload.senderId) !== String(myId)) {
          setIsTyping(true);
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = window.setTimeout(() => setIsTyping(false), 2000);
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [conn.id, myId, syncMessages, partnerProfile]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }, [messages, isTyping]);
  const handleInputChange = (val: string) => { setInput(val); supabase.channel(`realtime_msg_${conn.id}`).send({ type: 'broadcast', event: 'typing', payload: { senderId: myId } }); };

  const send = async (textBody?: string) => {
    const body = (textBody ?? input).trim();
    if (!body || sending) return;
    if (!textBody) setInput('');
    setSending(true);
    const payload: any = { connection_id: conn.id, sender_id: myId, body };
    if (replyTarget) payload.reply_to_id = replyTarget.id;
    await supabase.from('messages').insert(payload);
    setSending(false);
    setReplyTarget(null);
    syncMessages();
  };

  const handleAttachmentPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setUploading(true);
      const file = e.target.files[0];
      const path = `${conn.id}/${Date.now()}-${Math.random()}.${file.name.split('.').pop()}`;
      const { error } = await supabase.storage.from('attachments').upload(path, file);
      if (!error) {
        const { data } = supabase.storage.from('attachments').getPublicUrl(path);
        if (data?.publicUrl) await send(data.publicUrl);
      }
      setUploading(false);
    }
  };

  return (
    <div className="flex h-screen sm:h-[68vh] flex-col overflow-hidden sm:rounded-2xl border border-line bg-bg w-full">
      <div className="flex items-center justify-between p-4 border-b border-line bg-bg-elev">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{partnerProfile?.display_name || 'Stranger'}</span>
          <FriendActionButton myId={myId} partnerId={conn.initiator_id === myId ? conn.responder_id : conn.initiator_id} />
        </div>
        <button onClick={onStop} className="text-xs font-medium text-rose-500 bg-rose-500/10 px-3 py-1.5 rounded-xl">Leave</button>
      </div>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 bg-bg-muted/30">
        {messages.map((m) => {
          const mine = m.sender_id === myId;
          const isLink = m.body.startsWith('http');
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'} group`}>
              <div className="flex items-center gap-2 max-w-[78%]">
                {!mine && <button onClick={() => setReplyTarget(m)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-xl bg-bg border border-line text-ink-muted hover:text-ink transition order-last shadow-sm"><CornerUpLeft className="h-3.5 w-3.5" /></button>}
                <div className={`rounded-2xl px-4 py-2 text-sm shadow-sm ${mine ? 'bg-accent text-white shadow-md' : 'bg-bg border text-ink'}`}>
                  {m.reply_body && <div className="mb-1.5 p-1.5 rounded-lg text-[11px] bg-black/5 text-ink-muted border-l-2 border-accent truncate max-w-[200px]">{m.reply_body}</div>}
                  {isLink ? (
                    isImageUrl(m.body) ? (
                      <div className="py-1">
                        <img src={m.body} alt="Attachment" className="rounded-lg max-h-48 object-contain bg-black/5" />
                        <a href={m.body} target="_blank" rel="noreferrer" className="block text-[11px] underline mt-1 text-center opacity-80">Open Full Size</a>
                      </div>
                    ) : (
                      <a href={m.body} target="_blank" rel="noreferrer" className="underline inline-flex items-center gap-1"><Download className="h-4 w-4" /> Download file</a>
                    )
                  ) : m.body}
                </div>
                {mine && <button onClick={() => setReplyTarget(m)} className="opacity-0 group-hover:opacity-100 p-1.5 rounded-xl bg-bg border border-line text-ink-muted hover:text-ink transition shadow-sm"><CornerUpLeft className="h-3.5 w-3.5" /></button>}
              </div>
            </div>
          );
        })}
        {isTyping && (
          <div className="flex justify-start items-center gap-1.5 py-1">
            <span className="text-xs text-ink-muted">{partnerProfile?.display_name || 'Stranger'} is typing</span>
            <div className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce bg-accent rounded-full [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce bg-accent rounded-full [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce bg-accent rounded-full" />
            </div>
          </div>
        )}
      </div>
      <div className="border-t border-line p-3 bg-bg-elev shadow-inner">
        {replyTarget && <div className="mb-2 flex items-center justify-between p-2 rounded-xl bg-bg border border-line text-xs"><div className="truncate"><span className="font-semibold text-accent block">Replying to:</span><span className="text-ink-muted truncate block max-w-md">{replyTarget.body}</span></div><button onClick={() => setReplyTarget(null)} className="text-ink-faint hover:text-ink p-1"><X className="h-4 w-4" /></button></div>}
        <div className="flex items-center gap-2">
          <input type="file" ref={fileInputRef} onChange={handleAttachmentPick} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-bg text-ink-muted hover:text-ink transition">{uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}</button>
          <input value={input} onChange={(e) => handleInputChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Type a message…" className="flex-1 min-w-0 rounded-xl border bg-bg px-4 py-3 text-sm focus:outline-none" />
          <button onClick={() => send()} disabled={!input.trim()} className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white transition disabled:opacity-40"><Send className="h-5 w-5" /></button>
        </div>
        <button onClick={onNext} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border bg-bg py-2.5 text-sm font-medium text-ink-muted hover:text-ink transition"><Shuffle className="h-4 w-4" /> Next stranger</button>
      </div>
    </div>
  );
}

function EditProfileModal({
  profile,
  email,
  onClose,
  onRefresh,
  onSignOut,
  theme,
  onToggleTheme,
}: {
  profile: ExtendedProfile;
  email: string;
  onClose: () => void;
  onRefresh: () => void;
  onSignOut: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const [name, setName] = useState(profile.display_name || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpdate = async () => {
    setSaving(true);
    const { error } = await supabase
      .from('profiles')
      .update({ display_name: name.trim() })
      .eq('user_id', profile.user_id);
    setSaving(false);
    if (!error) {
      onRefresh();
      setEditing(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setUploading(true);
      const file = e.target.files[0];
      const ext = file.name.split('.').pop();
      const path = `${profile.user_id}/${Date.now()}.${ext}`;

      const { error: uploadError } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
      if (!uploadError) {
        const { data } = supabase.storage.from('avatars').getPublicUrl(path);
        if (data?.publicUrl) {
          await supabase.from('profiles').update({ avatar_url: data.publicUrl }).eq('user_id', profile.user_id);
          onRefresh();
        }
      }
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-bg-elev p-6 shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold tracking-tight">Account & Settings</h3>
          <button onClick={onClose} className="text-ink-muted hover:text-ink"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex flex-col items-center gap-3 py-2 border-b border-line pb-4">
          <input type="file" ref={fileRef} onChange={handleAvatarChange} accept="image/*" className="hidden" />
          <div className="relative group">
            <button 
              onClick={() => fileRef.current?.click()}
              className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-full border border-line bg-bg shadow-sm"
            >
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt="Avatar" className="h-full w-full object-cover" />
              ) : (
                <User className="h-6 w-6 text-ink-faint" />
              )}
            </button>
            <button onClick={() => fileRef.current?.click()} className="absolute bottom-0 right-0 p-1.5 rounded-full bg-accent text-white shadow-md">
              {uploading ? <Loader2 className="h-3 w-3 animate-spin"/> : <Camera className="h-3 w-3"/>}
            </button>
          </div>
          
          <div className="text-center w-full">
            {editing ? (
              <div className="flex gap-2 mt-1 px-2">
                <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent" />
                <button onClick={handleUpdate} disabled={saving || !name.trim()} className="bg-accent text-white text-xs font-semibold px-3 py-1.5 rounded-xl">Save</button>
              </div>
            ) : (
              <h4 className="text-base font-bold flex items-center gap-1.5">
                {profile.display_name}
                <button onClick={() => setEditing(true)} className="text-ink-muted hover:text-ink"><Edit className="h-3.5 w-3.5" /></button>
              </h4>
            )}
            <p className="text-xs text-ink-faint truncate max-w-[280px] mx-auto mt-0.5">{email}</p>
          </div>
        </div>

        <div className="space-y-3 mt-4">
          <div className="flex items-center justify-between p-2 rounded-xl bg-bg border border-line">
            <span className="text-xs font-semibold text-ink-muted pl-1">Interface Mode</span>
            <button onClick={onToggleTheme} className="inline-flex h-8 px-3 items-center gap-1.5 rounded-lg border border-line bg-bg-elev text-xs font-medium text-ink-muted transition hover:text-ink">
              {theme === 'dark' ? <><Sun className="h-3.5 w-3.5" /> Light</> : <><Moon className="h-3.5 w-3.5" /> Dark</>}
            </button>
          </div>

          <button
            onClick={onSignOut}
            className="w-full flex items-center justify-center gap-2 rounded-xl border border-rose-500/20 bg-rose-500/5 hover:bg-rose-500/10 py-2.5 text-sm font-semibold text-rose-500 transition active:scale-95"
          >
            <LogOut className="h-4 w-4" /> Sign out account
          </button>
        </div>
      </div>
    </div>
  );
}

function LiveChatStats() {
  const [stats, setStats] = useState({
    video: { online: 0, chatting: 0 },
    text: { online: 0, chatting: 0 }
  });

  useEffect(() => {
    let active = true;
    const fetchStats = async () => {
      const [{ data: waiting }, { data: activeConns }] = await Promise.all([
        supabase.from('waiting_room').select('mode'),
        supabase.from('connections').select('mode, created_at, updated_at').eq('status', 'connected')
      ]);

      if (!active) return;
      const newStats = { video: { online: 0, chatting: 0 }, text: { online: 0, chatting: 0 } };

      waiting?.forEach(r => { if (r.mode === 'video' || r.mode === 'text') newStats[r.mode].online++; });
      
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;

      activeConns?.forEach(r => {
        if (r.mode === 'video') {
          newStats.video.chatting += 2;
          newStats.video.online += 2;
        } else if (r.mode === 'text') {
          const lastActive = new Date(r.updated_at || r.created_at).getTime();
          if (lastActive >= fiveMinutesAgo) {
            newStats.text.chatting += 2;
          }
          newStats.text.online += 2;
        }
      });
      setStats(newStats);
    };

    fetchStats();
    
    const channel = supabase.channel('stats_channel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'waiting_room' }, fetchStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'connections' }, fetchStats)
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="w-full flex flex-col items-center sm:flex-row sm:justify-center gap-3">
      <div className="flex items-center justify-between rounded-xl border border-line bg-bg-elev p-3 shadow-sm w-full max-w-xs mb-2 mt-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500"><Video className="h-4 w-4" /></div>
          <div className="flex flex-col text-left">
            <span className="text-[10px] font-bold text-ink uppercase tracking-wider">Video Network</span>
            <span className="text-[10px] text-ink-muted">{stats.video.online} Online • <span className="text-accent font-semibold">{stats.video.chatting} Chatting</span></span>
          </div>
        </div>
        <div className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
      </div>

      <div className="flex items-center justify-between rounded-xl border border-line bg-bg-elev p-3 shadow-sm w-full max-w-xs mb-2 sm:mt-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600"><MessageSquare className="h-4 w-4" /></div>
          <div className="flex flex-col text-left">
            <span className="text-[10px] font-bold text-ink uppercase tracking-wider">Text Network</span>
            <span className="text-[10px] text-ink-muted">{stats.text.online} Online • <span className="text-accent font-semibold">{stats.text.chatting} Chatting</span></span>
          </div>
        </div>
        <div className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
      </div>
    </div>
  );
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function Footer() {
  return (
    <footer className="w-full border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-center text-xs text-ink-faint">
      Be respectful. Use Next to skip anyone.
    </footer>
  );
}
