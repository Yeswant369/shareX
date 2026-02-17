import { getICEConfig } from './ice-config.js';

export class WebRTCManager {
    constructor(signaling) {
        this.signaling = signaling;
        this.peerConnection = null;
        this.dataChannel = null;
        this.remotePeerId = null;
        this.roomId = null;
        this.isHost = false;
        this.connectionState = 'idle';
        this.hasReceivedOffer = false;

        this._onMessage = null;
        this._onState = null;

        this._bindSignaling();
    }

    setRoomContext({ roomId, isHost, remotePeerId }) {
        this.roomId = roomId;
        this.isHost = isHost;
        this.remotePeerId = remotePeerId || null;
        if (!this.remotePeerId) this.close();
    }

    onMessage(cb) { this._onMessage = cb; }
    onStateChange(cb) { this._onState = cb; }

    isReadyForTransfer() {
        return this.peerConnection?.connectionState === 'connected' && this.dataChannel?.readyState === 'open';
    }

    async ensureHostOffer(fileMeta = null) {
        if (!this.isHost || !this.roomId || !this.remotePeerId) {
            console.warn('[WebRTC] host offer blocked: invalid room context');
            return false;
        }

        if (this.isReadyForTransfer()) return true;
        if (!this.peerConnection) {
            await this._createPeerConnection();
            this.dataChannel = this.peerConnection.createDataChannel('sharex-transfer', { ordered: true });
            this._setupDataChannel(this.dataChannel);
        }

        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        console.log('[WebRTC] sending offer');
        this.signaling.send('offer', {
            room_id: this.roomId,
            target: this.remotePeerId,
            sdp: this.peerConnection.localDescription,
            file_meta: fileMeta,
        });
        return true;
    }

    send(data) {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            throw new Error('Data channel not open');
        }
        this.dataChannel.send(data);
    }

    close() {
        try { this.dataChannel?.close(); } catch (_) {}
        try { this.peerConnection?.close(); } catch (_) {}
        this.dataChannel = null;
        this.peerConnection = null;
        this.hasReceivedOffer = false;
        this._setState('idle');
    }

    async _createPeerConnection() {
        const config = await getICEConfig();
        this.peerConnection = new RTCPeerConnection(config);
        this._setState('connecting');

        this.peerConnection.onicecandidate = (event) => {
            if (!event.candidate || !this.remotePeerId || !this.roomId) return;
            this.signaling.send('ice-candidate', {
                room_id: this.roomId,
                target: this.remotePeerId,
                candidate: event.candidate,
            });
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection?.connectionState || 'closed';
            this._setState(state);
            if (state === 'failed' || state === 'closed' || state === 'disconnected') {
                if (state !== 'connected') this.close();
            }
        };

        this.peerConnection.ondatachannel = (event) => {
            console.log('[WebRTC] received data channel');
            this.dataChannel = event.channel;
            this._setupDataChannel(this.dataChannel);
        };
    }

    _setupDataChannel(dc) {
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => this._setState('connected');
        dc.onclose = () => this._setState('channel-closed');
        dc.onerror = () => this._setState('channel-error');
        dc.onmessage = (event) => {
            if (this._onMessage) this._onMessage(event.data);
        };
    }

    _setState(next) {
        this.connectionState = next;
        if (this._onState) this._onState(next);
    }

    _bindSignaling() {
        this.signaling.on('offer', async ({ sdp, sender, room_id }) => {
            if (!this.roomId || room_id !== this.roomId || this.isHost) {
                console.warn('[WebRTC] rejected unexpected offer');
                return;
            }
            this.remotePeerId = sender;
            if (!this.peerConnection) await this._createPeerConnection();
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            this.hasReceivedOffer = true;
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            console.log('[WebRTC] sending answer');
            this.signaling.send('answer', {
                room_id: this.roomId,
                target: sender,
                sdp: this.peerConnection.localDescription,
            });
        });

        this.signaling.on('answer', async ({ sdp, sender, room_id }) => {
            if (!this.roomId || room_id !== this.roomId || !this.isHost || !this.peerConnection) return;
            if (sender !== this.remotePeerId) return;
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            console.log('[WebRTC] answer applied');
        });

        this.signaling.on('ice-candidate', async ({ candidate, sender, room_id }) => {
            if (!this.peerConnection || !candidate || !this.roomId || room_id !== this.roomId) return;
            if (this.remotePeerId && sender !== this.remotePeerId) return;
            try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (error) {
                console.warn('[WebRTC] failed to add ICE candidate', error);
            }
        });

        this.signaling.on('disconnected', () => this.close());
    }
}
