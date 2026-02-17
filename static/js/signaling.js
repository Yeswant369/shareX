export class Signaling {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.listeners = new Map();
    }

    async connect() {
        return new Promise((resolve, reject) => {
            this.socket = io(window.location.origin, {
                transports: ['websocket', 'polling'],
                reconnection: true,
                reconnectionAttempts: 10,
                timeout: 20000,
            });

            this.socket.on('connect', () => {
                this.connected = true;
                resolve();
            });

            this.socket.on('connect_error', (error) => {
                if (!this.connected) reject(error);
            });

            this.socket.on('disconnect', (reason) => {
                this.connected = false;
                this.emitLocal('disconnected', { reason });
            });

            [
                'connected',
                'room-created',
                'room-joined',
                'room-state-update',
                'join-error',
                'peer-joined',
                'peer-left',
                'offer',
                'answer',
                'ice-candidate',
                'transfer-accepted',
                'transfer-rejected',
            ].forEach((eventName) => {
                this.socket.on(eventName, (payload) => this.emitLocal(eventName, payload));
            });
        });
    }

    on(eventName, callback) {
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, []);
        this.listeners.get(eventName).push(callback);
    }

    off(eventName, callback) {
        if (!this.listeners.has(eventName)) return;
        this.listeners.set(eventName, this.listeners.get(eventName).filter((cb) => cb !== callback));
    }

    emitLocal(eventName, payload) {
        (this.listeners.get(eventName) || []).forEach((callback) => {
            try {
                callback(payload);
            } catch (error) {
                console.error(`[Signaling] listener failed for ${eventName}`, error);
            }
        });
    }

    send(eventName, payload = {}) {
        if (!this.socket || !this.connected) return;
        this.socket.emit(eventName, payload);
    }

    setName(name) {
        this.send('set-name', { name });
    }

    get id() {
        return this.socket?.id || null;
    }
}
