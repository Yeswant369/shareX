/**
 * ShareX — Main Application Entry
 * Deterministic room + signaling orchestration.
 */

import { Signaling } from './signaling.js';
import { WebRTCManager } from './webrtc.js';
import { Presence } from './presence.js';
import { QRConnect } from './qr.js';
import { NumericCode } from './numeric-code.js';
import { FileTransfer } from './file-transfer.js';
import { DeviceCards } from './device-cards.js';
import { UIState } from './ui-state.js';
import { Vibration } from './vibration.js';

class ShareXApp {
    constructor() {
        this.signaling = null;
        this.webrtc = null;
        this.presence = null;
        this.qr = null;
        this.numericCode = null;
        this.fileTransfer = null;
        this.deviceCards = null;
        this.uiState = null;
        this.vibration = null;
        this.myId = null;
        this.myName = this._generateDeviceName();

        // RoomManager state
        this.roomId = null;
        this.hostId = null;
        this.isHost = false;
        this.isInRoom = false;

        this._statusNode = null;
        this._debugNode = null;
        this._debugEnabled = new URLSearchParams(window.location.search).get('debug') === 'true';
        this._connState = 'DISCONNECTED';
    }

    async init() {
        this.uiState = new UIState();
        this.vibration = new Vibration();

        const savedName = localStorage.getItem('sharex-name');
        if (savedName) this.myName = savedName;
        else await this._promptForName();

        this._initStatusOverlay();

        this.signaling = new Signaling();
        await this.signaling.connect();

        this.signaling.on('connected', (data) => {
            this.myId = data.id;
            this._syncRoleState();
            this._renderStatusOverlay();
        });

        this.signaling.on('disconnected', () => {
            this._connState = 'DISCONNECTED';
            this._clearRoomState();
            this._renderStatusOverlay();
        });

        this.signaling.setName(this.myName);

        this.webrtc = new WebRTCManager(this.signaling);
        this.fileTransfer = new FileTransfer(this.webrtc, this.uiState);
        this.deviceCards = new DeviceCards(this.signaling, this.webrtc, this.fileTransfer);
        this.presence = new Presence(this.signaling, this.deviceCards);
        this.qr = new QRConnect(this.signaling);
        this.numericCode = new NumericCode(this.signaling);

        this._bindEvents();
        this._bindRoomEvents();
        this._createMicroDots();
        this._setupScrollReveal();
        this._checkURLJoin();

        console.log('[ShareX] ready name=', this.myName);
    }

    _bindRoomEvents() {
        this.signaling.on('room-created', (data) => {
            this.roomId = data.room_id || null;
            this.hostId = data.host_id || this.myId;
            this.isInRoom = Boolean(this.roomId);
            this.isHost = true;
            this._syncRoleState();
            this._renderStatusOverlay();
            if (this.roomId) this.uiState.showToast(`Room created: ${this.roomId}`);
        });

        this.signaling.on('room-joined', (data) => {
            this.roomId = data.room_id || null;
            this.hostId = data.host_id || null;
            this.isInRoom = Boolean(this.roomId);
            this.isHost = this.myId && this.hostId ? this.myId === this.hostId : false;
            this._syncRoleState();
            this._renderStatusOverlay();

            if (this.roomId) {
                this.uiState.showToast(`Connected to room ${this.roomId}`);
            }
        });

        this.signaling.on('room-state', (data) => {
            this.roomId = data.room_id || this.roomId;
            this.hostId = data.host_id || this.hostId;
            this.isInRoom = Boolean(this.roomId);
            this.isHost = this.myId && this.hostId ? this.myId === this.hostId : false;
            this._syncRoleState();
            this._renderStatusOverlay();
        });

        this.signaling.on('host-changed', (data) => {
            if (this.roomId && data.room_id !== this.roomId) return;
            this.hostId = data.host_id;
            this.isHost = this.myId && this.hostId ? this.myId === this.hostId : false;
            this._syncRoleState();
            this._renderStatusOverlay();
        });

        this.signaling.on('join-error', (data) => {
            this.uiState.showToast(data?.message || 'Join failed');
        });

        this.webrtc.onStateChange((_peerId, state) => {
            this._connState = (state || 'disconnected').toUpperCase();
            this._renderStatusOverlay();
        });
    }

    _syncRoleState() {
        if (!this.webrtc) return;
        this.webrtc.setIdentity({
            myId: this.myId,
            roomId: this.roomId,
            hostId: this.hostId,
            isHost: this.isHost,
            isInRoom: this.isInRoom,
        });
    }

    _clearRoomState() {
        this.roomId = null;
        this.hostId = null;
        this.isHost = false;
        this.isInRoom = false;
        this._syncRoleState();
    }

