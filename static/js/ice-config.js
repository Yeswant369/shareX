/**
 * ShareX — ICE Configuration Module
 * Fetches ICE servers from the backend.
 * Supports STUN by default, TURN when configured.
 */

let _cachedConfig = null;

/**
 * Fetch ICE configuration from the server.
 * Caches result for the session.
 */
export async function getICEConfig() {
    if (_cachedConfig) return _cachedConfig;

    try {
        const response = await fetch('/ice-config');
        if (!response.ok) throw new Error('Failed to fetch ICE config');

        const data = await response.json();
        _cachedConfig = {
            iceServers: data.iceServers || [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };

        console.log('[ICE] Configuration loaded:', _cachedConfig.iceServers.length, 'servers');
        return _cachedConfig;
    } catch (err) {
        console.warn('[ICE] Fetch failed, using default STUN:', err.message);
        _cachedConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        };
        return _cachedConfig;
    }
}

/**
 * Clear cached ICE config (e.g., on reconnect).
 */
export function clearICECache() {
    _cachedConfig = null;
}
