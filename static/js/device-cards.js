/**
 * ShareX — Device Cards Module
 * Dynamic rendering and management of peer device cards.
 */

export class DeviceCards {
    constructor(signaling, webrtc, fileTransfer) {
        this.signaling = signaling;
        this.webrtc = webrtc;
        this.fileTransfer = fileTransfer;
        this.grid = document.getElementById('devices-grid');
        this.cards = new Map(); // id -> DOM element
    }

    /**
     * Render all peers.
     */
    render(peers) {
        if (!this.grid) return;
        this.grid.innerHTML = '';
        this.cards.clear();

        peers.forEach((peer, id) => {
            this.addCard(id, peer);
        });

        this._updateEmpty(peers.size);
    }

    /**
     * Add a single device card.
     */
    addCard(id, peer) {
        if (!this.grid || this.cards.has(id)) return;

        const card = document.createElement('div');
        card.className = 'device-card';
        card.setAttribute('data-peer-id', id);
        card.style.animation = 'cardEnter 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards';

        const initial = this._getInitial(peer.name);
        const avatarColor = this._seedToColor(peer.avatar_seed);

        card.innerHTML = `
            <div class="device-card__avatar" style="border-color: ${avatarColor}">
                ${initial}
            </div>
            <span class="device-card__name">${this._escapeHtml(peer.name)}</span>
            <span class="device-card__status">available</span>
        `;

        card.addEventListener('click', () => {
            this._onCardClick(id, peer);
        });

        this.grid.appendChild(card);
        this.cards.set(id, card);
        this._updateEmpty(this.cards.size);

        // Show device list if hidden
        const deviceList = document.getElementById('device-list');
        if (deviceList && deviceList.classList.contains('hidden')) {
            deviceList.classList.remove('hidden');
        }
    }

    /**
     * Remove a device card.
     */
    removeCard(id) {
        const card = this.cards.get(id);
        if (card) {
            card.style.animation = 'cardEnter 0.3s ease-in reverse forwards';
            setTimeout(() => {
                card.remove();
                this.cards.delete(id);
                this._updateEmpty(this.cards.size);
            }, 300);
        }
    }

    /**
     * Update a device card.
     */
    updateCard(id, peer) {
        const card = this.cards.get(id);
        if (!card) return;

        const nameEl = card.querySelector('.device-card__name');
        const avatarEl = card.querySelector('.device-card__avatar');

        if (nameEl) nameEl.textContent = peer.name;
        if (avatarEl) {
            avatarEl.textContent = this._getInitial(peer.name);
            avatarEl.style.borderColor = this._seedToColor(peer.avatar_seed);
        }
    }

    // ─── Private ───

    _onCardClick(peerId, peer) {
        if (this.fileTransfer.pendingFiles && this.fileTransfer.pendingFiles.length > 0) {
            // We have files to send
            this.fileTransfer.sendTo(peerId);
        } else {
            // No files, open file picker first
            const fileInput = document.getElementById('file-input');
            if (fileInput) {
                // Set a one-time handler to send after picking
                const handler = (e) => {
                    const files = e.target.files;
                    if (files && files.length > 0) {
                        this.fileTransfer.setPendingFiles(files);
                        this.fileTransfer.sendTo(peerId);
                    }
                    fileInput.value = '';
                    fileInput.removeEventListener('change', handler);
                };
                fileInput.addEventListener('change', handler);
                fileInput.click();
            }
        }
    }

    _getInitial(name) {
        if (!name) return '?';
        const words = name.trim().split(/\s+/);
        if (words.length >= 2) {
            return (words[0][0] + words[1][0]).toUpperCase();
        }
        return name[0].toUpperCase();
    }

    _seedToColor(seed) {
        // Generate a monochrome-friendly "shade" — always white on black theme
        return '#FFFFFF';
    }

    _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    _updateEmpty(count) {
        const emptyEl = document.getElementById('devices-empty');
        const countEl = document.getElementById('peer-count');

        if (emptyEl) {
            emptyEl.classList.toggle('hidden', count > 0);
        }
        if (countEl) {
            countEl.textContent = count;
        }
    }
}
