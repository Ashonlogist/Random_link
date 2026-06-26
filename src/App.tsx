import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, MessageSquare, Shuffle, X, Send, Loader2, Camera, ArrowLeft, Sparkles, LogOut, Sun, Moon, MoreVertical, Paperclip, Download, User, Edit } from 'lucide-react';
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

export default function App() {
  const { session, loading, refreshProfile, signOut } = useSession();
  const { theme, toggle } = useTheme();
  const [profileModalOpen, setProfileModalOpen] = useState(false);

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
      />
      
      {profileModalOpen && (
        <EditProfileModal 
          profile={session.profile as ExtendedProfile} 
          onClose={() => setProfileModalOpen(false)} 
          onRefresh={refreshProfile}
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
}: {
  myId: string;
  profile: ExtendedProfile;
  email: string;
  onSignOut: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenProfile: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('lobby');
  const [mode, setMode] = useState<ChatMode>('video');
  const [conn, setConn] = useState<ConnectionRow | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [camOn, setCamOn] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const peerRef = useRef<PeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const unsubIncomingRef = useRef<(() => void) | null>(null);
  const pruneTimerRef = useRef<number | null>(null);
  const modeRef = useRef<ChatMode>('video');
  const connRef = useRef<ConnectionRow | null>(null);
  const connectedAtRef = useRef<number | null>(null);

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
        if (peerRef.current) return;
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
        }
      });

      try {
        const result = await findMatch(myId, selectedMode);
        if (result) {
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
          await peer.createOffer();
        }
      } catch (err: any) {
        setError(err.message);
        setPhase('lobby');
      }
    },
    [myId]
  );

  const handleNext = useCallback(async () => {
    await teardownPeer();
    await leaveWaitingRoom(myId);
    unsubIncomingRef.current?.();
    unsubIncomingRef.current = null;
    setConn(null);
    setConnectedAt(null);
    startSearching(modeRef.current);
  }, [myId, teardownPeer, startSearching]);

  const handleStop = useCallback(async () => {
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

  const toggleCam = useCallback(() => {
    if (!localStream) return;
    const newCam = !camOn;
    localStream.getVideoTracks().forEach((t) => (t.enabled = newCam));
    setCamOn(newCam);
  }, [localStream, camOn]);

  const toggleMic = useCallback(() => {
    if (!localStream) return;
    const newMic = !micOn;
    localStream.getAudioTracks().forEach((t) => (t.enabled = newMic));
    setMicOn(newMic);
  }, [localStream, micOn]);

  return (
    <div className="flex min-h-screen flex-col bg-bg text-ink overflow-x-hidden">
      {phase !== 'connected' && (
        <Header
          profile={profile}
          email={email}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          onSignOut={onSignOut}
          theme={theme}
          onToggleTheme={onToggleTheme} // FIXED: Passed the correct variable name
          onOpenProfile={onOpenProfile}
        />
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
      {phase !== 'connected' && <Footer />}
    </div>
  );
}

function ThemeButton({ theme, onToggle, className }: { theme: 'light' | 'dark'; onToggle: () => void; className?: string }) {
  return (
    <button
      onClick={onToggle}
      aria-label="Toggle theme"
      className={`inline-flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-bg-elev text-ink-muted transition hover:text-ink ${className ?? ''}`}
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function Header({
  profile,
  email,
  menuOpen,
  setMenuOpen,
  onSignOut,
  theme,
  onToggleTheme,
  onOpenProfile,
}: {
  profile: ExtendedProfile;
  email: string;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onSignOut: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenProfile: () => void;
}) {
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
          <ThemeButton theme={theme} onToggle={onToggleTheme} />
          
          <button
            onClick={onOpenProfile}
            className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-bg-elev hover:border-accent transition"
            title="Profile Settings"
          >
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="Profile" className="h-full w-full object-cover" />
            ) : (
              <User className="h-4 w-4 text-ink-muted" />
            )}
          </button>

          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-bg-elev text-ink-muted transition hover:text-ink"
            >
              <MoreVertical className="h-4 w-4" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div className="absolute right-0 z-20 mt-2 w-60 rounded-xl border border-line bg-bg-elev p-2 shadow-2xl">
                  <div className="px-3 py-2">
                    <p className="text-sm font-medium text-ink">{profile.display_name}</p>
                    <p className="truncate text-xs text-ink-faint">{email}</p>
                  </div>
                  <div className="my-1 h-px bg-line" />
                  <button onClick={onSignOut} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-500 transition hover:bg-rose-500/10">
                    <LogOut className="h-4 w-4" /> Sign out
                  </button>
                </div>
              </>
            )}
          </div>
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
        Get paired with someone new. Choose how you want to connect.
      </p>

      <div className="mt-8 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
        <button
          onClick={() => onStart('video')}
          className="group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 text-left transition-all duration-300 hover:scale-[1.02] hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-accent/50 border-sky-400/30"
        >
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-sky-500/15 text-sky-500 transition-transform duration-300 group-hover:scale-110">
            <Video className="h-7 w-7" />
          </div>
          <h3 className="text-xl font-semibold text-ink">Video Chat</h3>
          <p className="mt-1 text-sm text-ink-muted">Face-to-face with camera and mic</p>
        </button>

        <button
          onClick={() => onStart('text')}
          className="group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 text-left transition-all duration-300 hover:scale-[1.02] hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-accent/50 border-emerald-400/30"
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
  conn: ConnectionRow;
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
        else {
          supabase.from('profiles').select('display_name').eq('user_id', partnerId).maybeSingle()
            .then(({ data: d }) => { if (d) setPartnerProfile(d); });
        }
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

        <div className="absolute top-4 left-4 z-20 flex items-center gap-3 bg-black/40 backdrop-blur-md px-3 py-2 rounded-2xl border border-white/10 sm:bg-bg-elev/80 sm:border-line">
          {partnerProfile?.avatar_url ? (
            <img src={partnerProfile.avatar_url} alt="Partner" className="h-9 w-9 rounded-full object-cover border border-accent" />
          ) : (
            <div className="h-9 w-9 rounded-full bg-accent/20 text-accent flex items-center justify-center border border-accent">
              <User className="h-4 w-4" />
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-white sm:text-ink">{partnerProfile?.display_name || 'Stranger'}</span>
          </div>
        </div>

        <div className="absolute right-4 top-4 z-20 h-28 w-20 sm:h-32 sm:w-44 overflow-hidden rounded-xl border border-white/20 bg-slate-800 shadow-xl sm:bottom-3 sm:right-3 sm:top-auto">
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

function ControlButton({
  onClick,
  active,
  label,
  children,
}: {
  onClick: () => void;
  active: boolean;
  label: string;
  children: any;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl border transition active:scale-95 ${
        active
          ? 'border-line bg-bg-elev text-ink'
          : 'border-rose-500/40 bg-rose-500/10 text-rose-500 dark:text-rose-300'
      }`}
    >
      {children}
    </button>
  );
}

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

function TextRoom({ 
  conn, 
  myId, 
  onNext, 
  partnerProfile,
  onStop,
}: { 
  conn: ConnectionRow; 
  myId: string; 
  onNext: () => void; 
  partnerProfile: any;
  onStop: () => void;
}) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    
    const fetchLatestMessages = () => {
      supabase
        .from('messages')
        .select('*')
        .eq('connection_id', conn.id)
        .order('created_at', { ascending: true })
        .then(({ data }) => {
          if (active && data) setMessages(data as MessageRow[]);
        });
    };

    fetchLatestMessages();

    const pollInterval = window.setInterval(fetchLatestMessages, 1500);

    const channel = supabase
      .channel(`chat-room-fallback-${conn.id}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        (payload) => {
          if (!active) return;
          const newMsg = payload.new as MessageRow;
          if (String(newMsg.connection_id) === String(conn.id)) {
            setMessages((prev) => prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg]);
          }
        }
      )
      .on('broadcast', { event: 'typing' }, (payload) => {
        if (!active) return;
        if (String(payload.payload.senderId) !== String(myId)) {
          setIsTyping(true);
          if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
          typingTimeoutRef.current = window.setTimeout(() => setIsTyping(false), 2000);
        }
      })
      .subscribe();

    return () => {
      active = false;
      clearInterval(pollInterval);
      channel.unsubscribe();
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [conn.id, myId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isTyping]);

  const handleInputChange = (val: string) => {
    setInput(val);
    supabase.channel(`chat-room-fallback-${conn.id}`).send({
      type: 'broadcast',
      event: 'typing',
      payload: { senderId: myId }
    });
  };

  const send = async (textBody?: string) => {
    const body = (textBody ?? input).trim();
    if (!body || sending) return;
    if (!textBody) setInput('');
    setSending(true);

    const { error } = await supabase.from('messages').insert({
      connection_id: conn.id,
      sender_id: myId,
      body,
    });
    setSending(false);
    if (error) {
      if (!textBody) setInput(body);
    }
  };

  const handleAttachmentPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setUploading(true);
      try {
        const fileExt = file.name.split('.').pop();
        const path = `${conn.id}/${Date.now()}-${Math.random()}.${fileExt}`;
        const { error: uploadError } = await supabase.storage.from('attachments').upload(path, file);
        if (uploadError) throw uploadError;
        const { data } = supabase.storage.from('attachments').getPublicUrl(path);
        if (data?.publicUrl) await send(data.publicUrl);
      } catch (err) {
        console.error(err);
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }
  };

  const isImageUrl = (url: string) => {
    return url.match(/\.(jpeg|jpg|gif|png|webp|svg)/i) != null || url.includes('storage.googleapis.com') || url.includes('supabase.co');
  };

  return (
    <div className="flex h-screen sm:h-[68vh] flex-col overflow-hidden sm:rounded-2xl border border-line bg-bg w-full">
      <div className="flex sm:hidden items-center justify-between p-4 border-b border-line bg-bg-elev">
        <span className="text-sm font-semibold">{partnerProfile?.display_name || 'Stranger'}</span>
        <button onClick={onStop} className="text-xs font-medium text-rose-500 bg-rose-500/10 px-3 py-1.5 rounded-xl">Leave</button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-ink-faint">
            <MessageSquare className="h-8 w-8" />
            <p className="mt-2 text-sm">Say hi to {partnerProfile?.display_name || 'Stranger'}!</p>
          </div>
        )}
        {messages.map((m) => {
          const mine = m.sender_id === myId;
          const isLink = m.body.startsWith('http');
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[78%] rounded-2xl px-4 py-2 text-sm ${mine ? 'bg-accent text-white shadow-md' : 'bg-bg-muted text-ink border border-line'}`}>
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

      <div className="border-t border-line p-3 bg-bg-elev">
        <div className="flex items-center gap-2">
          <input type="file" ref={fileInputRef} onChange={handleAttachmentPick} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border bg-bg text-ink-muted">
            {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
          </button>
          <input
            value={input}
            onChange={(e) => handleInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type a message…"
            className="flex-1 min-w-0 rounded-xl border bg-bg px-4 py-3 text-sm focus:outline-none"
          />
          <button onClick={() => send()} disabled={!input.trim()} className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-40"><Send className="h-5 w-5" /></button>
        </div>
        <button onClick={onNext} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border bg-bg py-2.5 text-sm font-medium text-ink-muted"><Shuffle className="h-4 w-4" /> Next stranger</button>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="w-full border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-center text-xs text-ink-faint">
      Be respectful. Use Next to skip anyone.
    </footer>
  );
}

function EditProfileModal({
  profile,
  onClose,
  onRefresh,
}: {
  profile: ExtendedProfile;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [name, setName] = useState(profile.display_name || '');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
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
      onClose();
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setUploading(true);
      const file = e.target.files[0];
      const ext = file.name.split('.').pop();
      const path = `${profile.user_id}-${Date.now()}.${ext}`;

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
        <div className="fixed inset-0" onClick={onClose} />
        <div className="relative z-10">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold">Profile Settings</h3>
            <button onClick={onClose} className="text-ink-muted hover:text-ink"><X className="h-5 w-5" /></button>
          </div>

          <div className="flex flex-col items-center gap-3 py-2">
            <input type="file" ref={fileRef} onChange={handleAvatarChange} accept="image/*" className="hidden" />
            <button 
              onClick={() => fileRef.current?.click()}
              className="group relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border border-dashed border-line bg-bg"
            >
              {profile.avatar_url ? (
                <img src={profile.avatar_url} alt="Avatar" className="h-full w-full object-cover" />
              ) : (
                <User className="h-8 w-8 text-ink-faint" />
              )}
              <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition text-white">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Edit className="h-4 w-4" />}
              </div>
            </button>
          </div>

          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs font-semibold text-ink-muted block mb-1">Display Name</label>
              <input 
                value={name} 
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-xl border border-line bg-bg px-4 py-2.5 text-sm"
              />
            </div>

            <button
              onClick={handleUpdate}
              disabled={saving || !name.trim()}
              className="w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-white shadow-lg transition active:scale-95 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin mx-auto" /> : 'Save Modifications'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
