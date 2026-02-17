export class Signaling {
    constructor() {
        this.socket = null;
        this.listeners = new Map();
        this.connected = false;
        this.pendingMessages = [];
        this.hasResolvedConnection = false;
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.socket = io(window.location.origin, {
                // Start with polling for mobile/proxy environments (e.g. Render edge),
                // then upgrade to websocket when available.
                transports: ['polling', 'websocket'],
                upgrade: true,
                reconnection: true,
                reconnectionAttempts: Infinity,
                timeout: 30000,
            });

            this.socket.on('connect', () => {
                this.connected = true;
                console.log('[Signaling] connected', this.socket.id);
                this._flushPendingMessages();
                if (!this.hasResolvedConnection) {
                    this.hasResolvedConnection = true;
                    resolve();
                }
            });

            this.socket.on('connect_error', (error) => {
                console.error('[Signaling] connect_error', error);
                this.emitLocal('connect-error', { message: error?.message || 'Connection failed' });
                if (!this.hasResolvedConnection) {
                    this.hasResolvedConnection = true;
                    reject(error);
                }
            });

            this.socket.on('disconnect', (reason) => {
                this.connected = false;
                console.warn('[Signaling] disconnected', reason);
                this.emitLocal('disconnected', { reason });
            });

            [
                'connected',
                'room-created',
                'room-joined',
                'room-state',
                'join-error',
                'signal-error',
                'offer',
                'answer',
                'ice-candidate',
            ].forEach((eventName) => {
                this.socket.on(eventName, (payload) => {
                    console.log('[Signaling] event', eventName, payload || {});
                    this.emitLocal(eventName, payload || {});
                });
            });
        });
    }

    on(eventName, callback) {
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, []);
        this.listeners.get(eventName).push(callback);
    }

    send(eventName, payload = {}) {
        if (!this.socket || !this.connected || !this.socket.connected) {
            console.warn('[Signaling] queue send while disconnected', eventName);
            this.pendingMessages.push({ eventName, payload });
            return;
        }
        console.log('[Signaling] send', eventName, payload);
        this.socket.emit(eventName, payload);
    }

    _flushPendingMessages() {
        if (!this.socket || !this.connected || this.pendingMessages.length === 0) return;
        const queued = [...this.pendingMessages];
        this.pendingMessages = [];
        queued.forEach(({ eventName, payload }) => {
            console.log('[Signaling] flush queued send', eventName, payload);
            this.socket.emit(eventName, payload || {});
        });
    }

    emitLocal(eventName, payload) {
        for (const cb of this.listeners.get(eventName) || []) {
            try {
                cb(payload);
            } catch (error) {
                console.error('[Signaling] listener failure', eventName, error);
            }
        }
    }

    setName(name) {
        this.send('set-name', { name });
    }

    get id() {
        return this.socket?.id || null;
    }
}
