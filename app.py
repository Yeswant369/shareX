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

SOCKET_ASYNC_MODE = os.environ.get('SOCKET_ASYNC_MODE', 'gevent')
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode=SOCKET_ASYNC_MODE,
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

# Rooms: { room_id: { code, host_sid, created_at, peers: set() } }
rooms = {}

# Numeric codes: { code: room_id }
numeric_codes = {}

# Subnet groups: { subnet: set(sid) }
subnet_groups = {}

ROOM_EXPIRY = 1800
CLEANUP_INTERVAL = 60
MAX_ROOM_PEERS = 2
cleanup_task_started = False


# ─── Helpers ─────────────────────────────────────────────────────
def extract_subnet(ip_address):
    if ip_address and '.' in ip_address:
        parts = ip_address.split('.')
        if len(parts) == 4:
            return f"{parts[0]}.{parts[1]}.{parts[2]}"
    return 'unknown'


def get_client_ip():
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    real_ip = request.headers.get('X-Real-IP', '')
    if real_ip:
        return real_ip.strip()
    return request.remote_addr or '127.0.0.1'


def generate_numeric_code():
    with thread_lock:
        attempts = 0
        while attempts < 100:
            code = str(random.randint(100, 999))
            if code not in numeric_codes:
                return code
            attempts += 1
        return str(random.randint(1000, 9999))


def generate_room_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))


def generate_avatar_seed():
    return random.randint(1, 10000)


def cleanup_expired_rooms():
    now = time.time()
    expired = []
    with thread_lock:
        for room_id, room_data in list(rooms.items()):
            if now - room_data['created_at'] > ROOM_EXPIRY:
                expired.append(room_id)
        for room_id in expired:
            room_data = rooms.pop(room_id, {})
            code = room_data.get('code')
            if code and code in numeric_codes:
                del numeric_codes[code]
            logger.info("[Room] Expired room=%s code=%s peers=%s", room_id, code, list(room_data.get('peers', [])))


def get_subnet_peers(subnet, exclude_sid=None):
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


def remove_peer_from_room(sid):
    peer = peers.get(sid)
    if not peer:
        return None

    room_id = peer.get('room')
    if not room_id or room_id not in rooms:
        peer['room'] = None
        return None

    room_data = rooms.get(room_id)
    room_data['peers'].discard(sid)
    peer['room'] = None

    if room_data['host_sid'] == sid:
        remaining = list(room_data['peers'])
        if remaining:
            new_host = remaining[0]
            room_data['host_sid'] = new_host
            socketio.emit('host-changed', {'room_id': room_id, 'host_id': new_host}, room=room_id)
            logger.info('[Room] host reassigned room=%s host=%s', room_id, new_host)

    if not room_data['peers']:
        code = room_data.get('code')
        if code and code in numeric_codes:
            del numeric_codes[code]
        del rooms[room_id]
        logger.info('[Room] removed empty room=%s', room_id)

    return room_id


def is_room_valid_for_signal(room_id, sender, target):
    if not room_id or room_id not in rooms:
        return False
    room_data = rooms[room_id]
    if sender not in room_data['peers'] or target not in room_data['peers']:
        return False
    return True


# ─── Background Cleanup ─────────────────────────────────────────
def background_cleanup():
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
        'async_mode': socketio.async_mode,
        'timestamp': time.time()
    })


@app.route('/ice-config')
def ice_config():
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
    global cleanup_task_started

    sid = request.sid
    if not cleanup_task_started:
        socketio.start_background_task(background_cleanup)
        cleanup_task_started = True
        logger.info('[Server] background cleanup task started')
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

    nearby = get_subnet_peers(subnet, exclude_sid=sid)
    emit('nearby-peers', {'peers': nearby})

    join_room(subnet)
    logger.info("[Peer] connected sid=%s subnet=%s", sid, subnet)


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    peer = peers.get(sid)
    if not peer:
        return

    subnet = peer.get('subnet', 'unknown')

    with thread_lock:
        if subnet in subnet_groups:
            subnet_groups[subnet].discard(sid)
            if not subnet_groups[subnet]:
                del subnet_groups[subnet]

        room_id = remove_peer_from_room(sid)
        del peers[sid]

    socketio.emit('peer-left', {'id': sid}, room=subnet)
    if room_id:
        socketio.emit('peer-left', {'id': sid}, room=room_id)

    logger.info("[Peer] disconnected sid=%s room=%s", sid, room_id)


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
        remove_peer_from_room(sid)

        rooms[room_id] = {
            'code': code,
            'host_sid': sid,
            'created_at': time.time(),
            'peers': {sid}
        }
        numeric_codes[code] = room_id
        if sid in peers:
            peers[sid]['room'] = room_id

    join_room(room_id)
    emit('room-created', {
        'room_id': room_id,
        'code': code,
        'host_id': sid
    })
    logger.info('[Room] created room=%s code=%s host=%s', room_id, code, sid)


