import { Signaling } from './signaling.js';
import { WebRTCManager } from './webrtc.js';
import { QRConnect } from './qr.js';
import { NumericCode } from './numeric-code.js';
import { FileTransfer } from './file-transfer.js';
import { UIState } from './ui-state.js';

class RoomManager {
    constructor() {
        this.roomId = null;
        this.hostId = null;
        this.isHost = false;
        this.isInRoom = false;
        this.connectionState = 'WAITING';
        this.remotePeerId = null;

        this.overlay = this._createOverlay();
    }

    _createOverlay() {
        const el = document.createElement('div');
        el.id = 'room-debug-overlay';
        el.style.position = 'fixed';
        el.style.right = '10px';
        el.style.bottom = '10px';
        el.style.zIndex = '9999';
        el.style.fontSize = '12px';
        el.style.padding = '8px 10px';
        el.style.border = '1px solid #444';
        el.style.borderRadius = '8px';
        el.style.background = 'rgba(0,0,0,.75)';
        el.style.color = '#fff';
        document.body.appendChild(el);
        return el;
    }

    applyRoomState(roomState, myId) {
        this.roomId = roomState.room_id;
        this.hostId = roomState.host_id;
        this.isHost = myId === roomState.host_id;
        this.isInRoom = Array.isArray(roomState.peers) && roomState.peers.some((p) => p.id === myId);
        const remote = (roomState.peers || []).find((p) => p.id !== myId);
        this.remotePeerId = remote?.id || null;
        this.connectionState = this.remotePeerId ? 'READY' : 'WAITING';
        this.render();
    }

    setConnectionState(state) {
        if (state === 'connected') this.connectionState = 'CONNECTED';
        else if (this.remotePeerId) this.connectionState = 'READY';
        else this.connectionState = 'WAITING';
        this.render();
    }

    render() {
        this.overlay.innerHTML = `Room: ${this.roomId || '----'}<br>Role: ${this.isHost ? 'HOST' : 'JOINER'}<br>State: ${this.connectionState}`;
        const roomIdEl = document.getElementById('room-id-display');
        const roomStateEl = document.getElementById('room-state-display');
        if (roomIdEl) roomIdEl.textContent = this.roomId || 'Not connected';
        if (roomStateEl) roomStateEl.textContent = this.connectionState;
    }
}

class ShareXApp {
    constructor() {
        this.signaling = new Signaling();
        this.webrtc = new WebRTCManager(this.signaling);
        this.uiState = new UIState();
        this.qr = new QRConnect(this.signaling);
        this.numericCode = new NumericCode(this.signaling);
        this.fileTransfer = new FileTransfer(this.webrtc, this.uiState);
        this.room = new RoomManager();
        this.selectedFiles = [];
    }

    async init() {
        await this._ensureName();
        this._bindSignalEvents();
        this._bindButtons();

        try {
            await this.signaling.connect();
            this.signaling.setName(localStorage.getItem('sharex-name'));
        } catch (error) {
            console.error('[App] signaling connection failed', error);
            this.uiState.showToast('Connection issue detected. You can still select files and retry pairing.');
        }

        this._autoJoinFromURL();
    }

    _bindSignalEvents() {
        this.signaling.on('room-created', ({ room_id, numeric_code }) => {
            console.log('[Room] created', room_id, numeric_code);
            this.qr.showRoom(room_id, numeric_code);
        });

        this.signaling.on('room-joined', ({ room_id }) => {
            console.log('[Room] joined', room_id);
            this.numericCode.hide();
            this.uiState.showToast('Joined room');
        });

        this.signaling.on('room-state', (payload) => {
            console.log('[Room] authoritative room-state', payload);
            this.room.applyRoomState(payload, this.signaling.id);
            this.webrtc.setRoomContext({
                roomId: this.room.roomId,
                isHost: this.room.isHost,
                remotePeerId: this.room.remotePeerId,
            });

            if (this.room.isHost && this.room.remotePeerId) {
                this.webrtc.ensureHostOffer();
            }
        });

        this.webrtc.onStateChange((state) => {
            this.room.setConnectionState(state);
        });

        this.signaling.on('join-error', ({ message }) => {
            this.numericCode.showError(message || 'Join failed');
            this.uiState.showToast(message || 'Join failed');
        });

        this.signaling.on('signal-error', ({ message }) => {
            this.uiState.showToast(message || 'Signaling rejected');
        });
    }

    _bindButtons() {
        const qrBtn = document.getElementById('mode-qr');
        const codeBtn = document.getElementById('mode-code');
        const nearbyBtn = document.getElementById('mode-auto');
        const scanBtn = document.getElementById('mode-scan');
        const shareButtons = [document.getElementById('btn-share'), document.getElementById('btn-share-desktop')];
        const fileInput = document.getElementById('file-input');

        qrBtn?.addEventListener('click', () => {
            console.log('[UI] QR button clicked');
            this.signaling.send('create-room', {});
        });

        codeBtn?.addEventListener('click', () => {
            console.log('[UI] Code button clicked');
            this.numericCode.show();
        });

        nearbyBtn?.addEventListener('click', () => {
            console.log('[UI] Nearby button clicked');
            this.signaling.send('create-room', {});
            this.uiState.showToast('Nearby pairing started. Share QR or code.');
        });

        scanBtn?.addEventListener('click', () => this.qr.startScan());

        shareButtons.forEach((button) => {
            button?.addEventListener('click', () => {
                console.log('[UI] File select button clicked');
                fileInput?.click();
            });
        });

        fileInput?.addEventListener('change', (event) => {
            this.selectedFiles = Array.from(event.target.files || []);
            this.fileTransfer.setPendingFiles(this.selectedFiles);
            console.log('[UI] Transfer button/file selected', this.selectedFiles.map((f) => f.name));
            this.startTransfer();
            fileInput.value = '';
        });
    }

    async startTransfer() {
        if (!this.room.isInRoom || !this.room.remotePeerId) {
            this.uiState.showToast('Join a room with another device first');
            return;
        }
        if (!this.room.isHost && !this.webrtc.isReadyForTransfer()) {
            this.uiState.showToast('Waiting for host to initiate connection');
            return;
        }

        try {
            await this.fileTransfer.startTransfer();
        } catch (error) {
            console.error('[Transfer] failed', error);
            this.uiState.showToast('Transfer failed');
        }
    }

    _autoJoinFromURL() {
        const params = new URLSearchParams(window.location.search);
        const roomId = params.get('room');
        if (!roomId) return;
        console.log('[Room] auto-join room from URL', roomId);
        this.signaling.send('join-room', { room_id: roomId });
        window.history.replaceState({}, document.title, '/');
    }

    async _ensureName() {
        if (localStorage.getItem('sharex-name')) return;

        const modal = document.getElementById('name-modal');
        const input = document.getElementById('my-name-input');
        const save = document.getElementById('save-name-btn');
        if (!modal || !input || !save) return;

        modal.classList.remove('hidden');
        await new Promise((resolve) => {
            const onSave = () => {
                const name = input.value.trim() || (window.innerWidth < 768 ? 'Mobile Device' : 'Desktop Device');
                localStorage.setItem('sharex-name', name);
                modal.classList.add('hidden');
                resolve();
            };
            save.addEventListener('click', onSave, { once: true });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') onSave();
            });
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new ShareXApp();
    app.init().catch((error) => {
        console.error('[App] init failed', error);
    });
});