    _initStatusOverlay() {
        this._statusNode = document.createElement('div');
        this._statusNode.id = 'room-status-overlay';
        this._statusNode.style.position = 'fixed';
        this._statusNode.style.right = '12px';
        this._statusNode.style.bottom = this._debugEnabled ? '64px' : '12px';
        this._statusNode.style.zIndex = '9999';
        this._statusNode.style.background = 'rgba(0,0,0,0.72)';
        this._statusNode.style.color = '#fff';
        this._statusNode.style.padding = '6px 10px';
        this._statusNode.style.borderRadius = '8px';
        this._statusNode.style.fontSize = '11px';
        this._statusNode.style.fontFamily = 'monospace';
        this._statusNode.style.pointerEvents = 'none';
        document.body.appendChild(this._statusNode);

        if (this._debugEnabled) {
            this._debugNode = document.createElement('div');
            this._debugNode.id = 'debug-overlay';
            this._debugNode.style.position = 'fixed';
            this._debugNode.style.right = '12px';
            this._debugNode.style.bottom = '12px';
            this._debugNode.style.zIndex = '9999';
            this._debugNode.style.background = 'rgba(0,0,0,0.78)';
            this._debugNode.style.color = '#b5ffb8';
            this._debugNode.style.padding = '6px 10px';
            this._debugNode.style.borderRadius = '8px';
            this._debugNode.style.fontSize = '11px';
            this._debugNode.style.fontFamily = 'monospace';
            this._debugNode.style.pointerEvents = 'none';
            document.body.appendChild(this._debugNode);
        }

        this._renderStatusOverlay();
    }

    _renderStatusOverlay() {
        if (this._statusNode) {
            const roomText = this.isInRoom ? this.roomId : 'not-joined';
            const role = this.isHost ? 'HOST' : 'JOINER';
            this._statusNode.textContent = `Room: ${roomText} | Role: ${this.isInRoom ? role : '-'}`;
        }

        if (this._debugNode) {
            this._debugNode.textContent = `Connection: ${this._connState}`;
        }
    }

