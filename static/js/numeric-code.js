export class NumericCode {
    constructor(signaling) {
        this.signaling = signaling;
        this.modal = document.getElementById('code-modal');
        this.backdrop = document.getElementById('code-backdrop');
        this.closeBtn = document.getElementById('code-close');
        this.joinBtn = document.getElementById('code-join-btn');
        this.error = document.getElementById('code-error');
        this.inputs = [
            document.getElementById('code-digit-1'),
            document.getElementById('code-digit-2'),
            document.getElementById('code-digit-3'),
        ];

        this._bind();
    }

    _bind() {
        this.backdrop?.addEventListener('click', () => this.hide());
        this.closeBtn?.addEventListener('click', () => this.hide());
        this.joinBtn?.addEventListener('click', () => {
            console.log('[UI] Code join button clicked');
            this.submit();
        });

        this.inputs.forEach((input, index) => {
            if (!input) return;
            input.addEventListener('input', () => {
                input.value = input.value.replace(/\D/g, '').slice(0, 1);
                if (input.value && index < this.inputs.length - 1) this.inputs[index + 1]?.focus();
            });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') this.submit();
                if (event.key === 'Backspace' && !input.value && index > 0) this.inputs[index - 1]?.focus();
            });
        });
    }

    show() {
        this.clear();
        this.modal?.classList.remove('hidden');
        this.inputs[0]?.focus();
    }

    hide() {
        this.modal?.classList.add('hidden');
    }

    submit() {
        const code = this.inputs.map((input) => input?.value || '').join('');
        if (!/^\d{3}$/.test(code)) {
            this.showError('Enter 3 digits');
            return;
        }
        console.log('[Room] join attempt with code', code);
        this.signaling.send('join-room', { code });
    }

    clear() {
        this.inputs.forEach((input) => {
            if (input) input.value = '';
        });
        this.error?.classList.add('hidden');
    }

    showError(message) {
        if (!this.error) return;
        this.error.textContent = message;
        this.error.classList.remove('hidden');
    }
}
