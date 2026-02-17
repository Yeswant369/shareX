/**
 * ShareX — Signaling Module
 * Socket.IO wrapper for WebRTC signaling.
 * Event-driven architecture with clean pub/sub.
 */

export class Signaling {
    constructor() {
        this.socket = null;
        this._listeners = {};
        this._connected = false;
    }

    /**
     * Connect to the signaling server.
     */
    async connect() {
        return new Promise((resolve, reject) => {
            const origin = window.location.origin;

            this.socket = io(origin, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: 10,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 5000,
                timeout: 20000,
            });

            this.socket.on('connect', () => {
                this._connected = true;
                console.log('[Signaling] Connected:', this.socket.id);
                resolve();
            });

            this.socket.on('connect_error', (err) => {
                console.error('[Signaling] Connection error:', err.message);
                if (!this._connected) {
                    reject(err);
                }
            });

            this.socket.on('disconnect', (reason) => {
                this._connected = false;
                console.warn('[Signaling] Disconnected:', reason);
                this._emit('disconnected', { reason });
            });

            this.socket.on('reconnect', (attempt) => {
                this._connected = true;
                console.log('[Signaling] Reconnected after', attempt, 'attempts');
                this._emit('reconnected', { attempt });
            });

            // ─── Relay all server events to local listeners ───
            const relayEvents = [
                'connected',
                'nearby-peers',
                'peer-joined',
                'peer-left',
                'peer-updated',
                'room-created',
                'room-joined',
                'join-error',
                'offer',
                'answer',
                'ice-candidate',
                'transfer-accepted',
                'transfer-rejected',
                'host-changed'
            ];

            relayEvents.forEach(event => {
                this.socket.on(event, (data) => {
                    this._emit(event, data);
                });
            });
        });
    }

    /**
     * Set device name on server.
     */
    setName(name) {
        this.send('set-name', { name });
    }

    /**
     * Send event to server.
     */
    send(event, data) {
        if (this.socket && this._connected) {
            this.socket.emit(event, data);
        } else {
            console.warn('[Signaling] Cannot send, not connected');
        }
    }

    /**
     * Subscribe to events.
     */
    on(event, callback) {
        if (!this._listeners[event]) {
            this._listeners[event] = [];
        }
        this._listeners[event].push(callback);
    }

    /**
     * Unsubscribe from events.
     */
    off(event, callback) {
        if (this._listeners[event]) {
            this._listeners[event] = this._listeners[event].filter(cb => cb !== callback);
        }
    }

    /**
     * Emit event to local listeners.
     */
    _emit(event, data) {
        const listeners = this._listeners[event];
        if (listeners) {
            listeners.forEach(cb => {
                try {
                    cb(data);
                } catch (err) {
                    console.error(`[Signaling] Listener error for ${event}:`, err);
                }
            });
        }
    }

    /**
     * Check connection status.
     */
    get isConnected() {
        return this._connected;
    }

    /**
     * Get socket ID.
     */
    get id() {
        return this.socket ? this.socket.id : null;
    }

    /**
     * Disconnect from server.
     */
    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
            this._connected = false;
        }
    }
}
