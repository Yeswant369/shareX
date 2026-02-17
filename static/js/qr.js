import QRCode from 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm';

export class QRConnect {
    constructor(signaling) {
        this.signaling = signaling;
        this.modal = document.getElementById('pairing-modal');
        this.closeBtn = document.getElementById('pairing-close');
        this.canvas = document.getElementById('pairing-qr-canvas');
        this.codeDisplay = document.getElementById('pairing-code');
        this.scanModal = document.getElementById('scanner-modal');
        this.scanClose = document.getElementById('scanner-close');
        this.scanBackdrop = document.getElementById('scanner-backdrop');
        this.scanError = document.getElementById('scanner-error');
        this.scanner = null;

        this._bindEvents();
    }

    _bindEvents() {
        this.closeBtn?.addEventListener('click', () => this.hideGen());
        this.scanClose?.addEventListener('click', () => this.stopScan());
        this.scanBackdrop?.addEventListener('click', () => this.stopScan());

        this.signaling.on('room-created', async (data) => {
            this.codeDisplay.textContent = data.numeric_code;
            await this._renderQR(data.room_id);
        });
    }

    showGen() {
        this.modal?.classList.remove('hidden');
        this.signaling.send('create-room', {});
    }

    hideGen() {
        this.modal?.classList.add('hidden');
        this.stopScan();
    }

    async _renderQR(roomId) {
        if (!this.canvas) return;
        const url = `${window.location.origin}/?room=${encodeURIComponent(roomId)}`;
        await QRCode.toCanvas(this.canvas, url, {
            width: 220,
            margin: 1,
            errorCorrectionLevel: 'M',
        });
    }

    startScan() {
        this.scanModal?.classList.remove('hidden');
        this.scanError?.classList.add('hidden');

        if (!window.Html5Qrcode) {
            this._showError('Scanner not available in this environment.');
            return;
        }

        this.scanner = new Html5Qrcode('reader');
        this.scanner.start(
            { facingMode: 'environment' },
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (decodedText) => this._onScan(decodedText),
            () => { },
        ).catch(() => this._showError('Unable to access camera.'));
    }

    stopScan() {
        if (this.scanner) {
            this.scanner.stop().then(() => this.scanner.clear()).catch(() => { });
            this.scanner = null;
        }
        this.scanModal?.classList.add('hidden');
    }

    _onScan(decodedText) {
        try {
            const parsed = new URL(decodedText);
            const roomId = parsed.searchParams.get('room');
            if (!roomId) {
                this._showError('Invalid QR code.');
                return;
            }
            this.stopScan();
            this.signaling.send('join-room', { room_id: roomId });
        } catch (_) {
            this._showError('Invalid QR content.');
        }
    }

    _showError(message) {
        if (!this.scanError) return;
        this.scanError.textContent = message;
        this.scanError.classList.remove('hidden');
    }
}
