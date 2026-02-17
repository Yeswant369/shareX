/**
 * ShareX — WebRTC Manager
 * Handles peer connections, data channels, and signaling relay.
 * DataChannel only — no media streams.
 */

import { getICEConfig } from './ice-config.js';

export class WebRTCManager {
    constructor(signaling) {
        this.signaling = signaling;
        this.connections = new Map(); // peerId -> { pc, dc, state }
        this._onDataChannel = null;
        this._onMessage = null;
        this._onStateChange = null;
        this.isHost = false;
        this.currentRoomId = null;
        this.roomReady = false;

        this._bindSignaling();
    }

    onMessage(callback) {
        this._onMessage = callback;
    }

    onDataChannel(callback) {
        this._onDataChannel = callback;
    }

    onStateChange(callback) {
        this._onStateChange = callback;
    }


    offStateChange(callback) {
        if (!this._onStateChange) return;
        if (this._onStateChange === callback) {
            this._onStateChange = null;
        }
    }

    async createConnection(peerId, fileMeta = null) {
        if (!this.isHost) {
            console.warn('[WebRTC] Rejected createConnection (not host):', peerId);
            return null;
        }

        if (!this.roomReady || !this.currentRoomId) {
            console.warn('[WebRTC] Rejected createConnection (room not ready):', peerId);
            return null;
        }

        if (this.connections.has(peerId)) {
            const conn = this.connections.get(peerId);
            if (conn && (conn.state === 'connected' || conn.state === 'connecting')) {
                console.warn('[WebRTC] Connection already in progress/existing:', peerId, conn.state);
                return conn;
            }
        }

        console.log('[WebRTC] Creating host connection to:', peerId, 'room:', this.currentRoomId);

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);

        const dc = pc.createDataChannel('sharex-transfer', {
            ordered: false,
            maxRetransmits: 0
        });

        dc.bufferedAmountLowThreshold = 512 * 1024;

        this._setupDataChannel(dc, peerId);
        this._setupPeerConnection(pc, peerId);

        this.connections.set(peerId, { pc, dc, state: 'connecting' });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this.signaling.send('offer', {
            target: peerId,
            room_id: this.currentRoomId,
            sdp: pc.localDescription,
            file_meta: fileMeta
        });

