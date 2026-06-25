import { useCallback, useEffect, useRef, useState } from 'react';
import { Video, MessageSquare, Shuffle, X, Send, Users, Loader2, Camera, CameraOff, ArrowLeft, Sparkles, LogOut, Sun, Moon, MoreVertical, Paperclip, Download, User } from 'lucide-react';
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

export default function App() {
  const { session, loading, refreshProfile, signOut } = useSession();
  const { theme, toggle } = useTheme();

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
    <ChatApp
      myId={session.user.id}
      profile={session.profile!}
      email={session.user.email}
      onSignOut={signOut}
      theme={theme}
      onToggleTheme={toggle}
    />
  );
}

function ChatApp({
  myId,
  profile,
  email,
  onSignOut,
  theme,
  onToggleTheme,
}: {
  myId: string;
  profile: Profile;
  email: string;
  onSignOut: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
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
  const [partnerProfile, setPartnerProfile] = useState<any | null>(null);

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

  // Force instant attachment of captured stream copies directly to native nodes
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream, phase]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream, phase]);

  // Fetch match partner identity profiles dynamically on connection state activation
  useEffect(() => {
    if (!conn) {
      setPartnerProfile(null);
      return;
    }
    const partnerId = conn.initiator_id === myId ? conn.responder_id : conn.initiator_id;
    
    // Explicitly fetch user details to replace "Stranger" with real names
    supabase
      .from('profiles')
      .select('display_name, avatar_url')
      .eq('user_id', partnerId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!error && data) {
          setPartnerProfile(data);
        }
      });
  }, [conn, myId]);

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
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
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
            audio: true,
          });
          setLocalStream(stream);
        } catch (err: any) {
          const reason =
            err?.name === 'NotAllowedError'
              ? 'Camera/mic permission was denied. Allow access in your browser and try again.'
              : err?.name === 'NotFoundError' || err?.name === 'DevicesNotFoundError'
              ? 'No camera or microphone found. Connect a device or use Text Chat instead.'
              : err?.name === 'NotReadableError'
              ? 'Your camera/mic is in use by another app. Close it and try again.'
              : 'Could not access camera/microphone. ' + (err?.message ?? '');
          setError(reason);
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
          onError: (e) => setError(e.message),
        });
        peerRef.current = peer;
        await peer.attachLocalStream(stream);
        try {
          await peer.acceptOffer();
        } catch (err: any) {
          setError('Failed to accept call: ' + err.message);
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
            onError: (e) => setError(e.message),
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
          onToggleTheme={onToggleTheme}
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
            partnerProfile={partnerProfile}
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
}: {
  profile: Profile;
  email: string;
  menuOpen: boolean;
  setMenuOpen: (v: boolean) => void;
  onSignOut: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 w-full border-b border-line bg-bg/80 backdrop-blur-lg">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-2 text-white shadow-lg shadow-accent/20">
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-base font-semibold tracking-tight">RandomLink</span>
            <span className="hidden text-[11px] text-ink-faint sm:inline">talk to strangers</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ThemeButton theme={theme} onToggle={onToggleTheme} />
          <div className="relative">
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-bg-elev text-ink-muted transition hover:text-ink"
              aria-label="Account menu"
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
                  <button
                    onClick={onSignOut}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-rose-500 transition hover:bg-rose-500/10"
                  >
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

function Footer() {
  return (
    <footer className="w-full border-t border-line px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-center text-xs text-ink-faint">
      Be respectful. Use Next to skip anyone.
    </footer>
  );
}

function Lobby({ onStart, profile }: { onStart: (mode: ChatMode) => void; profile: Profile }) {
  return (
    <div className="flex w-full max-w-3xl flex-col items-center text-center">
      <h1 className="mt-2 bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-4xl font-bold tracking-tight text-transparent sm:text-5xl">
        Hey, {profile.display_name}
      </h1>
      <p className="mt-3 max-w-md text-ink-muted">
        Get paired with someone new. Choose how you want to connect.
      </p>

      <div className="mt-8 grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
        <ModeCard
          icon={<Video className="h-7 w-7" />}
          title="Video Chat"
          desc="Face-to-face with camera and mic"
          accent="from-sky-500/15 to-cyan-500/10 border-sky-400/30"
          iconWrap="bg-sky-500/15 text-sky-500 dark:text-sky-300"
          onClick={() => onStart('video')}
        />
        <ModeCard
          icon={<MessageSquare className="h-7 w-7" />}
          title="Text Chat"
          desc="Messaging, no camera needed"
          accent="from-emerald-500/15 to-teal-500/10 border-emerald-400/30"
          iconWrap="bg-emerald-500/15 text-emerald-600 dark:text-emerald-300"
          onClick={() => onStart('text')}
        />
      </div>

      <div className="mt-8 flex items-center gap-2 text-xs text-ink-faint">
        <Users className="h-4 w-4" />
        <span>Peer-to-peer · powered by WebRTC</span>
      </div>
    </div>
  );
}

function ModeCard({
  icon,
  title,
  desc,
  accent,
  iconWrap,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  accent: string;
  iconWrap: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`group relative overflow-hidden rounded-2xl border bg-gradient-to-br p-6 text-left transition-all duration-300 hover:scale-[1.02] hover:shadow-xl focus:outline-none focus:ring-2 focus:ring-accent/50 ${accent}`}
    >
      <div className={`mb-4 flex h-14 w-14 items-center justify-center rounded-xl ${iconWrap} transition-transform duration-300 group-hover:scale-110`}>
        {icon}
      </div>
      <h3 className="text-xl font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-sm text-ink-muted">{desc}</p>
      <div className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent opacity-0 transition-opacity duration-300 group-hover:opacity-100">
        Start now <Shuffle className="h-4 w-4" />
      </div>
    </button>
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
  partnerProfile,
}: {
  conn: ConnectionRow;
  myId: string;
  mode: ChatMode;
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
  partnerProfile: any;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!connectedAt) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - connectedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [connectedAt]);

  return (
    <div className="flex w-full h-full sm:h-auto sm:max-w-5xl flex-col sm:px-4">
      {/* Absolute top dashboard on desktop view */}
      <div className="hidden sm:flex items-center justify-between mb-3 mt-4">
        <div className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          Connected · {formatTime(elapsed)}
        </div>
        <button
          onClick={onStop}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-bg-elev px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Leave
        </button>
      </div>

      {mode === 'video' ? (
        <VideoRoom
          remoteStream={remoteStream}
          localVideoRef={localVideoRef}
          remoteVideoRef={remoteVideoRef}
          camOn={camOn}
          micOn={micOn}
          onToggleCam={onToggleCam}
          onToggleMic={onToggleMic}
          onNext={onNext}
          onStop={onStop}
          elapsed={elapsed}
          partnerProfile={partnerProfile}
        />
      ) : (
        <TextRoom conn={conn} myId={myId} onNext={onNext} partnerProfile={partnerProfile} onStop={onStop} elapsed={elapsed} />
      )}
    </div>
  );
}

