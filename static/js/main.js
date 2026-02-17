/**
 * ShareX — Main Application Entry
 * Orchestrates all modules and initializes the application.
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
    }

    async init() {
        console.log('[ShareX] Initializing...');

        // Initialize UI state manager first
        this.uiState = new UIState();
        this.vibration = new Vibration();

        // ─── User Naming ───
        const savedName = localStorage.getItem('sharex-name');
        if (savedName) {
            this.myName = savedName;
        } else {
            await this._promptForName();
        }

        // Initialize signaling
        this.signaling = new Signaling();
        await this.signaling.connect();

        // Set device name
        this.signaling.setName(this.myName);

        // Listen for connection
        this.signaling.on('connected', (data) => {
            this.myId = data.id;
            console.log('[ShareX] Connected as:', this.myId);
        });

        // Initialize WebRTC manager
        this.webrtc = new WebRTCManager(this.signaling);

        // Initialize file transfer
        this.fileTransfer = new FileTransfer(this.webrtc, this.uiState);

        // Initialize device cards
        this.deviceCards = new DeviceCards(this.signaling, this.webrtc, this.fileTransfer);

        // Initialize presence
        this.presence = new Presence(this.signaling, this.deviceCards);

        // Initialize QR connect
        this.qr = new QRConnect(this.signaling);

        // Initialize numeric code
        this.numericCode = new NumericCode(this.signaling);

        // Bind UI events
        this._bindEvents();

        // Setup micro-dots
        this._createMicroDots();

        // Setup scroll reveal
        // Initialize geometric cube animation


        // Setup scroll reveal
        this._setupScrollReveal();

        // Listen for room entry
        this.signaling.on('room-joined', (data) => {
            console.log('[ShareX] Joined room. Peers:', data.peers);
            this.uiState.showToast(`Joined room with ${data.peers.length} peer(s)`);
        });

        // Auto-join room from URL (QR scan flow)
        this._checkURLJoin();

        console.log('[ShareX] Ready. Name:', this.myName);
    }

    _promptForName() {
        return new Promise((resolve) => {
            try {
                const modal = document.getElementById('name-modal');
                const input = document.getElementById('my-name-input');
                const btn = document.getElementById('save-name-btn');

                if (!modal || !input || !btn) {
                    console.warn('[ShareX] Name modal elements missing, skipping prompt.');
                    resolve();
                    return;
                }

                // Default suggestion
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
            } catch (e) {
                console.error('[ShareX] Error in name prompt:', e);
                resolve(); // Proceed anyway
            }
        });
    }

    _checkURLJoin() {
        const params = new URLSearchParams(window.location.search);
        const roomId = params.get('room');
        const code = params.get('code');

        if (roomId) {
            console.log('[ShareX] Auto-joining room from URL:', roomId);
            this.signaling.send('join-room', { room_id: roomId });
            this.uiState.showToast('Joining room...');
            // Clean URL
            window.history.replaceState({}, document.title, '/');
        } else if (code) {
            console.log('[ShareX] Auto-joining room with code:', code);
            this.signaling.send('join-room', { code });
            this.uiState.showToast('Joining room...');
            window.history.replaceState({}, document.title, '/');
        }
    }

    _generateDeviceName() {
        const agents = [
            'Chrome', 'Firefox', 'Safari', 'Edge', 'Mobile'
        ];
        const ua = navigator.userAgent;
        let browser = 'Device';
        for (const a of agents) {
            if (ua.includes(a)) { browser = a; break; }
        }
        const platform = /Mobile|Android|iPhone/i.test(ua) ? 'Mobile' : 'Desktop';
        return `${browser} ${platform}`;
    }

    _bindEvents() {
        // ─── Share buttons ───
        const btnShare = document.getElementById('btn-share');
        const btnShareDesktop = document.getElementById('btn-share-desktop');
        const fileInput = document.getElementById('file-input');

        const openFilePicker = () => {
            this.vibration.tap();
            fileInput.click();
        };

        if (btnShare) btnShare.addEventListener('click', openFilePicker);
        if (btnShareDesktop) btnShareDesktop.addEventListener('click', openFilePicker);

        // ─── SENDER FLOW: File Selection -> Create Room -> Show Modal ───
        fileInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
                this.fileTransfer.setPendingFiles(files);

                // Create Room for "AirDrop" Station
                this.signaling.send('create-room', {});
                this.qr.showGen(); // Reusing the QR generation logic

                // Also show a simplified pairing modal
                this.uiState.showToast('Ready to send. Ask receiver to connect.');
            }
            fileInput.value = '';
        });

        // ─── Receive buttons ───
        const btnReceive = document.getElementById('btn-receive');
        const btnReceiveDesktop = document.getElementById('btn-receive-desktop');

        const startReceiving = () => {
            this.vibration.tap();
            // "AirDrop-like" precision: Ask for code or show scanner
            // For now, default to "Enter Code" as the primary manual receive action
            this.numericCode.show();
            this.uiState.showToast('Enter code from sender');
        };

        if (btnReceive) btnReceive.addEventListener('click', startReceiving);
        if (btnReceiveDesktop) btnReceiveDesktop.addEventListener('click', startReceiving);

        // ─── Connection modes ───
        const modeAuto = document.getElementById('mode-auto');
        if (modeAuto) {
            modeAuto.addEventListener('click', () => {
                this.vibration.tap();
                this._showDeviceList();
            });
        }

        document.getElementById('mode-qr').addEventListener('click', () => {
            this.vibration.tap();
            this.qr.showGen();
        });

        const btnScan = document.getElementById('mode-scan');
        if (btnScan) {
            btnScan.addEventListener('click', () => {
                this.vibration.tap();
                this.qr.startScan();
            });
        }

        document.getElementById('mode-code').addEventListener('click', () => {
            this.vibration.tap();
            this.numericCode.show();
        });

        // ─── Incoming transfer handling ───
        this.signaling.on('offer', (data) => {
            if (data.file_meta) {
                this._showIncomingRequest(data);
            }
        });

        // ─── Transfer cancel ───
        const transferCancel = document.getElementById('transfer-cancel');
        if (transferCancel) {
            transferCancel.addEventListener('click', () => {
                this.fileTransfer.cancel();
            });
        }

        // ─── SENDER FLOW: File Selection -> Create Room -> Show Modal ───
        fileInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files && files.length > 0) {
                this.fileTransfer.setPendingFiles(files);

                // Trigger QR/Code Modal (which auto-creates room)
                this.qr.showGen();

                this.uiState.showToast('Ready to send. Ask receiver to connect.');
            }
            fileInput.value = '';
        });
    }

    _showDeviceList() {
        const deviceList = document.getElementById('device-list');
        if (deviceList) {
            deviceList.classList.remove('hidden');
            deviceList.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
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

        document.getElementById('incoming-accept').addEventListener('click', () => {
            this.vibration.tap();
            this.signaling.send('transfer-accepted', { target: data.sender });
            // Accept the WebRTC offer
            this.webrtc.handleOffer(data.sdp, data.sender);
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
            dotUp.style.left = Math.random() * 100 + '%';
            dotUp.style.top = Math.random() * 100 + '%';
            dotUp.style.animationDelay = Math.random() * 4 + 's';
            dotUp.style.animationDuration = (3 + Math.random() * 3) + 's';
            dotsUp.appendChild(dotUp);

            const dotDown = document.createElement('span');
            dotDown.className = 'split-layout__dot';
            dotDown.style.left = Math.random() * 100 + '%';
            dotDown.style.top = Math.random() * 100 + '%';
            dotDown.style.animationDelay = Math.random() * 4 + 's';
            dotDown.style.animationDuration = (3 + Math.random() * 3) + 's';
            dotsDown.appendChild(dotDown);
        }
    }

    _setupScrollReveal() {
        const elements = document.querySelectorAll('.modes, .devices, .desktop-actions');
        if (!elements.length) return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('reveal', 'visible');
                }
            });
        }, { threshold: 0.1 });

        elements.forEach(el => {
            el.classList.add('reveal');
            observer.observe(el);
        });
    }
}

// ─── Bootstrap ───
document.addEventListener('DOMContentLoaded', () => {
    const app = new ShareXApp();
    app.init().catch(err => {
        console.error('[ShareX] Initialization failed:', err);
    });
});
