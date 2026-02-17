/**
 * ShareX — Numeric Code Join Module
 * 3-digit code creation and joining.
 */

export class NumericCode {
    constructor(signaling) {
        this.signaling = signaling;
        this.modal = document.getElementById('code-modal');
        this.closeBtn = document.getElementById('code-close');
        this.backdrop = document.getElementById('code-backdrop');
        this.joinBtn = document.getElementById('code-join-btn');
        this.errorEl = document.getElementById('code-error');
        this.digits = [
            document.getElementById('code-digit-1'),
            document.getElementById('code-digit-2'),
            document.getElementById('code-digit-3')
        ];

        this._bindEvents();
    }

    _bindEvents() {
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.hide());
        }
        if (this.backdrop) {
            this.backdrop.addEventListener('click', () => this.hide());
        }

        // Auto-advance digit inputs
        this.digits.forEach((digit, i) => {
            if (!digit) return;

            digit.addEventListener('input', (e) => {
                const val = e.target.value.replace(/\D/g, '');
                e.target.value = val;
                if (val && i < 2) {
                    this.digits[i + 1].focus();
                }
                this._clearError();
            });

            digit.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace' && !e.target.value && i > 0) {
                    this.digits[i - 1].focus();
                }
                if (e.key === 'Enter') {
                    this._submit();
                }
            });

            // Select all on focus
            digit.addEventListener('focus', () => {
                digit.select();
            });
        });

        // Join button
        if (this.joinBtn) {
            this.joinBtn.addEventListener('click', () => this._submit());
        }

        // Handle join error
        this.signaling.on('join-error', (data) => {
            this._showError(data.message || 'Failed to join');
        });

        // Handle successful join
        this.signaling.on('room-joined', () => {
            this.hide();
        });
    }

    /**
     * Show the numeric code modal.
     */
    show() {
        if (this.modal) {
            this.modal.classList.remove('hidden');
        }
        this._clear();
        if (this.digits[0]) {
            setTimeout(() => this.digits[0].focus(), 100);
        }
    }

    /**
     * Hide the numeric code modal.
     */
    hide() {
        if (this.modal) {
            this.modal.classList.add('hidden');
        }
        this._clear();
    }

    _submit() {
        const code = this.digits.map(d => d ? d.value : '').join('');
        if (code.length !== 3 || !/^\d{3}$/.test(code)) {
            this._showError('Enter a valid 3-digit code');
            return;
        }

        this.signaling.send('join-room', { code });
    }

    _clear() {
        this.digits.forEach(d => {
            if (d) d.value = '';
        });
        this._clearError();
    }

    _showError(message) {
        if (this.errorEl) {
            this.errorEl.textContent = message;
            this.errorEl.classList.remove('hidden');
        }
    }

    _clearError() {
        if (this.errorEl) {
            this.errorEl.classList.add('hidden');
        }
    }
}
