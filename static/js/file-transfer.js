/**
 * ShareX — File Transfer Module
 * Handles chunked file transfer over WebRTC DataChannel.
 * 64KB chunks. Progress tracking. Auto-download on completion.
 */

const CHUNK_SIZE = 64 * 1024; // 64KB

export class FileTransfer {
    constructor(webrtc, uiState) {
        this.webrtc = webrtc;
        this.uiState = uiState;
        this.pendingFiles = null;
        this._receiving = {};   // peerId -> { meta, chunks[], received, startTime }
        this._sending = {};     // peerId -> { file, offset, startTime }
        this._cancelled = false;

        this._bindWebRTC();
    }

    setPendingFiles(files) {
        this.pendingFiles = Array.from(files);
    }

    async sendTo(peerId) {
        if (!this.pendingFiles || this.pendingFiles.length === 0) {
            this.uiState.showToast('No files selected');
            return;
        }

        const file = this.pendingFiles[0];
        const fileMeta = {
            name: file.name,
            size: file.size,
            type: file.type || 'application/octet-stream'
        };

        this._cancelled = false;

        this.uiState.showTransfer(file.name, 'Connecting...');

        const conn = await this.webrtc.createConnection(peerId, fileMeta);
        if (!conn) {
            this.uiState.updateTransferStatus('Waiting for receiver to join room...');
            this.uiState.showToast('Receiver not ready yet');
            return;
        }

        const tryStart = () => {
            const dc = this.webrtc.getDataChannel(peerId);
            if (dc && dc.readyState === 'open') {
                this._startSending(peerId, file, dc);
            }
        };

        tryStart();

        const onStateChange = (statePeerId, state) => {
            if (statePeerId === peerId && state === 'connected') {
                tryStart();
            }
        };

        const onRejected = (data) => {
            if (data.sender === peerId) {
                this.uiState.hideTransfer();
                this.uiState.showToast('Transfer declined');
                this.webrtc.close(peerId);
                this.webrtc.offStateChange(onStateChange);
                this.webrtc.signaling.off('transfer-rejected', onRejected);
            }
        };

        this.webrtc.onStateChange(onStateChange);
        this.webrtc.signaling.on('transfer-rejected', onRejected);
    }

    startReceiving(fileMeta) {
        this.uiState.showTransfer(fileMeta.name, 'Receiving...');
        this._cancelled = false;
    }

    cancel() {
        this._cancelled = true;
        this._sending = {};
        this._receiving = {};
        this.uiState.hideTransfer();
        this.uiState.showToast('Transfer cancelled');
    }

    _bindWebRTC() {
        this.webrtc.onMessage((peerId, data) => {
            this._onReceiveData(peerId, data);
        });
    }

    async _startSending(peerId, file, dc) {
        if (this._sending[peerId]) return;

        console.log('[Transfer] Starting send:', file.name, 'to', peerId);
        this.uiState.updateTransferStatus('Sending...');

        const startTime = Date.now();
        let offset = 0;
        const totalSize = file.size;

        const CHUNK_SIZE = 256 * 1024;
        const BUFFER_THRESHOLD = 512 * 1024;

        this._sending[peerId] = { file, offset: 0, startTime };

        const meta = JSON.stringify({
            type: 'file-meta',
            name: file.name,
            size: file.size,
            mimeType: file.type
        });

        try {
            dc.send(meta);
        } catch (e) {
            console.error('[Transfer] Failed to send meta:', e);
            this.uiState.showToast('Connection failed');
            return;
        }

        const reader = new FileReader();

        const readNextChunk = () => {
            if (this._cancelled) {
                delete this._sending[peerId];
                return;
            }

            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = (e) => {
            if (this._cancelled) return;

            if (dc.readyState !== 'open') {
                console.warn('[Transfer] DC closed during transfer');
                this.cancel();
                return;
            }

            try {
                dc.send(e.target.result);
                offset += e.target.result.byteLength;
                this._updateSendProgress(offset, totalSize, startTime);

                if (offset < totalSize) {
                    if (dc.bufferedAmount > BUFFER_THRESHOLD) {
                        dc.onbufferedamountlow = () => {
                            dc.onbufferedamountlow = null;
                            readNextChunk();
                        };
                    } else {
                        readNextChunk();
                    }
                } else {
                    dc.send(JSON.stringify({ type: 'file-complete' }));
                    delete this._sending[peerId];
                    this.uiState.updateTransferProgress(100);
                    this.uiState.updateTransferStatus('Complete!');
                    this.uiState.showToast('File sent successfully');
                    setTimeout(() => this.uiState.hideTransfer(), 2000);
                    this.pendingFiles = null;
                }
            } catch (err) {
                console.error('[Transfer] Send error:', err);
                this.uiState.updateTransferStatus('Error sending');
            }
        };

        reader.onerror = (err) => {
            console.error('[Transfer] Read error:', err);
            this.cancel();
        };

        readNextChunk();
    }

    _onReceiveData(peerId, data) {
        if (this._cancelled) return;

        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);

                if (msg.type === 'file-meta') {
                    console.log('[Transfer] Receiving:', msg.name, msg.size);
                    this._receiving[peerId] = {
                        meta: msg,
                        chunks: [],
                        received: 0,
                        startTime: Date.now()
                    };
                    this.uiState.showTransfer(msg.name, 'Receiving...');
                    return;
                }

                if (msg.type === 'file-complete') {
                    this._assembleFile(peerId);
                    return;
                }
            } catch (e) {
            }
        }

        if (data instanceof ArrayBuffer) {
            const recv = this._receiving[peerId];
            if (!recv) return;

            recv.chunks.push(data);
            recv.received += data.byteLength;

            const progress = Math.min(100, Math.round((recv.received / recv.meta.size) * 100));
            const elapsed = (Date.now() - recv.startTime) / 1000;
            const speed = elapsed > 0 ? recv.received / elapsed : 0;

            this.uiState.updateTransferProgress(progress);
            this.uiState.updateTransferSpeed(this._formatSpeed(speed));
            this.uiState.updateTransferStatus(`Receiving... ${progress}%`);
        }
    }

    _assembleFile(peerId) {
        const recv = this._receiving[peerId];
        if (!recv) return;

        console.log('[Transfer] Assembling file:', recv.meta.name);

        const blob = new Blob(recv.chunks, { type: recv.meta.mimeType || 'application/octet-stream' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = recv.meta.name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        setTimeout(() => URL.revokeObjectURL(url), 30000);
        delete this._receiving[peerId];

        this.uiState.updateTransferProgress(100);
        this.uiState.updateTransferStatus('Complete!');
        this.uiState.showToast(`Received: ${recv.meta.name}`);
        setTimeout(() => this.uiState.hideTransfer(), 2500);
    }

    _updateSendProgress(sent, total, startTime) {
        const progress = Math.min(100, Math.round((sent / total) * 100));
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = elapsed > 0 ? sent / elapsed : 0;

        this.uiState.updateTransferProgress(progress);
        this.uiState.updateTransferSpeed(this._formatSpeed(speed));
        this.uiState.updateTransferStatus(`Sending... ${progress}%`);
    }

    _formatSpeed(bytesPerSecond) {
        if (bytesPerSecond < 1024) return Math.round(bytesPerSecond) + ' B/s';
        if (bytesPerSecond < 1024 * 1024) return (bytesPerSecond / 1024).toFixed(1) + ' KB/s';
        return (bytesPerSecond / (1024 * 1024)).toFixed(1) + ' MB/s';
    }
}