    _promptForName() {
        return new Promise((resolve) => {
            try {
                const modal = document.getElementById('name-modal');
                const input = document.getElementById('my-name-input');
                const btn = document.getElementById('save-name-btn');

                if (!modal || !input || !btn) {
                    resolve();
                    return;
                }

                input.value = this._generateDeviceName();
                modal.classList.remove('hidden');

                const save = () => {
                    const name = input.value.trim() || this._generateDeviceName();
                    this.myName = name;
                    localStorage.setItem('sharex-name', name);
                    modal.classList.add('hidden');
                    resolve();
                };

                btn.addEventListener('click', save);
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') save();
                });
            } catch (_) {
                resolve();
            }
        });
    }

    _checkURLJoin() {
        const params = new URLSearchParams(window.location.search);
        const roomId = params.get('room');
        const code = params.get('code');

        if (roomId) {
            this.signaling.send('join-room', { room_id: roomId });
            this.uiState.showToast('Joining room from QR...');
            window.history.replaceState({}, document.title, '/');
            return;
        }

        if (code) {
            this.signaling.send('join-room', { code });
            this.uiState.showToast('Joining room with code...');
            window.history.replaceState({}, document.title, '/');
        }
    }

    _generateDeviceName() {
        const agents = ['Chrome', 'Firefox', 'Safari', 'Edge', 'Mobile'];
        const ua = navigator.userAgent;
        let browser = 'Device';
        for (const agent of agents) {
            if (ua.includes(agent)) {
                browser = agent;
                break;
            }
        }
        const platform = /Mobile|Android|iPhone/i.test(ua) ? 'Mobile' : 'Desktop';
        return `${browser} ${platform}`;
    }

    _bindEvents() {
        const btnShare = document.getElementById('btn-share');
        const btnShareDesktop = document.getElementById('btn-share-desktop');
        const fileInput = document.getElementById('file-input');

        const openFilePicker = () => {
            this.vibration.tap();
            fileInput.click();
        };

        if (btnShare) btnShare.addEventListener('click', openFilePicker);
        if (btnShareDesktop) btnShareDesktop.addEventListener('click', openFilePicker);

        fileInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files?.length > 0) {
                this.fileTransfer.setPendingFiles(files);
                this.qr.showGen();
                this.uiState.showToast('Ready to send. Ask receiver to connect.');
            }
            fileInput.value = '';
        });

        const btnReceive = document.getElementById('btn-receive');
        const btnReceiveDesktop = document.getElementById('btn-receive-desktop');
        const startReceiving = () => {
            this.vibration.tap();
            this.numericCode.show();
            this.uiState.showToast('Enter code from sender');
        };

        if (btnReceive) btnReceive.addEventListener('click', startReceiving);
        if (btnReceiveDesktop) btnReceiveDesktop.addEventListener('click', startReceiving);

        const modeAuto = document.getElementById('mode-auto');
        if (modeAuto) {
            modeAuto.addEventListener('click', () => {
                this.vibration.tap();
                this._showDeviceList();
            });
        }

        const modeQR = document.getElementById('mode-qr');
        if (modeQR) {
            modeQR.addEventListener('click', () => {
                this.vibration.tap();
                this.qr.showGen();
            });
        }

        const btnScan = document.getElementById('mode-scan');
        if (btnScan) {
            btnScan.addEventListener('click', () => {
                this.vibration.tap();
                this.qr.startScan();
            });
        }

        const modeCode = document.getElementById('mode-code');
        if (modeCode) {
            modeCode.addEventListener('click', () => {
                this.vibration.tap();
                this.numericCode.show();
            });
        }

        this.signaling.on('offer', (data) => {
            if (data.file_meta) this._showIncomingRequest(data);
        });

        const transferCancel = document.getElementById('transfer-cancel');
        if (transferCancel) {
            transferCancel.addEventListener('click', () => this.fileTransfer.cancel());
        }
    }

    _showDeviceList() {
        const deviceList = document.getElementById('device-list');
        if (!deviceList) return;
        deviceList.classList.remove('hidden');
        deviceList.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    _showIncomingRequest(data) {
        const modal = document.getElementById('incoming-modal');
        const filename = document.getElementById('incoming-filename');
        const size = document.getElementById('incoming-size');
        const from = document.getElementById('incoming-from');
        const acceptBtn = document.getElementById('incoming-accept');
        const rejectBtn = document.getElementById('incoming-reject');
        const backdrop = document.getElementById('incoming-backdrop');

        if (!modal || !data.file_meta) return;

        filename.textContent = data.file_meta.name || 'Unknown file';
        size.textContent = this._formatSize(data.file_meta.size || 0);
        from.textContent = `From: ${data.name || 'Unknown'}`;

        this.vibration.notify();
        modal.classList.remove('hidden');

        const cleanup = () => {
            modal.classList.add('hidden');
            acceptBtn.replaceWith(acceptBtn.cloneNode(true));
            rejectBtn.replaceWith(rejectBtn.cloneNode(true));
        };

        document.getElementById('incoming-accept').addEventListener('click', async () => {
            this.vibration.tap();
            this.signaling.send('transfer-accepted', { target: data.sender });
            await this.webrtc.handleOffer(data.sdp, data.sender, data.room_id);
            this.fileTransfer.startReceiving(data.file_meta);
            cleanup();
        }, { once: true });

        document.getElementById('incoming-reject').addEventListener('click', () => {
            this.vibration.tap();
            this.signaling.send('transfer-rejected', { target: data.sender });
            cleanup();
        }, { once: true });

        if (backdrop) {
            backdrop.addEventListener('click', () => {
                this.signaling.send('transfer-rejected', { target: data.sender });
                cleanup();
            }, { once: true });
        }
    }

    _formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    _createMicroDots() {
        const dotsUp = document.getElementById('dots-up');
        const dotsDown = document.getElementById('dots-down');
        if (!dotsUp || !dotsDown) return;

        for (let i = 0; i < 30; i++) {
            const dotUp = document.createElement('span');
            dotUp.className = 'split-layout__dot';
            dotUp.style.left = `${Math.random() * 100}%`;
            dotUp.style.top = `${Math.random() * 100}%`;
            dotUp.style.animationDelay = `${Math.random() * 4}s`;
            dotUp.style.animationDuration = `${3 + Math.random() * 3}s`;
            dotsUp.appendChild(dotUp);

            const dotDown = document.createElement('span');
            dotDown.className = 'split-layout__dot';
            dotDown.style.left = `${Math.random() * 100}%`;
            dotDown.style.top = `${Math.random() * 100}%`;
            dotDown.style.animationDelay = `${Math.random() * 4}s`;
            dotDown.style.animationDuration = `${3 + Math.random() * 3}s`;
            dotsDown.appendChild(dotDown);
        }
    }

    _setupScrollReveal() {
        const elements = document.querySelectorAll('.modes, .devices, .desktop-actions');
        if (!elements.length) return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('reveal', 'visible');
                }
            });
        }, { threshold: 0.1 });

        elements.forEach((el) => {
            el.classList.add('reveal');
            observer.observe(el);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const app = new ShareXApp();
    app.init().catch((err) => {
        console.error('[ShareX] initialization failed', err);
    });
});
