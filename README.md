# ShareX — P2P File Sharing

Peer-to-peer file sharing across devices. No uploads. No cloud. No servers storing your data. Just direct WebRTC transfer.

## Features

- **One Tap Share** — Auto-detect nearby devices on the same network
- **QR Connect** — Generate & scan QR codes to pair devices
- **Numeric Code** — 3-digit code for quick room joining
- **WebRTC DataChannel** — Direct peer-to-peer transfer, 64KB chunking
- **Cross-Platform** — Works on any device with a modern browser
- **PWA** — Installable on desktop & mobile
- **No Database** — Server handles signaling only

## Architecture

```
┌──────────────┐     WebSocket      ┌──────────────┐
│   Browser A  │◄──── Signaling ───►│   Browser B  │
│  (Sender)    │                    │  (Receiver)  │
└──────┬───────┘                    └──────┬───────┘
       │                                   │
       └──────── WebRTC DataChannel ───────┘
                  (Direct P2P)
```

## Quick Start

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run
python app.py
```

Open `http://localhost:5000` in your browser.

## Deployment (Render)

### Option 1: Blueprint Deploy
1. Push to GitHub
2. Connect repo to Render
3. Render auto-detects `render.yaml`

### Option 2: Manual Deploy
1. Create new **Web Service** on Render
2. **Build Command:** `pip install -r requirements.txt`
3. **Start Command:** `gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:$PORT app:app`

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SECRET_KEY` | Yes | Flask secret key |
| `TURN_URL` | No | TURN server URL for cross-network transfers |
| `TURN_USERNAME` | No | TURN server username |
| `TURN_PASSWORD` | No | TURN server password |

> **Note:** The app works without TURN configured (STUN only). TURN enables transfers between different networks (e.g., WiFi ↔ Mobile Data).

## Project Structure

```
sharex/
├── app.py                    # Flask signaling server
├── requirements.txt          # Python dependencies
├── Procfile                  # Render/Heroku process file
├── render.yaml               # Render blueprint
├── gunicorn.conf.py          # Gunicorn configuration
├── templates/
│   ├── base.html             # Base template
│   └── index.html            # Main application page
└── static/
    ├── css/
    │   ├── base.css          # Design system & reset
    │   ├── layout.css        # Component layouts
    │   ├── hero.css          # Hero section styles
    │   ├── animations.css    # All keyframe animations
    │   ├── mobile.css        # Mobile breakpoint
    │   └── desktop.css       # Desktop breakpoint
    ├── js/
    │   ├── main.js           # App orchestrator
    │   ├── signaling.js      # Socket.IO wrapper
    │   ├── webrtc.js         # WebRTC peer management
    │   ├── ice-config.js     # ICE server configuration
    │   ├── presence.js       # Peer presence tracking
    │   ├── qr.js             # QR code generation
    │   ├── numeric-code.js   # Numeric code join
    │   ├── file-transfer.js  # Chunked file transfer
    │   ├── device-cards.js   # Device card rendering
    │   ├── ui-state.js       # UI state management
    │   └── vibration.js      # Haptic feedback
    ├── components/
    │   ├── hero-section.html
    │   ├── split-layout.html
    │   ├── device-card.html
    │   ├── qr-modal.html
    │   ├── numeric-join.html
    │   └── progress-bar.html
    └── pwa/
        ├── manifest.json
        ├── service-worker.js
        ├── icon-192.svg
        └── icon-512.svg
```

## Tech Stack

- **Backend:** Flask, Flask-SocketIO, Eventlet
- **Frontend:** Vanilla HTML/CSS/JS (ES Modules)
- **Transfer:** WebRTC DataChannel (64KB chunks)
- **Signaling:** Socket.IO over WebSocket
- **PWA:** Service Worker, Web App Manifest

## License

MIT
# shareX