@socketio.on('join-room')
def handle_join_room(data):
    sid = request.sid
    room_id = data.get('room_id')
    code = data.get('code')

    if not room_id and code:
        room_id = numeric_codes.get(str(code))

    if not room_id or room_id not in rooms:
        logger.warning('[Room] join failed sid=%s room=%s code=%s reason=not_found', sid, room_id, code)
        emit('join-error', {'message': 'Room not found or expired'})
        return

    room_data = rooms[room_id]

    if time.time() - room_data['created_at'] > ROOM_EXPIRY:
        cleanup_expired_rooms()
        emit('join-error', {'message': 'Room has expired'})
        return

    with thread_lock:
        if sid in room_data['peers']:
            pass
        elif len(room_data['peers']) >= MAX_ROOM_PEERS:
            emit('join-error', {'message': 'Room is full'})
            logger.warning('[Room] join failed sid=%s room=%s reason=full', sid, room_id)
            return
        else:
            remove_peer_from_room(sid)
            room_data['peers'].add(sid)
            if sid in peers:
                peers[sid]['room'] = room_id

    join_room(room_id)

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
        'code': room_data['code'],
        'host_id': room_data['host_sid'],
        'peers': existing_peers
    })

    peer = peers.get(sid, {})
    socketio.emit('peer-joined', {
        'id': sid,
        'name': peer.get('name', 'Unknown Device'),
        'avatar_seed': peer.get('avatar_seed', 0),
        'room_id': room_id,
        'host_id': room_data['host_sid']
    }, room=room_id, skip_sid=sid)

    logger.info('[Room] joined sid=%s room=%s host=%s peers=%s', sid, room_id, room_data['host_sid'], list(room_data['peers']))


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
            remove_peer_from_room(sid)
        leave_room(room_id)
        socketio.emit('peer-left', {'id': sid}, room=room_id)


# ─── WebRTC Signaling ────────────────────────────────────────────
@socketio.on('offer')
def handle_offer(data):
    sender = request.sid
    target = data.get('target')
    room_id = data.get('room_id') or peers.get(sender, {}).get('room')

    if not target:
        return

    if not is_room_valid_for_signal(room_id, sender, target):
        logger.warning('[Signal] offer dropped invalid sender=%s target=%s room=%s', sender, target, room_id)
        return

    room_data = rooms.get(room_id)
    if room_data and room_data.get('host_sid') != sender:
        logger.warning('[Signal] offer dropped non-host sender=%s room=%s host=%s', sender, room_id, room_data.get('host_sid'))
        return

    emit('offer', {
        'room_id': room_id,
        'sdp': data.get('sdp'),
        'sender': sender,
        'name': peers.get(sender, {}).get('name', 'Unknown'),
        'avatar_seed': peers.get(sender, {}).get('avatar_seed', 0),
        'file_meta': data.get('file_meta')
    }, room=target)
    logger.info('[Signal] offer %s -> %s room=%s', sender, target, room_id)


@socketio.on('answer')
def handle_answer(data):
    sender = request.sid
    target = data.get('target')
    room_id = data.get('room_id') or peers.get(sender, {}).get('room')

    if not target:
        return

    if not is_room_valid_for_signal(room_id, sender, target):
        logger.warning('[Signal] answer dropped invalid sender=%s target=%s room=%s', sender, target, room_id)
        return

    emit('answer', {
        'room_id': room_id,
        'sdp': data.get('sdp'),
        'sender': sender
    }, room=target)
    logger.info('[Signal] answer %s -> %s room=%s', sender, target, room_id)


@socketio.on('ice-candidate')
def handle_ice_candidate(data):
    sender = request.sid
    target = data.get('target')
    room_id = data.get('room_id') or peers.get(sender, {}).get('room')

    if not target:
        return

    if not is_room_valid_for_signal(room_id, sender, target):
        logger.warning('[Signal] ice dropped invalid sender=%s target=%s room=%s', sender, target, room_id)
        return

    emit('ice-candidate', {
        'room_id': room_id,
        'candidate': data.get('candidate'),
        'sender': sender
    }, room=target)


@socketio.on('transfer-accepted')
def handle_transfer_accepted(data):
    sender = request.sid
    target = data.get('target')
    room_id = peers.get(sender, {}).get('room')

    if target and is_room_valid_for_signal(room_id, sender, target):
        emit('transfer-accepted', {
            'room_id': room_id,
            'sender': sender
        }, room=target)


@socketio.on('transfer-rejected')
def handle_transfer_rejected(data):
    sender = request.sid
    target = data.get('target')
    room_id = peers.get(sender, {}).get('room')

    if target and is_room_valid_for_signal(room_id, sender, target):
        emit('transfer-rejected', {
            'room_id': room_id,
            'sender': sender
        }, room=target)


# ─── Start Server ────────────────────────────────────────────────
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    logger.info('[Server] starting async_mode=%s port=%s', socketio.async_mode, port)
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)
