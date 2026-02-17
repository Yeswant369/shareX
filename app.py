"""
ShareX — P2P File Sharing Signaling Server
Flask + Flask-SocketIO
Handles: signaling, presence, room management, subnet grouping
No file storage. No database. Signaling only.
"""

import os
import time
import random
import string
import logging
from threading import Lock
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_cors import CORS

# ─── Configuration ───────────────────────────────────────────────
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'sharex-secret-key-change-in-prod')

CORS(app, resources={r"/*": {"origins": "*"}})

socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode='eventlet',
    ping_timeout=30,
    ping_interval=15,
    max_http_buffer_size=1024 * 1024,
    logger=False,
    engineio_logger=False
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ─── State Management ────────────────────────────────────────────
thread_lock = Lock()

# Connected peers: { sid: { id, name, subnet, room, timestamp, avatar_seed } }
peers = {}

# Rooms: { room_id: { code, created_at, peers: set() } }
rooms = {}

# Numeric codes: { code: room_id }
numeric_codes = {}

# Subnet groups: { subnet: set(sid) }
subnet_groups = {}

# Room expiration: 30 minutes
ROOM_EXPIRY = 1800

# Cleanup interval: 60 seconds
CLEANUP_INTERVAL = 60


# ─── Helpers ─────────────────────────────────────────────────────
def extract_subnet(ip_address):
    """Extract /24 subnet from IP address for local peer grouping."""
    if ip_address and '.' in ip_address:
        parts = ip_address.split('.')
        if len(parts) == 4:
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
    return 'unknown'


def get_client_ip():
    """Get real client IP, respecting proxy headers."""
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    real_ip = request.headers.get('X-Real-IP', '')
    if real_ip:
        return real_ip.strip()
    return request.remote_addr or '127.0.0.1'


def generate_numeric_code():
    """Generate unique 3-digit numeric code with collision resistance."""
    with thread_lock:
        attempts = 0
        while attempts < 100:
            code = str(random.randint(100, 999))
            if code not in numeric_codes:
                return code
            attempts += 1
        # Fallback to 4-digit if 3-digit space exhausted
        return str(random.randint(1000, 9999))


def generate_room_id():
    """Generate unique room identifier."""
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))


def generate_avatar_seed():
    """Generate a deterministic seed for avatar generation."""
    return random.randint(1, 10000)


def cleanup_expired_rooms():
    """Remove expired rooms and their associated codes."""
    now = time.time()
    expired = []
    with thread_lock:
        for room_id, room_data in rooms.items():
            if now - room_data['created_at'] > ROOM_EXPIRY:
                expired.append(room_id)
        for room_id in expired:
            room_data = rooms.pop(room_id, {})
            code = room_data.get('code')
            if code and code in numeric_codes:
                del numeric_codes[code]
            logger.info(f"Expired room: {room_id}")


def get_subnet_peers(subnet, exclude_sid=None):
    """Get list of peers on the same subnet."""
    result = []
    sids = subnet_groups.get(subnet, set())
    for sid in sids:
        if sid == exclude_sid:
            continue
        peer = peers.get(sid)
        if peer:
            result.append({
                'id': sid,
                'name': peer.get('name', 'Unknown Device'),
                'avatar_seed': peer.get('avatar_seed', 0),
                'timestamp': peer.get('timestamp', 0)
            })
    return result


# ─── Background Cleanup ─────────────────────────────────────────
def background_cleanup():
    """Periodic cleanup task for expired rooms."""
    while True:
        socketio.sleep(CLEANUP_INTERVAL)
        cleanup_expired_rooms()


# ─── HTTP Routes ─────────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')


@app.route('/health')
def health():
    return jsonify({
        'status': 'ok',
        'peers': len(peers),
        'rooms': len(rooms),
        'timestamp': time.time()
    })


@app.route('/ice-config')
def ice_config():
    """Return ICE server configuration. TURN included if env vars set."""
    ice_servers = [
        {'urls': 'stun:stun.l.google.com:19302'}
    ]
    turn_url = os.environ.get('TURN_URL')
    turn_username = os.environ.get('TURN_USERNAME')
    turn_password = os.environ.get('TURN_PASSWORD')
    if turn_url and turn_username and turn_password:
        ice_servers.append({
            'urls': turn_url,
            'username': turn_username,
            'credential': turn_password
        })
    return jsonify({'iceServers': ice_servers})


# ─── SocketIO Events ─────────────────────────────────────────────
@socketio.on('connect')
def handle_connect():
    sid = request.sid
    ip = get_client_ip()
    subnet = extract_subnet(ip)
    avatar_seed = generate_avatar_seed()

    peer_data = {
        'id': sid,
        'name': 'Unknown Device',
        'subnet': subnet,
        'ip': ip,
        'room': None,
        'timestamp': time.time(),
        'avatar_seed': avatar_seed
    }

    with thread_lock:
        peers[sid] = peer_data
        if subnet not in subnet_groups:
            subnet_groups[subnet] = set()
        subnet_groups[subnet].add(sid)

    emit('connected', {
        'id': sid,
        'avatar_seed': avatar_seed,
        'subnet': subnet
    })

    # Broadcast presence to subnet peers
    nearby = get_subnet_peers(subnet, exclude_sid=sid)
    emit('nearby-peers', {'peers': nearby})

    # Notify other subnet peers about new peer
    socketio.emit('peer-joined', {
        'id': sid,
        'name': peer_data['name'],
        'avatar_seed': avatar_seed
    }, room=subnet, skip_sid=sid)

    join_room(subnet)
    logger.info(f"Connected: {sid} from {subnet}")


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    peer = peers.get(sid)
    if not peer:
        return

    subnet = peer.get('subnet', 'unknown')
    room_id = peer.get('room')

    with thread_lock:
        # Remove from subnet group
        if subnet in subnet_groups:
            subnet_groups[subnet].discard(sid)
            if not subnet_groups[subnet]:
                del subnet_groups[subnet]

        # Remove from room
        if room_id and room_id in rooms:
            rooms[room_id]['peers'].discard(sid)
            if not rooms[room_id]['peers']:
                code = rooms[room_id].get('code')
                if code and code in numeric_codes:
                    del numeric_codes[code]
                del rooms[room_id]

        # Remove peer
        del peers[sid]

    # Notify subnet peers
    socketio.emit('peer-left', {'id': sid}, room=subnet)

    # Notify room peers
    if room_id:
        socketio.emit('peer-left', {'id': sid}, room=room_id)

    logger.info(f"Disconnected: {sid}")


