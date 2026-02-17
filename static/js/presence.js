/**
 * ShareX — Presence Module
 * Manages peer list rendering from subnet + room state.
 */

export class Presence {
    constructor(signaling, deviceCards) {
        this.signaling = signaling;
        this.deviceCards = deviceCards;
        this.peers = new Map();

        this._bindEvents();
    }

    _bindEvents() {
        this.signaling.on('nearby-peers', (data) => {
            if (!Array.isArray(data?.peers)) return;
            data.peers.forEach((peer) => {
                this.peers.set(peer.id, {
                    name: peer.name,
                    avatar_seed: peer.avatar_seed,
                    timestamp: peer.timestamp,
                });
            });
            this.deviceCards.render(this.peers);
        });

        this.signaling.on('peer-joined', (data) => {
            this.peers.set(data.id, {
                name: data.name,
                avatar_seed: data.avatar_seed,
                timestamp: Date.now() / 1000,
            });
            this.deviceCards.addCard(data.id, this.peers.get(data.id));
            this._updateCount();
        });

        this.signaling.on('peer-left', (data) => {
            this.peers.delete(data.id);
            this.deviceCards.removeCard(data.id);
            this._updateCount();
        });

        this.signaling.on('peer-updated', (data) => {
            if (!this.peers.has(data.id)) return;
            const peer = this.peers.get(data.id);
            peer.name = data.name;
            peer.avatar_seed = data.avatar_seed;
            this.deviceCards.updateCard(data.id, peer);
        });

        this.signaling.on('room-state', (data) => {
            if (!Array.isArray(data?.peers)) return;

            const fromRoom = new Map();
            data.peers.forEach((peer) => {
                fromRoom.set(peer.id, {
                    name: peer.name,
                    avatar_seed: peer.avatar_seed,
                    timestamp: Date.now() / 1000,
                });
            });

            fromRoom.forEach((peer, id) => {
                if (!this.peers.has(id)) {
                    this.peers.set(id, peer);
                    this.deviceCards.addCard(id, peer);
                } else {
                    this.peers.set(id, peer);
                    this.deviceCards.updateCard(id, peer);
                }
            });

            // remove stale room peers (keep local subnet peers untouched only when still listed)
            Array.from(this.peers.keys()).forEach((peerId) => {
                if (!fromRoom.has(peerId) && this.peers.size <= 2) {
                    this.peers.delete(peerId);
                    this.deviceCards.removeCard(peerId);
                }
            });

            this._updateCount();
        });
    }

    _updateCount() {
        const countEl = document.getElementById('peer-count');
        if (countEl) countEl.textContent = this.peers.size;

        const emptyEl = document.getElementById('devices-empty');
        const gridEl = document.getElementById('devices-grid');
        if (!emptyEl || !gridEl) return;

        if (this.peers.size > 0) {
            emptyEl.classList.add('hidden');
            gridEl.classList.remove('hidden');
        } else {
            emptyEl.classList.remove('hidden');
            gridEl.classList.add('hidden');
        }
    }

    get count() {
        return this.peers.size;
    }

    getPeer(id) {
        return this.peers.get(id);
    }
}
