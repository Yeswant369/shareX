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
        this.isHost = false; // Strict role enforcement

        this._bindSignaling();
    }

    /**
     * Set callback for incoming data channel messages.
     */
    onMessage(callback) {
        this._onMessage = callback;
    }

    /**
     * Set callback for data channel open events.
     */
    onDataChannel(callback) {
        this._onDataChannel = callback;
    }

    /**
     * Set callback for connection state changes.
     */
    onStateChange(callback) {
        this._onStateChange = callback;
    }

    /**
     * Initiate a connection to a peer (caller side).
     * ONLY HOST can create connections.
     */
    async createConnection(peerId, fileMeta = null) {
        if (!this.isHost) {
            console.warn('[WebRTC] Rejected createConnection (Not Host)');
            return null;
        }

        if (this.connections.has(peerId)) {
            console.warn('[WebRTC] Connection already exists:', peerId);
            return null;
        }

        console.log('[WebRTC] Creating connection to:', peerId);

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);

        // Create data channel (Unordered, No Retransmits for speed)
        const dc = pc.createDataChannel('sharex-transfer', {
            ordered: false,
            maxRetransmits: 0
        });

        dc.bufferedAmountLowThreshold = 512 * 1024; // 512KB Buffer Threshold

        this._setupDataChannel(dc, peerId);
        this._setupPeerConnection(pc, peerId);

        this.connections.set(peerId, { pc, dc, state: 'connecting' });

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this.signaling.send('offer', {
            target: peerId,
            sdp: pc.localDescription,
            file_meta: fileMeta
        });

        return { pc, dc };
    }

    /**
     * Handle an incoming offer (callee side).
     */
    async handleOffer(sdp, senderId) {
        console.log('[WebRTC] Handling offer from:', senderId);

        // Avoid duplicate connection handling if already connected
        if (this.connections.has(senderId) && this.connections.get(senderId).state === 'connected') {
            console.warn('[WebRTC] Already connected to:', senderId);
            return;
        }

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);

        this._setupPeerConnection(pc, senderId);

        // Listen for incoming data channel
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
            sdp: pc.localDescription
        });
    }

    /**
     * Send data through the data channel to a peer.
     */
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

    /**
     * Get the data channel for a peer.
     */
    getDataChannel(peerId) {
        const conn = this.connections.get(peerId);
        return conn ? conn.dc : null;
    }

    /**
     * Get connection state.
     */
    getState(peerId) {
        const conn = this.connections.get(peerId);
        return conn ? conn.state : null;
    }

    /**
     * Close a connection.
     */
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

    /**
     * Close all connections.
     */
    closeAll() {
        for (const peerId of this.connections.keys()) {
            this.close(peerId);
        }
    }

    // ─── Private Methods ───

    _bindSignaling() {
        // Strict Role Logic
        this.signaling.on('room-created', () => {
            console.log('[WebRTC] Role: HOST');
            this.isHost = true;
        });

        this.signaling.on('room-joined', () => {
            console.log('[WebRTC] Role: CLIENT');
            this.isHost = false;
        });

        // Auto-connect on peer join (Only Host initiates)
        this.signaling.on('peer-joined', (data) => {
            if (this.isHost) {
                console.log('[WebRTC] Peer joined, initiating connection:', data.id);
                this.createConnection(data.id);
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
