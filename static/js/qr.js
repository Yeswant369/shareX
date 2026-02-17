/**
 * ShareX — QR Connect Module
 * Handles QR generation and Camera Scanning.
 */

import QRCode from "https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm";

export class QRConnect {
    constructor(signaling) {
        this.signaling = signaling;

        // QR Generation UI (Pairing Modal)
        this.genModal = document.getElementById('pairing-modal');
        this.genClose = document.getElementById('pairing-close');
        this.genBackdrop = null; // No separate backdrop for this modal style
        this.canvas = document.getElementById('pairing-qr-canvas');
        this.codeDisplay = document.getElementById('pairing-code');

        // QR Scanner UI
        this.scanModal = document.getElementById('scanner-modal');
        this.scanClose = document.getElementById('scanner-close');
        this.scanBackdrop = document.getElementById('scanner-backdrop');
        this.scanError = document.getElementById('scanner-error');
        this.scanner = null;

        this._bindEvents();
    }

    _bindEvents() {
        // Generation events
        if (this.genClose) this.genClose.addEventListener('click', () => this.hideGen());
        if (this.genBackdrop) this.genBackdrop.addEventListener('click', () => this.hideGen());

        // Scanner events
        if (this.scanClose) this.scanClose.addEventListener('click', () => this.stopScan());
        if (this.scanBackdrop) this.scanBackdrop.addEventListener('click', () => this.stopScan());

        // Room Created
        this.signaling.on('room-created', (data) => {
            if (this.codeDisplay) this.codeDisplay.textContent = data.code;
            this._renderQR(data.room_id);
        });
    }

    // ─── GENERATOR ───

    showGen() {
        if (this.genModal) this.genModal.classList.remove('hidden');
        this.signaling.send('create-room', {});
    }

    hideGen() {
        if (this.genModal) this.genModal.classList.add('hidden');
        if (this.scanModal) this.scanModal.classList.add('hidden'); // Ensure scanner is closed too

        // Clear gen canvas
        if (this.canvas) {
            const ctx = this.canvas.getContext('2d');
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    async _renderQR(roomId) {
        if (!this.canvas) return;
        const url = `${window.location.origin}?room=${roomId}`;
        try {
            await QRCode.toCanvas(this.canvas, url, {
                width: 220, margin: 0,
                color: { dark: '#000000', light: '#FFFFFF' },
                errorCorrectionLevel: 'M'
            });
            console.log('[QR] Generated:', url);
        } catch (err) {
            console.error('[QR] Gen failed:', err);
        }
    }

    // ─── SCANNER ───

    startScan() {
        console.log('[QR] Starting scanner...');
        if (this.scanModal) this.scanModal.classList.remove('hidden');
        if (this.scanError) this.scanError.classList.add('hidden');

        // Check if library loaded
        if (!window.Html5Qrcode) {
            this._showError('Scanner library not loaded. Check internet.');
            return;
        }

        const config = { fps: 10, qrbox: { width: 250, height: 250 } };

        this.scanner = new Html5Qrcode("reader");

        this.scanner.start(
            { facingMode: "environment" },
            config,
            (decodedText) => this._onScanSuccess(decodedText),
            (errorMessage) => { /* ignore per-frame errors */ }
        ).catch(err => {
            console.error('[QR] Camera error:', err);
            this._showError('Camera access denied or error.');
        });
    }

    stopScan() {
        if (this.scanner) {
            this.scanner.stop().then(() => {
                this.scanner.clear();
                this.scanner = null;
            }).catch(err => console.error('[QR] Stop failed', err));
        }
        if (this.scanModal) this.scanModal.classList.add('hidden');
        if (this.scanError) this.scanError.classList.add('hidden');
    }

    _onScanSuccess(decodedText) {
        console.log('[QR] Scanned:', decodedText);

        try {
            const url = new URL(decodedText);
            const roomId = url.searchParams.get('room');

            if (roomId) {
                this.stopScan();
                console.log('[QR] Join room:', roomId);
                this.signaling.send('join-room', { room_id: roomId });
            } else {
                this._showError('Invalid QR Code');
            }
        } catch (e) {
            this._showError('Invalid URL in QR');
        }
    }

    _showError(msg) {
        if (this.scanError) {
            this.scanError.textContent = msg;
            this.scanError.classList.remove('hidden');
        }
    }
}
