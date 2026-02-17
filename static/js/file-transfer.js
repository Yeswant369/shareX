const CHUNK_SIZE = 128 * 1024;
const RETRY_LIMIT = 3;

export class FileTransfer {
    constructor(webrtc, uiState) {
        this.webrtc = webrtc;
        this.uiState = uiState;
        this.pendingFiles = [];
        this.receiving = null;

        this.webrtc.onMessage((payload) => this._onMessage(payload));
    }

    setPendingFiles(fileList) {
        this.pendingFiles = Array.from(fileList || []);
    }

    async startTransfer() {
        const file = this.pendingFiles[0];
        if (!file) {
            this.uiState.showToast('No file selected');
            return;
        }

        if (!this.webrtc.isReadyForTransfer()) {
            const ok = await this.webrtc.ensureHostOffer({ name: file.name, size: file.size, type: file.type });
            if (!ok) {
                this.uiState.showToast('Connection not ready');
                return;
            }
            await this._waitForDataChannel();
        }

        this.uiState.showTransfer(file.name, 'Sending...');
        await this._sendFileWithRetry(file);
    }

    async _waitForDataChannel(timeoutMs = 12000) {
        const started = Date.now();
        while (!this.webrtc.isReadyForTransfer()) {
            if ((Date.now() - started) > timeoutMs) {
                throw new Error('Timed out waiting for data channel');
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }

    async _sendFileWithRetry(file) {
        for (let attempt = 1; attempt <= RETRY_LIMIT; attempt += 1) {
            try {
                await this._sendFile(file);
                this.pendingFiles = [];
                return;
            } catch (error) {
                console.warn('[Transfer] send failed attempt', attempt, error);
                if (attempt >= RETRY_LIMIT) {
                    this.uiState.updateTransferStatus('Transfer failed');
                    this.uiState.showToast('Transfer failed after retries');
                    throw error;
                }
                this.uiState.updateTransferStatus(`Retrying (${attempt}/${RETRY_LIMIT})...`);
                await new Promise((resolve) => setTimeout(resolve, 400));
            }
        }
    }

    async _sendFile(file) {
        this.webrtc.send(JSON.stringify({
            type: 'file-meta',
            name: file.name,
            size: file.size,
            mimeType: file.type || 'application/octet-stream',
        }));

        let sent = 0;
        while (sent < file.size) {
            const chunk = await file.slice(sent, sent + CHUNK_SIZE).arrayBuffer();
            this.webrtc.send(chunk);
            sent += chunk.byteLength;
            const progress = Math.round((sent / file.size) * 100);
            this.uiState.updateTransferProgress(progress);
            this.uiState.updateTransferStatus(`Sending... ${progress}%`);
        }

        this.webrtc.send(JSON.stringify({ type: 'file-complete' }));
        this.uiState.updateTransferProgress(100);
        this.uiState.updateTransferStatus('Complete');
        this.uiState.showToast(`Sent ${file.name}`);
        setTimeout(() => this.uiState.hideTransfer(), 1000);
    }

    _onMessage(data) {
        if (typeof data === 'string') {
            let msg = null;
            try { msg = JSON.parse(data); } catch (_) { return; }

            if (msg.type === 'file-meta') {
                this.receiving = { meta: msg, chunks: [], received: 0 };
                this.uiState.showTransfer(msg.name, 'Receiving...');
                return;
            }

            if (msg.type === 'file-complete') {
                this._completeReceive();
            }
            return;
        }

        if (data instanceof ArrayBuffer && this.receiving) {
            this.receiving.chunks.push(data);
            this.receiving.received += data.byteLength;
            const progress = Math.round((this.receiving.received / this.receiving.meta.size) * 100);
            this.uiState.updateTransferProgress(Math.min(progress, 100));
            this.uiState.updateTransferStatus(`Receiving... ${Math.min(progress, 100)}%`);
        }
    }

    _completeReceive() {
        if (!this.receiving) return;
        const { meta, chunks } = this.receiving;
        const blob = new Blob(chunks, { type: meta.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = meta.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        this.uiState.updateTransferProgress(100);
        this.uiState.updateTransferStatus('Complete');
        this.uiState.showToast(`Received ${meta.name}`);
        this.receiving = null;
        setTimeout(() => this.uiState.hideTransfer(), 1000);
    }
}
