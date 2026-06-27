import type { ConnectionRow } from './supabase';
import { supabase } from './supabase';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' }
];

export type PeerEvents = {
  onRemoteStream?: (stream: MediaStream) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
};

export class PeerConnection {
  pc: RTCPeerConnection;
  conn: ConnectionRow;
  myId: string;
  isInitiator: boolean;
  events: PeerEvents;
  localStream: MediaStream | null = null;
  private subscribed = false;
  private closed = false;
  private pendingIce: any[] = [];
  private channel: ReturnType<typeof supabase.channel> | null = null;

  constructor(conn: ConnectionRow, myId: string, events: PeerEvents) {
    this.conn = conn;
    this.myId = myId;
    this.isInitiator = conn.initiator_id === myId;
    this.events = events;

    this.pc = this.createPeer();
  }

  private createPeer(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = pc.connectionState;

      if (state === 'connected') this.events.onConnected?.();
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.events.onDisconnected?.();
      }
    };

    pc.ontrack = (e) => {
      if (this.closed) return;
      this.events.onRemoteStream?.(e.streams[0]);
    };

    pc.onicecandidate = (e) => {
      if (this.closed) return;
      if (e.candidate) {
        this.sendIceCandidate(e.candidate.toJSON()).catch((err) =>
          console.error('[WEBRTC] ICE exchange error:', err)
        );
      }
    };

    return pc;
  }

  async attachLocalStream(stream: MediaStream | null) {
    this.localStream = stream;
    if (stream) {
      for (const track of stream.getTracks()) {
        this.pc.addTrack(track, stream);
      }
    }
  }

  async createOffer() {
    if (!this.isInitiator) throw new Error('Only initiator creates offer');
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await this.pc.setLocalDescription(offer);
    
    const { error } = await supabase
      .from('connections')
      .update({ sdp_offer: offer })
      .eq('id', this.conn.id);
      
    if (error) throw new Error('Failed to write offer: ' + error.message);
    await this.subscribeToConnection();
  }

  async acceptOffer() {
    if (this.isInitiator) throw new Error('Only responder accepts offer');
    const { data, error } = await supabase
      .from('connections')
      .select('sdp_offer, ice_candidates_initiator')
      .eq('id', this.conn.id)
      .maybeSingle();
      
    if (error) throw new Error('Failed to load offer: ' + error.message);
    if (!data?.sdp_offer) throw new Error('No offer available yet');

    await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp_offer));
    
    for (const c of data.ice_candidates_initiator ?? []) {
      try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    
    const { error: e2 } = await supabase
      .from('connections')
      .update({ sdp_answer: answer, status: 'connected' })
      .eq('id', this.conn.id);
      
    if (e2) throw new Error('Failed to write answer: ' + e2.message);
    await this.subscribeToConnection();
  }

  /**
   * Re-establishes the WebRTC handshake on an EXISTING connection row after
   * a page refresh/reload wiped out the previous RTCPeerConnection. Both
   * sides keep their original initiator/responder role; we just create a
   * fresh RTCPeerConnection, clear the stale signaling data, and redo the
   * offer/answer + ICE dance over the same connection_id. Call this instead
   * of createOffer/acceptOffer when rejoining a connection that was already
   * 'connected' before the reload.
   */
  async renegotiate() {
    this.closed = false;
    this.pendingIce = [];
    this.subscribed = false;
    // Tear down any previous peer object's listeners (it may already be
    // dead after a reload, but guard against double-construction anyway).
    try {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.close();
    } catch {}
    this.pc = this.createPeer();

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }
    }

    if (this.isInitiator) {
      // Clear stale signaling so the responder doesn't try to answer an
      // old offer, then write a fresh one.
      await supabase
        .from('connections')
        .update({
          sdp_offer: null,
          sdp_answer: null,
          ice_candidates_initiator: [],
          ice_candidates_responder: [],
        })
        .eq('id', this.conn.id);
      await this.createOffer();
    } else {
      // Wait for the initiator to publish a fresh offer, then accept it.
      // Poll briefly since the initiator's renegotiate() may not have
      // written the new offer yet (both sides reload independently).
      const offer = await this.waitForFreshOffer();
      if (!offer) throw new Error('Timed out waiting for partner to reconnect');
      await this.acceptOffer();
    }
  }

  private async waitForFreshOffer(maxWaitMs = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const { data } = await supabase
        .from('connections')
        .select('sdp_offer')
        .eq('id', this.conn.id)
        .maybeSingle();
      if (data?.sdp_offer) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async subscribeToConnection() {
    if (this.subscribed) return;
    this.subscribed = true;

    const channelName = `conn-${this.conn.id}`;
    const channel = supabase.channel(channelName);
    this.channel = channel;

    channel
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'connections', filter: `id=eq.${this.conn.id}` },
        async (payload) => {
          if (this.closed) return;
          const row = payload.new as ConnectionRow;
          
          if (row.status === 'ended') {
            this.events.onDisconnected?.();
            return;
          }

          if (this.isInitiator && row.sdp_answer && this.pc.signalingState === 'have-local-offer') {
            try {
              await this.pc.setRemoteDescription(new RTCSessionDescription(row.sdp_answer));
              for (const c of row.ice_candidates_responder ?? []) {
                try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
              }
            } catch (err: any) {
              console.warn('[WEBRTC] Handled secondary description attempt:', err.message);
            }
          }
          
          if (this.pc.remoteDescription) {
            const theirIce = this.isInitiator
              ? (row.ice_candidates_responder ?? [])
              : (row.ice_candidates_initiator ?? []);
              
            for (const c of theirIce) {
              if (!this.pendingIce.find((x) => x.candidate === c.candidate)) {
                this.pendingIce.push(c);
                try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
              }
            }
          }
        }
      )
      .subscribe();
  }

  private async sendIceCandidate(candidate: any) {
    const field = this.isInitiator ? 'ice_candidates_initiator' : 'ice_candidates_responder';
    const { data, error } = await supabase
      .from('connections')
      .select(field)
      .eq('id', this.conn.id)
      .maybeSingle();
      
    if (error) throw error;
    const arr = ((data as Record<string, any> | null)?.[field] as any[]) ?? [];
    
    if (arr.some((x) => x.candidate === candidate.candidate)) return;
    arr.push(candidate);
    
    await supabase
      .from('connections')
      .update({ [field]: arr })
      .eq('id', this.conn.id);
  }

  /**
   * Closes the peer locally WITHOUT marking the connection as 'ended' in the
   * DB. Use this when the page is being torn down for a refresh/rejoin
   * (e.g. via renegotiate() right after), so the partner is NOT booted out
   * of the room while we're just reconnecting.
   */
  async closeLocalOnly() {
    if (this.closed) return;
    this.closed = true;
    this.pc.onconnectionstatechange = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    try {
      this.pc.getSenders().forEach((s) => { if (s.track) s.track.stop(); });
    } catch {}
    try { this.pc.close(); } catch {}
    if (this.channel) {
      try { await supabase.removeChannel(this.channel); } catch {}
      this.channel = null;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    this.pc.onconnectionstatechange = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;

    try {
      this.pc.getSenders().forEach((s) => {
        if (s.track) s.track.stop();
      });
    } catch {}

    try { this.pc.close(); } catch {}
    try {
      await supabase
        .from('connections')
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', this.conn.id);
    } catch {}

    if (this.channel) {
      try { await supabase.removeChannel(this.channel); } catch {}
      this.channel = null;
    }
  }
}
