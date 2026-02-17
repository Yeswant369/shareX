import { Signaling } from './signaling.js';
import { WebRTCManager } from './webrtc.js';
import { QRConnect } from './qr.js';
import { NumericCode } from './numeric-code.js';
import { FileTransfer } from './file-transfer.js';
import { UIState } from './ui-state.js';

class ShareXApp {
    constructor() {
        this.signaling = new Signaling();
        this.webrtc = new WebRTCManager(this.signaling);
        this.uiState = new UIState();
        this.fileTransfer = new FileTransfer(this.webrtc, this.uiState);
        this.qr = new QRConnect(this.signaling);
        this.numericCode = new NumericCode(this.signaling);

        this.myName = localStorage.getItem('sharex-name') || this._defaultName();
        this.currentRoomId = null;
        this.roomState = 'closed';
        this.hostId = null;
        this.otherPeerId = null;
    }

    async init() {
        await this._promptForName();
        await this.signaling.connect();
        this.signaling.setName(this.myName);

        this._bindSignaling();
        this._bindUI();
        this._autoJoinFromURL();
        this._renderRoomStatus();
    }

    _bindSignaling() {
        this.signaling.on('room-created', (data) => {
            this.currentRoomId = data.room_id;
            this.hostId = data.host_id;
            this.roomState = 'waiting';
            this._renderRoomStatus();
        });

        this.signaling.on('room-joined', (data) => {
            this.currentRoomId = data.room_id;
            this.hostId = data.host_id;
            this._refreshPeerSelection(data.peers || []);
            this._renderRoomStatus();
            this.uiState.showToast('Joined room successfully');
        });

        this.signaling.on('room-state-update', (data) => {
            if (this.currentRoomId && data.room_id !== this.currentRoomId) return;
            this.currentRoomId = data.room_id;
            this.hostId = data.host_id;
            this.roomState = data.state;
            this._refreshPeerSelection(data.peers || []);
            this._renderRoomStatus();
        });

        this.signaling.on('join-error', (data) => {
            this.uiState.showToast(data?.message || 'Room operation failed');
        });

        this.signaling.on('offer', (data) => {
            if (data?.file_meta?.name) {
                this.uiState.showToast(`Incoming file: ${data.file_meta.name}`);
            }
        });
    }

    _bindUI() {
        document.getElementById('mode-qr')?.addEventListener('click', () => this.qr.showGen());
        document.getElementById('mode-scan')?.addEventListener('click', () => this.qr.startScan());
        document.getElementById('mode-code')?.addEventListener('click', () => this.numericCode.show());

        const fileInput = document.getElementById('file-input');
        const chooseFiles = () => fileInput?.click();
        document.getElementById('btn-share')?.addEventListener('click', chooseFiles);
        document.getElementById('btn-share-desktop')?.addEventListener('click', chooseFiles);

        fileInput?.addEventListener('change', async (event) => {
            const files = event.target.files;
            if (!files || files.length === 0) return;

            if (!this.currentRoomId) {
                this.uiState.showToast('Create or join a room first');
                fileInput.value = '';
                return;
            }

            if (this.roomState !== 'ready') {
                this.uiState.showToast('Waiting for other device...');
                fileInput.value = '';
                return;
            }

            if (!this.webrtc.isHost) {
                this.uiState.showToast('Joiner is ready. Ask host device to send first.');
                fileInput.value = '';
                return;
            }

            if (!this.otherPeerId) {
                this.uiState.showToast('No target peer in room');
                fileInput.value = '';
                return;
            }

            this.fileTransfer.setPendingFiles(files);
            await this.fileTransfer.sendTo(this.otherPeerId);
            fileInput.value = '';
        });
    }

    _autoJoinFromURL() {
        const params = new URLSearchParams(window.location.search);
        const roomId = params.get('room');
        if (!roomId) return;
        this.signaling.send('join-room', { room_id: roomId });
        this.uiState.showToast('Auto joining room...');
        window.history.replaceState({}, document.title, '/');
    }

    _refreshPeerSelection(peerList) {
        const myId = this.signaling.id;
        const other = peerList.find((peer) => peer.id !== myId);
        this.otherPeerId = other ? other.id : null;
    }

    _renderRoomStatus() {
        const roomIdEl = document.getElementById('room-id-display');
        const stateEl = document.getElementById('room-state-display');
        if (roomIdEl) roomIdEl.textContent = this.currentRoomId || 'Not connected';

        if (stateEl) {
            if (!this.currentRoomId) stateEl.textContent = 'Create or join a room';
            else if (this.roomState === 'waiting') stateEl.textContent = 'Waiting for other device...';
            else if (this.roomState === 'ready') stateEl.textContent = 'Connected. Ready to transfer.';
            else stateEl.textContent = 'Room closed';
        }
    }

    async _promptForName() {
        if (localStorage.getItem('sharex-name')) return;
        const modal = document.getElementById('name-modal');
        const input = document.getElementById('my-name-input');
        const button = document.getElementById('save-name-btn');
        if (!modal || !input || !button) return;

        modal.classList.remove('hidden');
        input.value = this.myName;

        await new Promise((resolve) => {
            const done = () => {
                const value = input.value.trim() || this._defaultName();
                this.myName = value;
                localStorage.setItem('sharex-name', value);
                modal.classList.add('hidden');
                resolve();
            };
            button.addEventListener('click', done, { once: true });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') done();
            }, { once: true });
        });
    }

    _defaultName() {
        return /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'Mobile Device' : 'Desktop Device';
    }
}

const app = new ShareXApp();
app.init().catch((error) => {
    console.error('[ShareX] failed to initialize', error);
});
