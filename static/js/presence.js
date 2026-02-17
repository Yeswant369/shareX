/**
 * ShareX — Presence Module
 * Manages real-time peer detection, subnet grouping visibility,
 * and dynamic device card rendering.
 */

export class Presence {
    constructor(signaling, deviceCards) {
        this.signaling = signaling;
        this.deviceCards = deviceCards;
        this.peers = new Map(); // id -> { name, avatar_seed, timestamp }

        this._bindEvents();
    }

    _bindEvents() {
        // Initial nearby peers list
        this.signaling.on('nearby-peers', (data) => {
            if (data.peers && Array.isArray(data.peers)) {
                data.peers.forEach(peer => {
                    this.peers.set(peer.id, {
                        name: peer.name,
                        avatar_seed: peer.avatar_seed,
                        timestamp: peer.timestamp
                    });
                });
                this.deviceCards.render(this.peers);
            }
        });

        // New peer joined
        this.signaling.on('peer-joined', (data) => {
            this.peers.set(data.id, {
                name: data.name,
                avatar_seed: data.avatar_seed,
                timestamp: Date.now() / 1000
            });
            this.deviceCards.addCard(data.id, this.peers.get(data.id));
            this._updateCount();
        });

        // Peer left
        this.signaling.on('peer-left', (data) => {
            this.peers.delete(data.id);
            this.deviceCards.removeCard(data.id);
            this._updateCount();
        });

        // Peer updated name
        this.signaling.on('peer-updated', (data) => {
            if (this.peers.has(data.id)) {
                const peer = this.peers.get(data.id);
                peer.name = data.name;
                peer.avatar_seed = data.avatar_seed;
                this.deviceCards.updateCard(data.id, peer);
            }
        });

        // Room joined — add room peers
        this.signaling.on('room-joined', (data) => {
            if (data.peers && Array.isArray(data.peers)) {
                data.peers.forEach(peer => {
                    if (!this.peers.has(peer.id)) {
                        this.peers.set(peer.id, {
                            name: peer.name,
                            avatar_seed: peer.avatar_seed,
                            timestamp: Date.now() / 1000
                        });
                        this.deviceCards.addCard(peer.id, this.peers.get(peer.id));
                    }
                });
                this._updateCount();
            }
        });
    }

    _updateCount() {
        const countEl = document.getElementById('peer-count');
        if (countEl) {
            countEl.textContent = this.peers.size;
        }

        const emptyEl = document.getElementById('devices-empty');
        const gridEl = document.getElementById('devices-grid');
        if (emptyEl && gridEl) {
            if (this.peers.size > 0) {
                emptyEl.classList.add('hidden');
                gridEl.classList.remove('hidden');
            } else {
                emptyEl.classList.remove('hidden');
                gridEl.classList.add('hidden');
            }
        }
    }

    /**
     * Get peer count.
     */
    get count() {
        return this.peers.size;
    }

    /**
     * Get a specific peer.
     */
    getPeer(id) {
        return this.peers.get(id);
    }
}
