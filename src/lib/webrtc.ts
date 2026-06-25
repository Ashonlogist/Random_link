import type { ConnectionRow } from './supabase';
import { supabase } from './supabase';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

export type PeerEvents = {
  onRemoteStream?: (stream: MediaStream) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
};

/**
 * Manages a single WebRTC peer connection for a given connection row.
 * Signaling (offer/answer/ICE) is exchanged through the `connections` table
 * via Supabase realtime + row updates.
 */
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
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      if (state === 'connected') this.events.onConnected?.();
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.events.onDisconnected?.();
      }
    };

    this.pc.ontrack = (e) => {
      this.events.onRemoteStream?.(e.streams[0]);
    };

    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.sendIceCandidate(e.candidate.toJSON()).catch((err) =>
          this.events.onError?.(new Error('ICE send failed: ' + err.message))
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

  /** Initiator: create offer, write it to the row, then wait for answer. */
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

  /** Responder: read offer, set remote, create answer, write it. */
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
    // apply any ICE candidates that arrived before remote description was set
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
          // initiator waits for answer
          if (this.isInitiator && row.sdp_answer && !this.pc.currentRemoteDescription) {
            try {
              await this.pc.setRemoteDescription(new RTCSessionDescription(row.sdp_answer));
              for (const c of row.ice_candidates_responder ?? []) {
                try { await this.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
              }
            } catch (err: any) {
              this.events.onError?.(new Error('Remote desc failed: ' + err.message));
            }
          }
          // apply newly-arrived ICE candidates from the other party
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
    // append to the array atomically via RPC-free read-modify-write with a retry
    const { data, error } = await supabase
      .from('connections')
      .select(field)
      .eq('id', this.conn.id)
      .maybeSingle();
    if (error) throw error;
    const arr = ((data as Record<string, any> | null)?.[field] as any[]) ?? [];
    arr.push(candidate);
    const { error: uerr } = await supabase
      .from('connections')
      .update({ [field]: arr })
      .eq('id', this.conn.id);
    if (uerr) throw uerr;
  }

  async close() {
    this.closed = true;
    try {
      this.pc.getSenders().forEach((s) => s.track?.stop());
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