@socketio.on('set-name')
def handle_set_name(data):
    sid = request.sid
    name = data.get('name', 'Unknown Device')
    if sid in peers:
        peers[sid]['name'] = name
        subnet = peers[sid].get('subnet', 'unknown')
        socketio.emit('peer-updated', {
            'id': sid,
            'name': name,
            'avatar_seed': peers[sid].get('avatar_seed', 0)
        }, room=subnet, skip_sid=sid)


@socketio.on('create-room')
def handle_create_room(data):
    sid = request.sid
    room_id = generate_room_id()
    code = generate_numeric_code()

    with thread_lock:
        rooms[room_id] = {
            'code': code,
            'created_at': time.time(),
            'peers': {sid}
        }
        numeric_codes[code] = room_id
        if sid in peers:
            peers[sid]['room'] = room_id

    join_room(room_id)
    emit('room-created', {
        'room_id': room_id,
        'code': code
    })
    logger.info(f"Room created: {room_id} (code: {code}) by {sid}")


@socketio.on('join-room')
def handle_join_room(data):
    sid = request.sid
    room_id = data.get('room_id')
    code = data.get('code')

    # Resolve room_id from code if needed
    if not room_id and code:
        room_id = numeric_codes.get(str(code))

    if not room_id or room_id not in rooms:
        emit('join-error', {'message': 'Room not found or expired'})
        return

    room_data = rooms[room_id]

    # Check expiration
    if time.time() - room_data['created_at'] > ROOM_EXPIRY:
        cleanup_expired_rooms()
        emit('join-error', {'message': 'Room has expired'})
        return

    with thread_lock:
        room_data['peers'].add(sid)
        if sid in peers:
            peers[sid]['room'] = room_id

    join_room(room_id)

    # Get existing peers in room
    existing_peers = []
    for peer_sid in room_data['peers']:
        if peer_sid != sid:
            peer = peers.get(peer_sid)
            if peer:
                existing_peers.append({
                    'id': peer_sid,
                    'name': peer.get('name', 'Unknown Device'),
                    'avatar_seed': peer.get('avatar_seed', 0)
                })

    emit('room-joined', {
        'room_id': room_id,
        'peers': existing_peers
    })

    # Notify room about new peer
    peer = peers.get(sid, {})
    socketio.emit('peer-joined', {
        'id': sid,
        'name': peer.get('name', 'Unknown Device'),
        'avatar_seed': peer.get('avatar_seed', 0)
    }, room=room_id, skip_sid=sid)

    logger.info(f"Joined room: {sid} → {room_id}")


@socketio.on('leave-room')
def handle_leave_room(data):
    sid = request.sid
    room_id = data.get('room_id')
    if not room_id:
        peer = peers.get(sid)
        if peer:
            room_id = peer.get('room')

    if room_id and room_id in rooms:
        with thread_lock:
            rooms[room_id]['peers'].discard(sid)
            if sid in peers:
                peers[sid]['room'] = None
        leave_room(room_id)
        socketio.emit('peer-left', {'id': sid}, room=room_id)


# ─── WebRTC Signaling ────────────────────────────────────────────
@socketio.on('offer')
def handle_offer(data):
    target = data.get('target')
    if target:
        emit('offer', {
            'sdp': data.get('sdp'),
            'sender': request.sid,
            'name': peers.get(request.sid, {}).get('name', 'Unknown'),
            'avatar_seed': peers.get(request.sid, {}).get('avatar_seed', 0),
            'file_meta': data.get('file_meta')
        }, room=target)


@socketio.on('answer')
def handle_answer(data):
    target = data.get('target')
    if target:
        emit('answer', {
            'sdp': data.get('sdp'),
            'sender': request.sid
        }, room=target)


@socketio.on('ice-candidate')
def handle_ice_candidate(data):
    target = data.get('target')
    if target:
        emit('ice-candidate', {
            'candidate': data.get('candidate'),
            'sender': request.sid
        }, room=target)


@socketio.on('transfer-accepted')
def handle_transfer_accepted(data):
    target = data.get('target')
    if target:
        emit('transfer-accepted', {
            'sender': request.sid
        }, room=target)


@socketio.on('transfer-rejected')
def handle_transfer_rejected(data):
    target = data.get('target')
    if target:
        emit('transfer-rejected', {
            'sender': request.sid
        }, room=target)


# ─── Start Server ────────────────────────────────────────────────
if __name__ == '__main__':
    socketio.start_background_task(background_cleanup)
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)
