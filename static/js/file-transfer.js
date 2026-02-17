/**
 * ShareX — File Transfer Module
 * Chunked transfer over WebRTC DataChannel.
 */

const CHUNK_SIZE = 256 * 1024;
const BUFFER_THRESHOLD = 512 * 1024;

export class FileTransfer {
    constructor(webrtc, uiState) {
        this.webrtc = webrtc;
        this.uiState = uiState;
        this.pendingFiles = null;
        this._receiving = {}; // peerId -> { meta, chunks, received, startTime }
        this._sending = {};   // peerId -> { file, offset, startTime, reader, dc }
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
            type: file.type || 'application/octet-stream',
        };

        this._cancelled = false;
        this.uiState.showTransfer(file.name, 'Connecting...');

        const conn = await this.webrtc.createConnection(peerId, fileMeta);
        if (!conn) {
            this.uiState.updateTransferStatus('Waiting for room sync...');
            this.uiState.showToast('Receiver not ready yet');
            return;
        }

        const dc = conn.dc || this.webrtc.getDataChannel(peerId);
        if (!dc) {
            this.uiState.updateTransferStatus('Waiting for data channel...');
            return;
        }

        if (dc.readyState === 'open') {
            this._startSending(peerId, file, dc);
        }

        const rejectListener = (data) => {
            if (data.sender !== peerId) return;
            this.uiState.hideTransfer();
            this.uiState.showToast('Transfer declined');
            this.webrtc.close(peerId);
            this.webrtc.signaling.off('transfer-rejected', rejectListener);
        };
        this.webrtc.signaling.on('transfer-rejected', rejectListener);
    }

    startReceiving(fileMeta) {
        this._cancelled = false;
        this.uiState.showTransfer(fileMeta.name, 'Receiving...');
    }

    cancel() {
        this._cancelled = true;

        Object.keys(this._sending).forEach((peerId) => {
            const sending = this._sending[peerId];
            if (sending?.dc) {
                try {
                    sending.dc.onbufferedamountlow = null;
                } catch (_) { }
            }
            delete this._sending[peerId];
        });

        this._receiving = {};
        this.uiState.hideTransfer();
        this.uiState.showToast('Transfer cancelled');
    }

    _bindWebRTC() {
        this.webrtc.onMessage((peerId, data) => {
            this._onReceiveData(peerId, data);
        });

        this.webrtc.onStateChange((peerId, state) => {
            if (state !== 'connected') return;
            const sending = this._sending[peerId];
            if (!sending) return;
            const dc = this.webrtc.getDataChannel(peerId);
            if (dc?.readyState === 'open') {
                this._pumpSend(peerId);
            }
        });

        this.webrtc.onDataChannel((peerId, dc) => {
            const sending = this._sending[peerId];
            if (!sending) return;
            if (dc.readyState === 'open') {
                this._startSending(peerId, sending.file, dc);
            }
        });
    }

    _startSending(peerId, file, dc) {
        if (this._sending[peerId]?.started) return;

        const transfer = {
            file,
            dc,
            offset: 0,
            startTime: Date.now(),
            started: true,
            metaSent: false,
        };
        this._sending[peerId] = transfer;

        console.log('[Transfer] send start file=', file.name, 'peer=', peerId);
        this.uiState.updateTransferStatus('Sending...');

        try {
            dc.send(JSON.stringify({
                type: 'file-meta',
                name: file.name,
                size: file.size,
                mimeType: file.type,
            }));
            transfer.metaSent = true;
        } catch (err) {
            console.error('[Transfer] failed to send metadata', err);
            this.uiState.updateTransferStatus('Failed to send metadata');
            return;
        }

        this._pumpSend(peerId);
    }

    _pumpSend(peerId) {
        const transfer = this._sending[peerId];
        if (!transfer || this._cancelled) return;

        const { dc, file } = transfer;
        if (!dc || dc.readyState !== 'open') return;

        while (transfer.offset < file.size && dc.bufferedAmount < BUFFER_THRESHOLD) {
            const end = Math.min(file.size, transfer.offset + CHUNK_SIZE);
            const slice = file.slice(transfer.offset, end);

            const reader = new FileReader();
            reader.onload = (e) => {
                if (this._cancelled) return;
                try {
                    dc.send(e.target.result);
                    transfer.offset += e.target.result.byteLength;
                    this._updateSendProgress(transfer.offset, file.size, transfer.startTime);

                    if (transfer.offset >= file.size) {
                        dc.send(JSON.stringify({ type: 'file-complete' }));
                        delete this._sending[peerId];
                        this.pendingFiles = null;
                        this.uiState.updateTransferProgress(100);
                        this.uiState.updateTransferStatus('Complete!');
                        this.uiState.showToast('File sent successfully');
                        setTimeout(() => this.uiState.hideTransfer(), 2000);
                        return;
                    }

                    if (dc.bufferedAmount >= BUFFER_THRESHOLD) {
                        dc.onbufferedamountlow = () => {
                            dc.onbufferedamountlow = null;
                            this._pumpSend(peerId);
                        };
                    } else {
                        this._pumpSend(peerId);
                    }
                } catch (err) {
                    console.error('[Transfer] send chunk failed', err);
                    this.uiState.updateTransferStatus('Transfer error');
                }
            };
            reader.onerror = () => {
                this.uiState.updateTransferStatus('Read error');
            };
            reader.readAsArrayBuffer(slice);
            break;
        }
    }

    _onReceiveData(peerId, data) {
        if (this._cancelled) return;

        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'file-meta') {
                    this._receiving[peerId] = {
                        meta: msg,
                        chunks: [],
                        received: 0,
                        startTime: Date.now(),
                    };
                    this.uiState.showTransfer(msg.name, 'Receiving...');
                    return;
                }

                if (msg.type === 'file-complete') {
                    this._assembleFile(peerId);
                    return;
                }
            } catch (_) {
            }
        }

        if (!(data instanceof ArrayBuffer)) return;

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

    _assembleFile(peerId) {
        const recv = this._receiving[peerId];
        if (!recv) return;

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
        if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`;
        if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
        return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
    }
}
