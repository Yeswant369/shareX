/**
 * ShareX — WebRTC Manager
 * Deterministic host/joiner signaling lifecycle.
 */

import { getICEConfig } from './ice-config.js';

export class WebRTCManager {
    constructor(signaling) {
        this.signaling = signaling;
        this.connections = new Map(); // peerId -> { pc, dc, state, initiating, initialized }

        this._messageListeners = [];
        this._dataChannelListeners = [];
        this._stateListeners = [];

        this.roomId = null;
        this.hostId = null;
        this.myId = null;
        this.isHost = false;
        this.isInRoom = false;

        this._bindSignaling();
    }

    setIdentity({ myId, roomId, hostId, isHost, isInRoom }) {
        this.myId = myId ?? this.myId;
        this.roomId = roomId ?? this.roomId;
        this.hostId = hostId ?? this.hostId;
        this.isHost = Boolean(isHost);
        this.isInRoom = Boolean(isInRoom);
    }

    onMessage(callback) {
        this._messageListeners.push(callback);
    }

    onDataChannel(callback) {
        this._dataChannelListeners.push(callback);
    }

    onStateChange(callback) {
        this._stateListeners.push(callback);
    }

    offStateChange(callback) {
        this._stateListeners = this._stateListeners.filter((cb) => cb !== callback);
    }

    _emitState(peerId, state) {
        this._stateListeners.forEach((cb) => cb(peerId, state));
    }

    _emitMessage(peerId, payload) {
        this._messageListeners.forEach((cb) => cb(peerId, payload));
    }

    _emitDataChannel(peerId, dc) {
        this._dataChannelListeners.forEach((cb) => cb(peerId, dc));
    }

    async createConnection(peerId, fileMeta = null) {
        if (!this.isInRoom || !this.roomId) {
            console.warn('[WebRTC] createConnection blocked: not in room');
            return null;
        }
        if (!this.isHost) {
            console.warn('[WebRTC] createConnection blocked: only host can offer');
            return null;
        }

        const existing = this.connections.get(peerId);
        if (existing && existing.initialized) {
            console.warn('[WebRTC] createConnection blocked: already initialized', peerId);
            return existing;
        }

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);
        const dc = pc.createDataChannel('sharex-transfer', {
            ordered: false,
            maxRetransmits: 0,
        });
        dc.bufferedAmountLowThreshold = 512 * 1024;

        this._setupPeerConnection(pc, peerId);
        this._setupDataChannel(dc, peerId);

        const conn = { pc, dc, state: 'connecting', initiating: true, initialized: true };
        this.connections.set(peerId, conn);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this.signaling.send('offer', {
            target: peerId,
            room_id: this.roomId,
            sdp: pc.localDescription,
            file_meta: fileMeta,
        });
        console.log('[WebRTC] offer sent host=', this.myId, 'target=', peerId, 'room=', this.roomId);

        return conn;
    }

    async handleOffer(sdp, senderId, roomId = null) {
        if (!this.isInRoom || !this.roomId) {
            console.warn('[WebRTC] dropping offer: not in room');
            return;
        }
        if (roomId && roomId !== this.roomId) {
            console.warn('[WebRTC] dropping offer: room mismatch expected=', this.roomId, 'got=', roomId);
            return;
        }
        if (this.isHost) {
            console.warn('[WebRTC] dropping offer: host never answers in this architecture');
            return;
        }

        const existing = this.connections.get(senderId);
        if (existing && existing.initialized) {
            console.warn('[WebRTC] dropping offer: connection already initialized', senderId);
            return;
        }

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);
        this._setupPeerConnection(pc, senderId);

        const conn = { pc, dc: null, state: 'connecting', initiating: false, initialized: true };
        this.connections.set(senderId, conn);

        pc.ondatachannel = (event) => {
            const dc = event.channel;
            dc.bufferedAmountLowThreshold = 512 * 1024;
            this._setupDataChannel(dc, senderId);
            const saved = this.connections.get(senderId);
            if (saved) saved.dc = dc;
            this._emitDataChannel(senderId, dc);
        };

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.signaling.send('answer', {
            target: senderId,
            room_id: this.roomId,
            sdp: pc.localDescription,
        });
        console.log('[WebRTC] answer sent joiner=', this.myId, 'target=', senderId, 'room=', this.roomId);
    }

    getDataChannel(peerId) {
        return this.connections.get(peerId)?.dc || null;
    }

    close(peerId) {
        const conn = this.connections.get(peerId);
        if (!conn) return;

        try {
            if (conn.dc) conn.dc.close();
        } catch (_) { }

        try {
            if (conn.pc) conn.pc.close();
        } catch (_) { }

        this.connections.delete(peerId);
        this._emitState(peerId, 'closed');
        console.log('[WebRTC] closed peer=', peerId);
    }

    closeAll() {
        Array.from(this.connections.keys()).forEach((peerId) => this.close(peerId));
    }

    _bindSignaling() {
        this.signaling.on('connected', (data) => {
            this.myId = data.id;
        });

        this.signaling.on('disconnected', () => {
            this.closeAll();
            this.roomId = null;
            this.hostId = null;
            this.isHost = false;
            this.isInRoom = false;
        });

        this.signaling.on('answer', async (data) => {
            const conn = this.connections.get(data.sender);
            if (!conn || !conn.pc) return;

            try {
                await conn.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
                console.log('[WebRTC] answer applied peer=', data.sender);
            } catch (err) {
                console.error('[WebRTC] failed to apply answer', err);
            }
        });

        this.signaling.on('ice-candidate', async (data) => {
            const conn = this.connections.get(data.sender);
            if (!conn || !conn.pc || !data.candidate) return;

            try {
                await conn.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
                console.warn('[WebRTC] addIceCandidate error', err.message);
            }
        });
    }

    _setupPeerConnection(pc, peerId) {
        pc.onicecandidate = (event) => {
            if (!event.candidate) return;
            this.signaling.send('ice-candidate', {
                target: peerId,
                room_id: this.roomId,
                candidate: event.candidate,
            });
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            const conn = this.connections.get(peerId);
            if (conn) conn.state = state;

            console.log('[WebRTC] connection state peer=', peerId, 'state=', state);
            this._emitState(peerId, state);

            if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                this.close(peerId);
            }
        };

        pc.oniceconnectionstatechange = () => {
            console.log('[WebRTC] ice state peer=', peerId, 'state=', pc.iceConnectionState);
        };
    }

    _setupDataChannel(dc, peerId) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            const conn = this.connections.get(peerId);
            if (conn) conn.state = 'connected';
            console.log('[WebRTC] datachannel open peer=', peerId);
            this._emitState(peerId, 'connected');
            this._emitDataChannel(peerId, dc);
        };

        dc.onclose = () => {
            console.log('[WebRTC] datachannel close peer=', peerId);
            this._emitState(peerId, 'closed');
        };

        dc.onerror = (err) => {
            console.error('[WebRTC] datachannel error peer=', peerId, err);
        };

        dc.onmessage = (event) => {
            this._emitMessage(peerId, event.data);
        };
    }
}
