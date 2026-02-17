/**
 * ShareX — UI State Module
 * Manages toast notifications, transfer overlay, and UI transitions.
 */

export class UIState {
    constructor() {
        this.toastContainer = document.getElementById('toast-container');
        this.transferOverlay = document.getElementById('transfer-overlay');
        this.transferTitle = document.getElementById('transfer-title');
        this.transferFilename = document.getElementById('transfer-filename');
        this.transferFill = document.getElementById('transfer-progress-fill');
        this.transferPercent = document.getElementById('transfer-percent');
        this.transferSpeed = document.getElementById('transfer-speed');
        this.transferStatus = document.getElementById('transfer-status');
    }

    /**
     * Show a toast notification.
     */
    showToast(message, duration = 3500) {
        if (!this.toastContainer) return;

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        this.toastContainer.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast--exit');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    /**
     * Show transfer overlay.
     */
    showTransfer(filename, status) {
        if (this.transferOverlay) {
            this.transferOverlay.classList.remove('hidden');
        }
        if (this.transferFilename) {
            this.transferFilename.textContent = filename;
        }
        if (this.transferStatus) {
            this.transferStatus.textContent = status;
        }
        this.updateTransferProgress(0);
    }

    /**
     * Hide transfer overlay.
     */
    hideTransfer() {
        if (this.transferOverlay) {
            this.transferOverlay.classList.add('hidden');
        }
        this.updateTransferProgress(0);
    }

    /**
     * Update transfer progress percentage.
     */
    updateTransferProgress(percent) {
        if (this.transferFill) {
            this.transferFill.style.width = percent + '%';
        }
        if (this.transferPercent) {
            this.transferPercent.textContent = Math.round(percent) + '%';
        }
    }

    /**
     * Update transfer speed display.
     */
    updateTransferSpeed(speed) {
        if (this.transferSpeed) {
            this.transferSpeed.textContent = speed;
        }
    }

    /**
     * Update transfer status text.
     */
    updateTransferStatus(status) {
        if (this.transferStatus) {
            this.transferStatus.textContent = status;
        }
    }
}
