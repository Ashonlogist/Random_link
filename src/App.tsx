import { useState, useEffect, useRef } from 'react';
import { useSession } from './lib/useSession';
import { useTheme } from './lib/useTheme';
import { AuthScreen } from './components/AuthScreen';
import { Onboarding } from './components/Onboarding';
import { LiveChatStats } from './components/LiveChatStats';
import { findMatch, leaveWaitingRoom, subscribeToIncomingMatches, recordAffinity } from './lib/matching';
import { PeerConnection } from './lib/webrtc';
import { supabase, type ChatMode, type ConnectionRow, type MessageRow } from './lib/supabase';
import { 
  Sparkles, 
  Video, 
  MessageSquare, 
  LogOut, 
  Loader2, 
  Send, 
  XCircle, 
  User, 
  VideoOff
} from 'lucide-react';

type AppState = 'idle' | 'searching' | 'connected';

export default function App() {
  const { session, loading: sessionLoading, refreshProfile, signOut } = useSession();
  const { theme, toggle: toggleTheme } = useTheme();
  
  const [appState, setAppState] = useState<AppState>('idle');
  const [activeMode, setActiveMode] = useState<ChatMode>('text');
  const [currentConnection, setCurrentConnection] = useState<ConnectionRow | null>(null);
  
  // Text Chat Room States
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [textInput, setTextInput] = useState('');
  
  // Video Calling States & Streams
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const peerRef = useRef<PeerConnection | null>(null);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const searchStartTimeRef = useRef<number>(0);

  const myId = session.user?.id;

  // 1. Core Cleanup Routine when canceling or leaving
  const resetChatState = async () => {
    if (myId) {
      await leaveWaitingRoom(myId);
    }
    if (peerRef.current) {
      await peerRef.current.close();
      peerRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      setLocalStream(null);
    }
    
    setRemoteStream(null);
    setCurrentConnection(null);
    setMessages([]);
    setTextInput('');
    setAppState('idle');
  };

  // 2. Trigger Matching Logic
  const handleStartSearch = async (mode: ChatMode) => {
    if (!myId) return;
    setActiveMode(mode);
    setAppState('searching');
    searchStartTimeRef.current = Date.now();

    try {
      // If video mode, capture user camera/microphone permissions early
      if (mode === 'video') {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      }

      // Query affinity backend matcher for available queue slots
      const matchResult = await findMatch(myId, mode);
      
      if (matchResult) {
        // We found an available partner and initiated the connection handshake
        const { conn } = matchResult;
        setCurrentConnection(conn);
        setAppState('connected');
        
        peerRef.current = new PeerConnection(conn, myId, {
          onRemoteStream: (stream) => setRemoteStream(stream),
          onDisconnected: () => resetChatState(),
        });

        if (mode === 'video') {
          await peerRef.current.attachLocalStream(localStream);
        }
        await peerRef.current.createOffer();
      }
    } catch (err) {
      console.error('Handshake entry failure:', err);
      resetChatState();
    }
  };

  // 3. Listen for Incoming Match Allocations while Waiting
  useEffect(() => {
    if (appState !== 'searching' || !myId) return;

    const unsubscribe = subscribeToIncomingMatches(myId, async (conn) => {
      try {
        setCurrentConnection(conn);
        setAppState('connected');

        peerRef.current = new PeerConnection(conn, myId, {
          onRemoteStream: (stream) => setRemoteStream(stream),
          onDisconnected: () => resetChatState(),
        });

        if (activeMode === 'video') {
          // Re-verify stream is bound to state container
          let stream = localStream;
          if (!stream) {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            setLocalStream(stream);
          }
          await peerRef.current.attachLocalStream(stream);
        }

        await peerRef.current.acceptOffer();
      } catch (err) {
        console.error('Failed to answer peer negotiation handshakes:', err);
        resetChatState();
      }
    });

    return () => {
      unsubscribe();
    };
  }, [appState, myId, activeMode, localStream]);

  // 4. Handle Subscriptions for Messages & Remote Terminations
  useEffect(() => {
    if (!currentConnection || appState !== 'connected') return;

    // Fetch message log base history
    supabase
      .from('messages')
      .select('*')
      .eq('connection_id', currentConnection.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (data) setMessages(data as MessageRow[]);
      });

    // Handle incoming text message stream insertions
    const msgChannel = supabase
      .channel(`chat-msg-${currentConnection.id}`)
      .on('postgres_changes', { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'messages', 
        filter: `connection_id=eq.${currentConnection.id}` 
      }, (payload) => {
        setMessages((prev) => [...prev, payload.new as MessageRow]);
      })
      .subscribe();

    // Monitor session lifecycle status closures asynchronously
    const liveConnChannel = supabase
      .channel(`chat-lifecycle-${currentConnection.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'connections',
        filter: `id=eq.${currentConnection.id}`
      }, (payload) => {
        const updated = payload.new as ConnectionRow;
        if (updated.status === 'ended') {
          // Record match affinity feedback duration before resetting layout views
          const sessionDur = (Date.now() - searchStartTimeRef.current) / 1000;
          if (myId && updated.initiator_id) {
            const partnerId = updated.initiator_id === myId ? updated.responder_id : updated.initiator_id;
            recordAffinity(myId, partnerId, updated.id, sessionDur).catch(() => null);
          }
          resetChatState();
        }
      })
      .subscribe();

    return () => {
      supabase.removeChannel(msgChannel);
      supabase.removeChannel(liveConnChannel);
    };
  }, [currentConnection, appState]);

  // Auto-scroll chat boxes on message logs addition
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Wire video tag objects contextually to structural stream adjustments
  useEffect(() => {
    if (localVideoRef.current && localStream) localVideoRef.current.srcObject = localStream;
  }, [localStream, appState]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) remoteVideoRef.current.srcObject = remoteStream;
  }, [remoteStream, appState]);

  // Send textual interface string payloads
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim() || !currentConnection || !myId) return;

    const body = textInput.trim();
    setTextInput('');

    await supabase.from('messages').insert({
      connection_id: currentConnection.id,
      sender_id: myId,
      body,
    });
  };

  // Base Layout Router Checks
  if (sessionLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-ink">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    );
  }

  if (!session.user) {
    return <AuthScreen theme={theme} onToggleTheme={toggleTheme} />;
  }

  if (!session.profile) {
    return <Onboarding userId={session.user.id} onDone={refreshProfile} theme={theme} onToggleTheme={toggleTheme} />;
  }

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col transition-colors duration-200">
      
      {/* GLOBAL NAVBAR PANEL */}
      <header className="border-b border-line bg-bg-elev px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="font-bold tracking-tight text-md">RandomLink</span>
        </div>

        <div className="flex items-center gap-4">
          <div className="hidden sm:flex items-center gap-2 text-xs text-ink-muted">
            <User className="h-3.5 w-3.5 text-accent" />
            <span>Hey, <strong className="text-ink">{session.profile.display_name}</strong></span>
          </div>
          <button
            onClick={signOut}
            className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-line bg-bg px-3 text-xs font-medium text-ink-muted transition hover:text-rose-500"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="hidden xs:inline">Sign Out</span>
          </button>
        </div>
      </header>

      {/* CORE WORKSPACE APPLICATION WINDOWS */}
      <main className="flex-1 flex flex-col max-w-5xl w-full mx-auto p-4 justify-center">

        {/* STATE A: LANDING MENU SELECTION HUB */}
        {appState === 'idle' && (
          <div className="w-full max-w-md mx-auto text-center space-y-6 py-8">
            <div>
              <h2 className="text-2xl font-bold text-ink">Find a Match</h2>
              <p className="text-sm text-ink-muted mt-1">Connect instantly with peers across institutions.</p>
            </div>

            {/* LIVE SYSTEM STATS COUNTERS PANEL */}
            <LiveChatStats />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <button
                onClick={() => handleStartSearch('video')}
                className="group flex flex-col items-center gap-3 rounded-2xl border border-line bg-bg-elev p-6 shadow-md transition hover:border-accent/50 hover:scale-[1.01] active:scale-[0.99]"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent group-hover:bg-accent group-hover:text-white transition-colors">
                  <Video className="h-6 w-6" />
                </div>
                <div className="text-center">
                  <span className="font-bold text-sm block text-ink">Video Match</span>
                  <span className="text-xs text-ink-faint mt-0.5 block">Camera + Microphones</span>
                </div>
              </button>

              <button
                onClick={() => handleStartSearch('text')}
                className="group flex flex-col items-center gap-3 rounded-2xl border border-line bg-bg-elev p-6 shadow-md transition hover:border-accent/50 hover:scale-[1.01] active:scale-[0.99]"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent group-hover:bg-accent group-hover:text-white transition-colors">
                  <MessageSquare className="h-6 w-6" />
                </div>
                <div className="text-center">
                  <span className="font-bold text-sm block text-ink">Text Match</span>
                  <span className="text-xs text-ink-faint mt-0.5 block">Instant text messages</span>
                </div>
              </button>
            </div>
          </div>
        )}

        {/* STATE B: QUEUE ROOM PROGRESS SPINNING DISPLAY */}
        {appState === 'searching' && (
          <div className="w-full max-w-sm mx-auto text-center py-12 space-y-6 bg-bg-elev border border-line rounded-2xl p-8 shadow-xl">
            <div className="relative mx-auto h-16 w-16">
              <div className="absolute inset-0 rounded-full border-4 border-accent/20"></div>
              <div className="absolute inset-0 rounded-full border-4 border-accent border-t-transparent animate-spin"></div>
              <Sparkles className="absolute left-1/2 top-1/2 h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-accent animate-pulse" />
            </div>

            <div>
              <h3 className="text-xl font-bold text-ink">Looking for a partner...</h3>
              <p className="text-sm text-ink-muted mt-1">Sorting your affinity choices for matching clusters.</p>
            </div>

            {/* LIVE INDIVIDUAL CONTEXT ACTIVE COUNTER STRINGS */}
            <LiveChatStats currentMode={activeMode} />

            <button
              onClick={resetChatState}
              className="w-full py-3 rounded-xl border border-line bg-bg text-sm font-semibold text-ink-muted hover:text-ink hover:bg-bg-muted transition"
            >
              Cancel Search
            </button>
          </div>
        )}

        {/* STATE C: LIVE SESSION CHAT ENGAGEMENTS PANEL */}
        {appState === 'connected' && currentConnection && (
          <div className="flex-1 w-full bg-bg-elev border border-line rounded-2xl shadow-xl flex flex-col overflow-hidden min-h-[500px] max-h-[700px]">
            
            {/* SESSION CONTROL HEADER HEADER BAR */}
            <div className="px-4 py-3 border-b border-line bg-bg-muted/30 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="text-sm font-semibold">Active Session ({activeMode === 'video' ? 'Video' : 'Text'})</span>
              </div>
              <button
                onClick={resetChatState}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-200 text-xs font-semibold hover:bg-rose-500 hover:text-white transition"
              >
                <XCircle className="h-3.5 w-3.5" />
                Leave Room
              </button>
            </div>

            {/* LOWER CONTENT ROW SLOTS FRAME */}
            <div className="flex-1 flex flex-col sm:flex-row overflow-hidden relative">
              
              {/* VIDEO MODE MEDIA RENDERS */}
              {activeMode === 'video' && (
                <div className="flex-1 bg-black grid grid-cols-1 sm:grid-cols-2 p-2 gap-2 relative min-h-[260px] sm:min-h-0">
                  {/* REMOTE INBOUND PARTER CONTAINER */}
                  <div className="relative bg-neutral-900 rounded-xl overflow-hidden flex items-center justify-center border border-white/5">
                    {remoteStream ? (
                      <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
                    ) : (
                      <div className="text-center text-white/40 space-y-2">
                        <VideoOff className="h-8 w-8 mx-auto animate-pulse" />
                        <p className="text-xs">Negotiating feed handshakes...</p>
                      </div>
                    )}
                    <span className="absolute bottom-3 left-3 px-2 py-1 rounded bg-black/60 text-[10px] uppercase font-bold text-white/80 tracking-wider">Partner</span>
                  </div>

                  {/* USER STREAM SOURCE CONTAINER */}
                  <div className="relative bg-neutral-900 rounded-xl overflow-hidden flex items-center justify-center border border-white/5">
                    <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover scale-x-[-1]" />
                    <span className="absolute bottom-3 left-3 px-2 py-1 rounded bg-black/60 text-[10px] uppercase font-bold text-white/80 tracking-wider">You (Self)</span>
                  </div>
                </div>
              )}

              {/* INTEGRATED PERSISTENT INTERACTIVE CHAT PORT */}
              <div className={`flex flex-col border-t sm:border-t-0 sm:border-l border-line ${activeMode === 'video' ? 'w-full sm:w-80 h-64 sm:h-auto' : 'flex-1'}`}>
                {/* MESSAGES VIEW BOX GRID */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-bg/20">
                  {messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-center text-xs text-ink-faint">
                      Say hello to start the vibe!
                    </div>
                  ) : (
                    messages.map((msg) => {
                      const isMe = msg.sender_id === myId;
                      return (
                        <div key={msg.id} className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}>
                          <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${
                            isMe 
                              ? 'bg-accent text-white rounded-br-none' 
                              : 'bg-bg border border-line text-ink rounded-bl-none'
                          }`}>
                            <p className="break-words leading-relaxed">{msg.body}</p>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* TEXT INPUT FIELD BAR FORM */}
                <form onSubmit={handleSendMessage} className="p-3 border-t border-line bg-bg-elev flex items-center gap-2">
                  <input
                    type="text"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    placeholder="Type a message..."
                    maxLength={1000}
                    className="flex-1 text-sm bg-bg border border-line rounded-xl px-3.5 py-2.5 text-ink placeholder-ink-faint focus:border-accent/40 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!textInput.trim()}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent text-white shadow-md shadow-accent/10 transition hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:hover:scale-100"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </form>

              </div>
            </div>

          </div>
        )}

      </main>
    </div>
  );
}