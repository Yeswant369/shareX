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
            document.getElementById('code-digit-3'),
        ];
        this._bind();
    }

    _bind() {
        this.closeBtn?.addEventListener('click', () => this.hide());
        this.backdrop?.addEventListener('click', () => this.hide());
        this.joinBtn?.addEventListener('click', () => this.submit());

        this.digits.forEach((input, index) => {
            if (!input) return;
            input.addEventListener('input', () => {
                input.value = input.value.replace(/\D/g, '').slice(0, 1);
                if (input.value && index < this.digits.length - 1) this.digits[index + 1]?.focus();
                this.clearError();
            });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') this.submit();
                if (event.key === 'Backspace' && !input.value && index > 0) this.digits[index - 1]?.focus();
            });
        });

        this.signaling.on('room-joined', () => this.hide());
        this.signaling.on('join-error', (data) => this.showError(data?.message || 'Failed to join room'));
    }

    show() {
        this.modal?.classList.remove('hidden');
        this.clear();
        this.digits[0]?.focus();
    }

    hide() {
        this.modal?.classList.add('hidden');
        this.clear();
    }

    submit() {
        const code = this.digits.map((d) => d?.value || '').join('');
        if (!/^\d{3}$/.test(code)) {
            this.showError('Enter a valid 3-digit code');
            return;
        }
        this.signaling.send('join-room', { code });
    }

    clear() {
        this.digits.forEach((d) => { if (d) d.value = ''; });
        this.clearError();
    }

    showError(message) {
        if (!this.errorEl) return;
        this.errorEl.textContent = message;
        this.errorEl.classList.remove('hidden');
    }

    clearError() {
        this.errorEl?.classList.add('hidden');
    }
}
