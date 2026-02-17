/**
 * ShareX — Vibration Module
 * Subtle haptic feedback for mobile interactions.
 */

export class Vibration {
    constructor() {
        this.supported = 'vibrate' in navigator;
    }

    /**
     * Short tap feedback.
     */
    tap() {
        if (this.supported) {
            navigator.vibrate(15);
        }
    }

    /**
     * Notification feedback (longer).
     */
    notify() {
        if (this.supported) {
            navigator.vibrate([30, 50, 30]);
        }
    }

    /**
     * Success feedback.
     */
    success() {
        if (this.supported) {
            navigator.vibrate([15, 30, 15, 30, 15]);
        }
    }

    /**
     * Error feedback.
     */
    error() {
        if (this.supported) {
            navigator.vibrate([100, 50, 100]);
        }
    }
}
