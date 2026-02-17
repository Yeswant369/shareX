import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm';

export class QRConnect {
    constructor(signaling) {
        this.signaling = signaling;
        this.modal = document.getElementById('qr-modal');
        this.backdrop = document.getElementById('qr-backdrop');
        this.closeBtn = document.getElementById('qr-close');
        this.canvas = document.getElementById('qr-canvas');
        this.codeEl = document.getElementById('qr-room-code');

        this.scannerModal = document.getElementById('scanner-modal');
        this.scannerClose = document.getElementById('scanner-close');
        this.scannerBackdrop = document.getElementById('scanner-backdrop');
        this.scannerError = document.getElementById('scanner-error');
        this.scanner = null;

        this._bind();
    }

    _bind() {
        this.closeBtn?.addEventListener('click', () => this.hideModal());
        this.backdrop?.addEventListener('click', () => this.hideModal());
        this.scannerClose?.addEventListener('click', () => this.stopScan());
        this.scannerBackdrop?.addEventListener('click', () => this.stopScan());
    }

    async showRoom(roomId, numericCode) {
        if (!roomId) return;
        this.codeEl.textContent = numericCode || '---';
        const qrContent = `${window.location.origin}?room=${encodeURIComponent(roomId)}`;
        await QRCode.toCanvas(this.canvas, qrContent, { width: 230, margin: 1 });
        this.modal?.classList.remove('hidden');
    }

    hideModal() {
        this.modal?.classList.add('hidden');
    }

    startScan() {
        console.log('[UI] Scan QR button clicked');
        this.scannerModal?.classList.remove('hidden');
        this.scannerError?.classList.add('hidden');

        if (!window.Html5Qrcode) {
            this._setError('QR scanner unavailable');
            return;
        }

        this.scanner = new Html5Qrcode('reader');
        this.scanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 220, height: 220 } },
            (decodedText) => this._handleDecode(decodedText),
            () => {}
        ).catch(() => this._setError('Unable to open camera'));
    }

    stopScan() {
        if (this.scanner) {
            this.scanner.stop().then(() => this.scanner.clear()).catch(() => {});
            this.scanner = null;
        }
        this.scannerModal?.classList.add('hidden');
    }

    _handleDecode(decodedText) {
        try {
            const url = new URL(decodedText);
            const roomId = url.searchParams.get('room');
            if (!roomId) throw new Error('missing room');
            console.log('[QR] room decoded', roomId);
            this.stopScan();
            this.signaling.send('join-room', { room_id: roomId });
        } catch (_) {
            this._setError('Invalid QR code');
        }
    }

    _setError(message) {
        if (!this.scannerError) return;
        this.scannerError.textContent = message;
        this.scannerError.classList.remove('hidden');
    }
}
