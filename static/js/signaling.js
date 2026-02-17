/**
 * ShareX — Signaling Module
 * Socket.IO wrapper for WebRTC signaling.
 */

export class Signaling {
    constructor() {
        this.socket = null;
        this._listeners = {};
        this._connected = false;
    }

    async connect() {
        return new Promise((resolve, reject) => {
            const origin = window.location.origin;

            this.socket = io(origin, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: 20,
                reconnectionDelay: 800,
                reconnectionDelayMax: 4000,
                timeout: 20000,
            });

            this.socket.on('connect', () => {
                this._connected = true;
                console.log('[Signaling] connected', this.socket.id);
                resolve();
            });

            this.socket.on('connect_error', (err) => {
                console.error('[Signaling] connect_error', err.message);
                if (!this._connected) reject(err);
            });

            this.socket.on('disconnect', (reason) => {
                this._connected = false;
                console.warn('[Signaling] disconnected', reason);
                this._emit('disconnected', { reason });
            });

            this.socket.on('reconnect', (attempt) => {
                this._connected = true;
                console.log('[Signaling] reconnected attempt=', attempt);
                this._emit('reconnected', { attempt });
            });

            const relayEvents = [
                'connected',
                'nearby-peers',
                'peer-joined',
                'peer-left',
                'peer-updated',
                'room-created',
                'room-joined',
                'room-state',
                'host-changed',
                'join-error',
                'offer',
                'answer',
                'ice-candidate',
                'transfer-accepted',
                'transfer-rejected',
            ];

            relayEvents.forEach((event) => {
                this.socket.on(event, (data) => this._emit(event, data));
            });
        });
    }

    setName(name) {
        this.send('set-name', { name });
    }

    send(event, data = {}) {
        if (this.socket && this._connected) {
            this.socket.emit(event, data);
        } else {
            console.warn('[Signaling] cannot send event while disconnected:', event);
        }
    }

    on(event, callback) {
        if (!this._listeners[event]) this._listeners[event] = [];
        this._listeners[event].push(callback);
    }

    off(event, callback) {
        if (!this._listeners[event]) return;
        this._listeners[event] = this._listeners[event].filter((cb) => cb !== callback);
    }

    _emit(event, data) {
        const listeners = this._listeners[event] || [];
        listeners.forEach((cb) => {
            try {
                cb(data);
            } catch (err) {
                console.error(`[Signaling] listener error event=${event}`, err);
            }
        });
    }

    get isConnected() {
        return this._connected;
    }

    get id() {
        return this.socket ? this.socket.id : null;
    }

    disconnect() {
        if (!this.socket) return;
        this.socket.disconnect();
        this.socket = null;
        this._connected = false;
    }
}