function VideoRoom({
  remoteStream,
  localVideoRef,
  remoteVideoRef,
  camOn,
  micOn,
  onToggleCam,
  onToggleMic,
  onNext,
  onStop,
  elapsed,
  partnerProfile,
}: {
  remoteStream: MediaStream | null;
  localVideoRef: React.RefObject<HTMLVideoElement>;
  remoteVideoRef: React.RefObject<HTMLVideoElement>;
  camOn: boolean;
  micOn: boolean;
  onToggleCam: () => void;
  onToggleMic: () => void;
  onNext: () => void;
  onStop: () => void;
  elapsed: number;
  partnerProfile: any;
}) {
  const hasRemote = !!remoteStream && remoteStream.getTracks().length > 0;
  
  // Mobile Gesture Tracking Mechanics (Horizontal Swipes to the Right triggers Skip)
  const touchStartX = useRef<number>(0);
  const touchEndX = useRef<number>(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    const threshold = 150; // Minimum swipe distance
    if (touchEndX.current - touchStartX.current > threshold) {
      onNext(); // Horizontal rightward swipe skips partner instantly
    }
    touchStartX.current = 0;
    touchEndX.current = 0;
  };

  return (
    <div 
      className="flex flex-col gap-3 w-full h-full sm:h-auto absolute inset-0 sm:relative bg-black sm:bg-transparent"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Video Framing Window */}
      <div className="relative w-full h-full sm:h-auto sm:aspect-video overflow-hidden sm:rounded-2xl border-0 sm:border border-line bg-black shadow-2xl flex-1 sm:flex-initial">
        {hasRemote ? (
          <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover absolute inset-0" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center text-slate-400 absolute inset-0">
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
            <p className="mt-3 text-sm">Connecting…</p>
          </div>
        )}

        {/* Mobile Overlay Banner & Partner Details */}
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
            <span className="text-[10px] text-white/70 sm:text-ink-muted sm:hidden">Live · {formatTime(elapsed)}</span>
          </div>
        </div>

        {/* Local Self Preview Box (Tiny Floating Frame) */}
        <div className="absolute right-4 top-4 z-20 h-28 w-20 sm:h-32 sm:w-44 overflow-hidden rounded-xl border border-white/20 bg-slate-800 shadow-xl sm:bottom-3 sm:right-3 sm:top-auto">
          <video 
            ref={localVideoRef} 
            autoPlay 
            playsInline 
            muted 
            className="h-full w-full object-cover" 
          />
          <span className="absolute bottom-1 left-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">You</span>
        </div>

        {/* Mobile floating swipe instruction banner */}
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10 sm:hidden text-center pointer-events-none">
          <p className="text-xs text-white/50 bg-black/30 px-3 py-1 rounded-full backdrop-blur-sm">👉 Swipe right to skip</p>
        </div>
      </div>

      {/* Floating UI Floating Controls Layer */}
      <div className="absolute bottom-6 left-0 right-0 z-20 flex items-center justify-center gap-3 pt-1 px-4 sm:relative sm:bottom-0 sm:bg-transparent sm:px-0">
        <button
          onClick={onStop}
          className="inline-flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md text-white transition active:scale-95 sm:hidden"
          title="Leave match"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>

        <ControlButton onClick={onToggleCam} active={camOn} label={camOn ? 'Camera on' : 'Camera off'}>
          {camOn ? <Camera className="h-5 w-5" /> : <CameraOff className="h-5 w-5" />}
        </ControlButton>
        
        <ControlButton onClick={onToggleMic} active={micOn} label={micOn ? 'Mic on' : 'Mic off'}>
          <MicIcon on={micOn} />
        </ControlButton>

        <button
          onClick={onNext}
          className="inline-flex h-14 items-center gap-2 rounded-2xl bg-gradient-to-r from-accent to-accent-2 px-7 text-sm font-semibold text-white shadow-lg shadow-accent/20 transition hover:scale-105 active:scale-95"
        >
          <Shuffle className="h-5 w-5" /> Next
        </button>
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
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl border transition active:scale-95 ${
        active
          ? 'border-white/10 bg-black/40 backdrop-blur-md text-white sm:border-line sm:bg-bg-elev sm:text-ink'
          : 'border-rose-500/40 bg-rose-500/20 text-rose-300 backdrop-blur-md sm:bg-rose-500/10 sm:text-rose-500 dark:text-rose-300'
      }`}
    >
      {children}
    </button>
  );
}

function MicIcon({ on }: { on: boolean }) {
  return on ? <MicOnIcon /> : <MicOffIcon />;
}
function MicOnIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  );
}
function MicOffIcon() {
  return (
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
  elapsed
}: { 
  conn: ConnectionRow; 
  myId: string; 
  onNext: () => void; 
  partnerProfile: any;
  onStop: () => void;
  elapsed: number;
}) {
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Robust changes subscription to ensure flawless live texting sync
  useEffect(() => {
    let active = true;
    
    // Initial fetch
    supabase
      .from('messages')
      .select('*')
      .eq('connection_id', conn.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (active && data) setMessages(data as MessageRow[]);
      });

    // Explicitly target channel filter string format for precision
    const channel = supabase
      .channel(`chat-room-${conn.id}`)
      .on(
        'postgres_changes',
        { 
          event: 'INSERT', 
          schema: 'public', 
          table: 'messages',
          filter: `connection_id=eq.${conn.id}`
        },
        (payload) => {
          if (!active) return;
          const newMsg = payload.new as MessageRow;
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            return [...prev, newMsg];
          });
        }
      )
      .subscribe();

    return () => {
      active = false;
      channel.unsubscribe();
    };
  }, [conn.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

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
      console.error(error);
    }
  };

  const handleAttachmentPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setUploading(true);
      try {
        const fileExt = file.name.split('.').pop();
        const path = `${conn.id}/${Date.now()}-${Math.random()}.${fileExt}`;
        
        const { error: uploadError } = await supabase.storage
          .from('attachments')
          .upload(path, file);

        if (uploadError) throw uploadError;

        const { data } = supabase.storage.from('attachments').getPublicUrl(path);
        if (data?.publicUrl) {
          await send(data.publicUrl);
        }
      } catch (err) {
        console.error('Attachment transmission failure:', err);
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
    <div className="flex h-screen sm:h-[68vh] flex-col overflow-hidden sm:rounded-2xl border-0 sm:border border-line bg-bg sm:bg-bg-elev shadow-2xl w-full">
      {/* Mobile top status banner */}
      <div className="flex sm:hidden items-center justify-between p-4 border-b border-line bg-bg-elev">
        <div className="flex items-center gap-3">
          {partnerProfile?.avatar_url ? (
            <img src={partnerProfile.avatar_url} alt="Partner" className="h-8 w-8 rounded-full object-cover" />
          ) : (
            <div className="h-8 w-8 rounded-full bg-accent/10 text-accent flex items-center justify-center">
              <User className="h-4 w-4" />
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-ink">{partnerProfile?.display_name || 'Stranger'}</span>
            <span className="text-[10px] text-ink-muted">Texting · {formatTime(elapsed)}</span>
          </div>
        </div>
        <button onClick={onStop} className="text-xs font-medium text-rose-500 bg-rose-500/10 px-3 py-1.5 rounded-xl">Leave</button>
      </div>

      {/* Messages Stream Segment */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4 bg-bg sm:bg-transparent">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center text-ink-faint">
            <MessageSquare className="h-8 w-8" />
            <p className="mt-2 text-sm">Say hi to {partnerProfile?.display_name || 'stranger'}!</p>
          </div>
        )}
        {messages.map((m) => {
          const mine = m.sender_id === myId;
          const text = m.body;
          const isLink = text.startsWith('http://') || text.startsWith('https://');

          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[78%] rounded-2xl px-4 py-2 text-sm ${
                  mine
                    ? 'rounded-br-sm bg-gradient-to-br from-accent to-accent-2 text-white shadow-md shadow-accent/10'
                    : 'rounded-bl-sm bg-bg-muted text-ink border border-line'
                }`}
              >
                {isLink ? (
                  isImageUrl(text) ? (
                    <div className="py-1">
                      <img src={text} alt="Shared preview" className="rounded-lg max-h-48 object-contain bg-black/5" />
                      <a href={text} target="_blank" rel="noreferrer" className="block text-[11px] underline mt-1 text-center opacity-80">Open Full Size</a>
                    </div>
                  ) : (
                    <a href={text} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 underline break-all font-medium">
                      <Download className="h-4 w-4 shrink-0" />
                      Download Attachment File
                    </a>
                  )
                ) : (
                  <p className="break-words whitespace-pre-wrap">{text}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Controller Console Tray with overflow guards */}
      <div className="border-t border-line p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-bg-elev w-full box-border">
        <div className="flex items-center gap-2 w-full max-w-full">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleAttachmentPick}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || sending}
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-line bg-bg text-ink-muted transition hover:text-ink active:scale-95 disabled:opacity-40"
            aria-label="Upload attachment"
          >
            {uploading ? <Loader2 className="h-5 w-5 animate-spin text-accent" /> : <Paperclip className="h-5 w-5" />}
          </button>

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Type a message…"
            className="flex-1 min-w-0 rounded-xl border border-line bg-bg px-4 py-3 text-ink placeholder-ink-faint focus:border-accent/50 focus:outline-none focus:ring-1 focus:ring-accent/50"
          />
          <button
            onClick={() => send()}
            disabled={sending || !input.trim()}
            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-r from-accent to-accent-2 text-white transition hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100"
            aria-label="Send"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
        <button
          onClick={onNext}
          className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-bg py-2.5 text-sm font-medium text-ink-muted transition hover:text-ink active:scale-[0.99]"
        >
          <Shuffle className="h-4 w-4" /> Next stranger
        </button>
      </div>
    </div>
  );
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}