import type { ConnectionRow } from './supabase';
import { supabase } from './supabase';

// Reduced STUN footprint and prepared TURN entry array to satisfy strict browser NAT traversal requirements
const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  // OPTIONAL: Add your free TURN credentials here if mobile carrier firewalls continue to block connections:
  // {
  //   urls: 'turn:your-turn-server.com:3478',
  //   username: 'your_username',
  //   credential: 'your_password'
  // }
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

  constructor(conn: ConnectionRow, myId: string, events: PeerEvents) {
    this.conn = conn;
    this.myId = myId;
    this.isInitiator = conn.initiator_id === myId;
    this.events = events;
    
    console.log(`[WEBRTC DIAGNOSTIC] Spawning connection wrapper. Role: ${this.isInitiator ? 'Initiator' : 'Responder'}`);
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onconnectionstatechange = () => {
      if (this.closed) return;
      const state = this.pc.connectionState;
      console.log(`[WEBRTC DIAGNOSTIC] Connection status shifted to: ${state}`);
      
      if (state === 'connected') this.events.onConnected?.();
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.events.onDisconnected?.();
      }
    };

    this.pc.ontrack = (e) => {
      if (this.closed) return;
      console.log('[WEBRTC DIAGNOSTIC] Remote media stream tracks captured successfully.');
      this.events.onRemoteStream?.(e.streams[0]);
    };

    this.pc.onicecandidate = (e) => {
      if (this.closed) return;
      if (e.candidate) {
        this.sendIceCandidate(e.candidate.toJSON()).catch((err) =>
          console.error('[WEBRTC DIAGNOSTIC] Signaling ice exchange error:', err)
        );
      }
    };
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

  private async subscribeToConnection() {
    if (this.subscribed) return;
    this.subscribed = true;
    
    supabase
      .channel(`conn-${this.conn.id}`)
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

          if (this.isInitiator && row.sdp_answer && !this.pc.currentRemoteDescription) {
            try {
              await this.pc.setRemoteDescription(new RTCSessionDescription(row.sdp_answer));
              for (const c of row.ice_candidates_responder ?? []) {
                try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
              }
            } catch (err: any) {
              this.events.onError?.(new Error('Remote desc assignment failed: ' + err.message));
            }
          }
          
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
    arr.push(candidate);
    
    await supabase
      .from('connections')
      .update({ [field]: arr })
      .eq('id', this.conn.id);
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
    try { await supabase.channel(`conn-${this.conn.id}`).unsubscribe(); } catch {}
  }
}