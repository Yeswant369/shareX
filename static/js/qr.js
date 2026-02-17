/**
 * ShareX — QR Connect Module
 * Handles QR generation and camera scanning.
 */

import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm';

export class QRConnect {
    constructor(signaling) {
        this.signaling = signaling;

        this.genModal = document.getElementById('pairing-modal');
        this.genClose = document.getElementById('pairing-close');
        this.genBackdrop = null;
        this.canvas = document.getElementById('pairing-qr-canvas');
        this.codeDisplay = document.getElementById('pairing-code');

        this.scanModal = document.getElementById('scanner-modal');
        this.scanClose = document.getElementById('scanner-close');
        this.scanBackdrop = document.getElementById('scanner-backdrop');
        this.scanError = document.getElementById('scanner-error');
        this.scanner = null;
        this._scanActive = false;

        this._bindEvents();
    }

    _bindEvents() {
        if (this.genClose) this.genClose.addEventListener('click', () => this.hideGen());
        if (this.genBackdrop) this.genBackdrop.addEventListener('click', () => this.hideGen());
        if (this.scanClose) this.scanClose.addEventListener('click', () => this.stopScan());
        if (this.scanBackdrop) this.scanBackdrop.addEventListener('click', () => this.stopScan());

        this.signaling.on('room-created', (data) => {
            if (this.codeDisplay) this.codeDisplay.textContent = data.code;
            this._renderQR(data.room_id);
        });
    }

    showGen() {
        if (this.genModal) this.genModal.classList.remove('hidden');
        this.signaling.send('create-room', {});
    }

    hideGen() {
        if (this.genModal) this.genModal.classList.add('hidden');
        if (this.canvas) {
            const ctx = this.canvas.getContext('2d');
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    async _renderQR(roomId) {
        if (!this.canvas || !roomId) return;
        const url = `${window.location.origin}?room=${encodeURIComponent(roomId)}`;
        try {
            await QRCode.toCanvas(this.canvas, url, {
                width: 220,
                margin: 0,
                color: { dark: '#000000', light: '#FFFFFF' },
                errorCorrectionLevel: 'M',
            });
            console.log('[QR] generated', url);
        } catch (err) {
            console.error('[QR] generation failed', err);
        }
    }

    startScan() {
        if (this._scanActive) return;
        if (this.scanModal) this.scanModal.classList.remove('hidden');
        if (this.scanError) this.scanError.classList.add('hidden');

        if (!window.Html5Qrcode) {
            this._showError('Scanner library not loaded.');
            return;
        }

        this._scanActive = true;
        this.scanner = new Html5Qrcode('reader');

        this.scanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (decodedText) => this._onScanSuccess(decodedText),
            () => { }
        ).catch((err) => {
            this._scanActive = false;
            console.error('[QR] camera error', err);
            this._showError('Camera access denied or unavailable.');
        });
    }

    stopScan() {
        if (!this._scanActive) {
            if (this.scanModal) this.scanModal.classList.add('hidden');
            return;
        }

        const scanner = this.scanner;
        this._scanActive = false;
        this.scanner = null;

        if (scanner) {
            scanner.stop()
                .then(() => scanner.clear())
                .catch((err) => console.warn('[QR] stop failed', err));
        }

        if (this.scanModal) this.scanModal.classList.add('hidden');
        if (this.scanError) this.scanError.classList.add('hidden');
    }

    _onScanSuccess(decodedText) {
        try {
            const parsed = new URL(decodedText, window.location.origin);
            const roomId = parsed.searchParams.get('room');

            if (!roomId) {
                this._showError('Invalid QR room link');
                return;
            }

            this.stopScan();
            this.signaling.send('join-room', { room_id: roomId });
            console.log('[QR] scanned and joining room', roomId);
        } catch (_) {
            this._showError('Invalid QR URL');
        }
    }

    _showError(msg) {
        if (!this.scanError) return;
        this.scanError.textContent = msg;
        this.scanError.classList.remove('hidden');
    }
}