        return { pc, dc };
    }

    async handleOffer(sdp, senderId, roomId = null) {
        console.log('[WebRTC] Handling offer from:', senderId, 'room:', roomId || this.currentRoomId);

        if (this.isHost) {
            console.warn('[WebRTC] Host received offer unexpectedly; ignoring.');
            return;
        }

        if (!this.roomReady || !this.currentRoomId) {
            console.warn('[WebRTC] Offer received before room-joined; ignoring sender:', senderId);
            return;
        }

        if (roomId && roomId !== this.currentRoomId) {
            console.warn('[WebRTC] Offer room mismatch. expected:', this.currentRoomId, 'got:', roomId);
            return;
        }

        if (this.connections.has(senderId)) {
            const existing = this.connections.get(senderId);
            if (existing && (existing.state === 'connected' || existing.state === 'connecting')) {
                console.warn('[WebRTC] Existing connection for offer sender:', senderId, existing.state);
                return;
            }
        }

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);

        this._setupPeerConnection(pc, senderId);

        pc.ondatachannel = (event) => {
            const dc = event.channel;
            dc.bufferedAmountLowThreshold = 512 * 1024;
            this._setupDataChannel(dc, senderId);

            const conn = this.connections.get(senderId);
            if (conn) conn.dc = dc;

            if (this._onDataChannel) {
                this._onDataChannel(senderId, dc);
            }
        };

        this.connections.set(senderId, { pc, dc: null, state: 'connecting' });

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.signaling.send('answer', {
            target: senderId,
            room_id: this.currentRoomId,
            sdp: pc.localDescription
        });
    }

    send(peerId, data) {
        const conn = this.connections.get(peerId);
        if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
            console.warn('[WebRTC] Cannot send, channel not open for:', peerId);
            return false;
        }
        try {
            conn.dc.send(data);
            return true;
        } catch (e) {
            console.error('[WebRTC] Send failed:', e);
            return false;
        }
    }

    getDataChannel(peerId) {
        const conn = this.connections.get(peerId);
        return conn ? conn.dc : null;
    }

    getState(peerId) {
        const conn = this.connections.get(peerId);
        return conn ? conn.state : null;
    }

    close(peerId) {
        const conn = this.connections.get(peerId);
        if (conn) {
            if (conn.dc) {
                try { conn.dc.close(); } catch (e) { }
            }
            if (conn.pc) {
                try { conn.pc.close(); } catch (e) { }
            }
            this.connections.delete(peerId);
            console.log('[WebRTC] Connection closed:', peerId);
        }
    }

    closeAll() {
        for (const peerId of this.connections.keys()) {
            this.close(peerId);
        }
    }

    _bindSignaling() {
        this.signaling.on('room-created', (data) => {
            this.currentRoomId = data.room_id || null;
            this.roomReady = Boolean(this.currentRoomId);
            this.isHost = true;
            this.closeAll();
            console.log('[WebRTC] Role set HOST. room:', this.currentRoomId);
        });

        this.signaling.on('room-joined', (data) => {
            this.currentRoomId = data.room_id || null;
            this.roomReady = Boolean(this.currentRoomId);
            this.isHost = false;
            this.closeAll();
            console.log('[WebRTC] Role set JOINER. room:', this.currentRoomId, 'peers:', (data.peers || []).map(p => p.id));
        });

        this.signaling.on('disconnected', () => {
            this.roomReady = false;
            this.currentRoomId = null;
            this.isHost = false;
            this.closeAll();
            console.warn('[WebRTC] Signaling disconnected. Cleared room/connection state.');
        });

        this.signaling.on('peer-joined', (data) => {
            if (this.isHost && this.roomReady) {
                console.log('[WebRTC] Host observed room peer join:', data.id, 'room:', this.currentRoomId);
            }
        });

        this.signaling.on('answer', async (data) => {
            const conn = this.connections.get(data.sender);
            if (conn && conn.pc) {
                await conn.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                console.log('[WebRTC] Answer set from:', data.sender);
            }
        });

        this.signaling.on('ice-candidate', async (data) => {
            const conn = this.connections.get(data.sender);
            if (conn && conn.pc && data.candidate) {
                try {
                    await conn.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
                } catch (err) {
                    console.warn('[WebRTC] ICE candidate error:', err.message);
                }
            }
        });
    }

    _setupPeerConnection(pc, peerId) {
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.signaling.send('ice-candidate', {
                    target: peerId,
                    room_id: this.currentRoomId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            const conn = this.connections.get(peerId);
            if (conn) conn.state = state;

            console.log(`[WebRTC] Connection state (${peerId}):`, state);

            if (this._onStateChange) {
                this._onStateChange(peerId, state);
            }

            if (state === 'failed' || state === 'closed') {
                this.close(peerId);
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`[WebRTC] ICE state (${peerId}):`, pc.iceConnectionState);
        };
    }

    _setupDataChannel(dc, peerId) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            console.log('[WebRTC] DataChannel open:', peerId);
            const conn = this.connections.get(peerId);
            if (conn) conn.state = 'connected';

            if (this._onStateChange) {
                this._onStateChange(peerId, 'connected');
            }

            if (this._onDataChannel) {
                this._onDataChannel(peerId, dc);
            }
        };

        dc.onclose = () => {
            console.log('[WebRTC] DataChannel closed:', peerId);
        };

        dc.onerror = (err) => {
            console.error('[WebRTC] DataChannel error:', err);
        };

        dc.onmessage = (event) => {
            if (this._onMessage) {
                this._onMessage(peerId, event.data);
            }
        };
    }
}
