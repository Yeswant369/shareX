import { getICEConfig } from './ice-config.js';

export class WebRTCManager {
    constructor(signaling) {
        this.signaling = signaling;
        this.connections = new Map();
        this.currentRoomId = null;
        this.currentState = 'closed';
        this.hostId = null;
        this.isHost = false;
        this._onMessage = null;
        this._onDataChannel = null;
        this._onStateChange = null;

        this._bindSignaling();
    }

    onMessage(callback) { this._onMessage = callback; }
    onDataChannel(callback) { this._onDataChannel = callback; }
    onStateChange(callback) { this._onStateChange = callback; }

    offStateChange(callback) {
        if (this._onStateChange === callback) this._onStateChange = null;
    }

    async createConnection(peerId, fileMeta = null) {
        if (!this.isHost || this.currentState !== 'ready' || !this.currentRoomId) {
            console.warn('[WebRTC] createConnection blocked: host/ready/room preconditions failed');
            return null;
        }

        if (this.connections.has(peerId)) {
            const existing = this.connections.get(peerId);
            if (existing?.dc?.readyState === 'open') return existing;
        }

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);
        const dc = pc.createDataChannel('sharex-transfer', { ordered: true });

        this._setupPeerConnection(pc, peerId);
        this._setupDataChannel(dc, peerId);
        this.connections.set(peerId, { pc, dc, state: 'connecting' });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this.signaling.send('offer', {
            target: peerId,
            room_id: this.currentRoomId,
            sdp: pc.localDescription,
            file_meta: fileMeta,
        });

        return { pc, dc };
    }

    async handleOffer(sdp, senderId, roomId) {
        if (this.isHost || !this.currentRoomId || roomId !== this.currentRoomId) return;

        const config = await getICEConfig();
        const pc = new RTCPeerConnection(config);
        this._setupPeerConnection(pc, senderId);

        pc.ondatachannel = (event) => {
            const dc = event.channel;
            this._setupDataChannel(dc, senderId);
            const conn = this.connections.get(senderId) || { pc, dc: null, state: 'connecting' };
            conn.dc = dc;
            this.connections.set(senderId, conn);
            if (this._onDataChannel) this._onDataChannel(senderId, dc);
        };

        this.connections.set(senderId, { pc, dc: null, state: 'connecting' });

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.signaling.send('answer', {
            target: senderId,
            room_id: this.currentRoomId,
            sdp: pc.localDescription,
        });
    }

    getDataChannel(peerId) {
        return this.connections.get(peerId)?.dc || null;
    }

    close(peerId) {
        const conn = this.connections.get(peerId);
        if (!conn) return;
        try { conn.dc?.close(); } catch (_) { }
        try { conn.pc?.close(); } catch (_) { }
        this.connections.delete(peerId);
    }

    closeAll() {
        Array.from(this.connections.keys()).forEach((peerId) => this.close(peerId));
    }

    _bindSignaling() {
        this.signaling.on('connected', () => {
            this.isHost = false;
            this.currentRoomId = null;
            this.currentState = 'closed';
            this.hostId = null;
        });

        this.signaling.on('room-created', (data) => {
            this.currentRoomId = data.room_id;
            this.hostId = data.host_id;
            this.isHost = true;
            this.currentState = 'waiting';
            this.closeAll();
        });

        this.signaling.on('room-joined', (data) => {
            this.currentRoomId = data.room_id;
            this.hostId = data.host_id;
            this.isHost = this.signaling.id === data.host_id;
            this.currentState = (data.peers || []).length >= 2 ? 'ready' : 'waiting';
            this.closeAll();
        });

        this.signaling.on('room-state-update', (data) => {
            if (data.room_id !== this.currentRoomId) return;
            this.currentState = data.state;
            this.hostId = data.host_id;
            this.isHost = this.signaling.id === data.host_id;
            if (data.state !== 'ready') this.closeAll();
        });

        this.signaling.on('offer', async (data) => {
            await this.handleOffer(data.sdp, data.sender, data.room_id);
        });

        this.signaling.on('answer', async (data) => {
            const conn = this.connections.get(data.sender);
            if (!conn?.pc) return;
            await conn.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        });

        this.signaling.on('ice-candidate', async (data) => {
            const conn = this.connections.get(data.sender);
            if (!conn?.pc || !data.candidate) return;
            try {
                await conn.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (error) {
                console.warn('[WebRTC] ICE add failed', error);
            }
        });

        this.signaling.on('disconnected', () => {
            this.closeAll();
            this.currentRoomId = null;
            this.currentState = 'closed';
            this.isHost = false;
            this.hostId = null;
        });
    }

    _setupPeerConnection(pc, peerId) {
        pc.onicecandidate = (event) => {
            if (!event.candidate || !this.currentRoomId) return;
            this.signaling.send('ice-candidate', {
                target: peerId,
                room_id: this.currentRoomId,
                candidate: event.candidate,
            });
        };

        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            const conn = this.connections.get(peerId);
            if (conn) conn.state = state;
            if (this._onStateChange) this._onStateChange(peerId, state);
            if (state === 'failed' || state === 'closed') this.close(peerId);
        };
    }

    _setupDataChannel(dc, peerId) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = () => {
            const conn = this.connections.get(peerId);
            if (conn) conn.state = 'connected';
            if (this._onStateChange) this._onStateChange(peerId, 'connected');
            if (this._onDataChannel) this._onDataChannel(peerId, dc);
        };

        dc.onmessage = (event) => {
            if (this._onMessage) this._onMessage(peerId, event.data);
        };
    }
}
