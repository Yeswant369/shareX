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
    cors_allowed_origins='*',
    async_mode=SOCKET_ASYNC_MODE,
    ping_timeout=30,
    ping_interval=15,
    max_http_buffer_size=1024 * 1024,
    logger=False,
    engineio_logger=False,
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


def get_room_peer_payload(room_id):
    room_data = rooms.get(room_id)
    if not room_data:
        return []

    payload = []
    for peer_sid in room_data['peers']:
        peer_data = peers.get(peer_sid, {})
        payload.append({
            'id': peer_sid,
            'name': peer_data.get('name', 'Unknown Device'),
            'avatar_seed': peer_data.get('avatar_seed', 0),
        })
    return payload


def emit_room_state(room_id):
    room_data = rooms.get(room_id)
    if not room_data:
        return

    payload = {
        'room_id': room_id,
        'host_id': room_data['host_sid'],
        'code': room_data.get('code'),
        'peers': get_room_peer_payload(room_id),
    }
    socketio.emit('room-state', payload, room=room_id)


def remove_room(room_id):
    room_data = rooms.pop(room_id, None)
    if not room_data:
        return

    code = room_data.get('code')
    if code in numeric_codes and numeric_codes.get(code) == room_id:
        del numeric_codes[code]

    for sid in list(room_data.get('peers', [])):
        if sid in peers:
            peers[sid]['room'] = None

    logger.info('[Room] removed room=%s host=%s code=%s', room_id, room_data.get('host_sid'), code)


def cleanup_expired_rooms():
    now = time.time()
    expired = []

    with thread_lock:
        for room_id, room_data in list(rooms.items()):
            if now - room_data['created_at'] > ROOM_EXPIRY:
                expired.append(room_id)

        for room_id in expired:
            room_data = rooms.get(room_id)
            logger.info(
                '[Room] expired room=%s host=%s peers=%s',
                room_id,
                room_data.get('host_sid') if room_data else None,
                list(room_data.get('peers', [])) if room_data else []
            )
            remove_room(room_id)


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

    room_data = rooms[room_id]
    room_data['peers'].discard(sid)
    peer['room'] = None

    if not room_data['peers']:
        remove_room(room_id)
        return room_id

    if room_data['host_sid'] == sid:
        new_host = next(iter(room_data['peers']))
        room_data['host_sid'] = new_host
        socketio.emit('host-changed', {'room_id': room_id, 'host_id': new_host}, room=room_id)
        logger.info('[Room] host-changed room=%s host=%s', room_id, new_host)

    emit_room_state(room_id)
    return room_id


def is_room_valid_for_signal(room_id, sender, target):
    if not room_id or room_id not in rooms:
        return False

    room_data = rooms[room_id]
    return sender in room_data['peers'] and target in room_data['peers']


def room_for_sid(sid):
    return peers.get(sid, {}).get('room')


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
    ice_servers = [{'urls': 'stun:stun.l.google.com:19302'}]

    turn_url = os.environ.get('TURN_URL')
    turn_username = os.environ.get('TURN_USERNAME')
    turn_password = os.environ.get('TURN_PASSWORD')
    if turn_url and turn_username and turn_password:
        ice_servers.append({
            'urls': turn_url,
            'username': turn_username,
            'credential': turn_password,
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
        logger.info('[Server] cleanup task started')

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
        'avatar_seed': avatar_seed,
    }

    with thread_lock:
        peers[sid] = peer_data
        subnet_groups.setdefault(subnet, set()).add(sid)

    emit('connected', {'id': sid, 'avatar_seed': avatar_seed, 'subnet': subnet})
    emit('nearby-peers', {'peers': get_subnet_peers(subnet, exclude_sid=sid)})

    join_room(subnet)
    logger.info('[Peer] connected sid=%s subnet=%s', sid, subnet)


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
        peers.pop(sid, None)

    socketio.emit('peer-left', {'id': sid}, room=subnet)
    if room_id:
        socketio.emit('peer-left', {'id': sid}, room=room_id)

    logger.info('[Room] leave sid=%s room=%s', sid, room_id)


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

        room_id = peers[sid].get('room')
        if room_id:
            emit_room_state(room_id)


@socketio.on('create-room')
def handle_create_room(_data):
    sid = request.sid
    room_id = generate_room_id()

    with thread_lock:
        remove_peer_from_room(sid)

        code = generate_numeric_code()
        rooms[room_id] = {
            'code': code,
            'host_sid': sid,
            'created_at': time.time(),
            'peers': {sid},
        }
        numeric_codes[code] = room_id
        if sid in peers:
            peers[sid]['room'] = room_id

    join_room(room_id)

    emit('room-created', {'room_id': room_id, 'code': code, 'host_id': sid})
    emit_room_state(room_id)
    logger.info('[Room] create room=%s host=%s code=%s', room_id, sid, code)


@socketio.on('join-room')
def handle_join_room(data):
    sid = request.sid
    requested_room_id = data.get('room_id')
    code = data.get('code')

    room_id = requested_room_id
    if not room_id and code:
        room_id = numeric_codes.get(str(code))

    if not room_id or room_id not in rooms:
        logger.warning('[Room] join failed sid=%s room=%s code=%s reason=not_found', sid, room_id, code)
        emit('join-error', {'message': 'Room not found or expired'})
        return

    room_data = rooms[room_id]

    if time.time() - room_data['created_at'] > ROOM_EXPIRY:
        with thread_lock:
            remove_room(room_id)
        emit('join-error', {'message': 'Room has expired'})
        return

    with thread_lock:
        room_data = rooms.get(room_id)
        if not room_data:
            emit('join-error', {'message': 'Room not found or expired'})
            return

        if sid not in room_data['peers']:
            if len(room_data['peers']) >= MAX_ROOM_PEERS:
                logger.warning('[Room] join failed sid=%s room=%s reason=full', sid, room_id)
                emit('join-error', {'message': 'Room is full'})
                return

            remove_peer_from_room(sid)
            room_data['peers'].add(sid)
            if sid in peers:
                peers[sid]['room'] = room_id

    join_room(room_id)

    emit('room-joined', {
        'room_id': room_id,
        'host_id': rooms[room_id]['host_sid'],
        'peers': [p for p in get_room_peer_payload(room_id) if p['id'] != sid],
    })

    socketio.emit('peer-joined', {
        'id': sid,
        'name': peers.get(sid, {}).get('name', 'Unknown Device'),
        'avatar_seed': peers.get(sid, {}).get('avatar_seed', 0),
        'room_id': room_id,
        'host_id': rooms[room_id]['host_sid'],
    }, room=room_id, skip_sid=sid)

    emit_room_state(room_id)
    logger.info('[Room] join room=%s host=%s sid=%s peers=%s', room_id, rooms[room_id]['host_sid'], sid, list(rooms[room_id]['peers']))


@socketio.on('leave-room')
def handle_leave_room(data):
    sid = request.sid
    room_id = data.get('room_id') or room_for_sid(sid)

    if room_id and room_id in rooms:
        with thread_lock:
            remove_peer_from_room(sid)
        leave_room(room_id)
        socketio.emit('peer-left', {'id': sid}, room=room_id)
        logger.info('[Room] leave room=%s sid=%s host=%s', room_id, sid, rooms.get(room_id, {}).get('host_sid'))


# ─── WebRTC Signaling ────────────────────────────────────────────
@socketio.on('offer')
def handle_offer(data):
    sender = request.sid
    target = data.get('target')
    room_id = data.get('room_id') or room_for_sid(sender)

    if not target:
        return

    if not is_room_valid_for_signal(room_id, sender, target):
        logger.warning('[Signal] reject offer sender=%s target=%s room=%s reason=cross-room', sender, target, room_id)
        return

    room_data = rooms[room_id]
    if room_data['host_sid'] != sender:
        logger.warning('[Signal] reject offer sender=%s room=%s reason=non-host host=%s', sender, room_id, room_data['host_sid'])
        return

    emit('offer', {
        'room_id': room_id,
        'sender': sender,
        'name': peers.get(sender, {}).get('name', 'Unknown Device'),
        'avatar_seed': peers.get(sender, {}).get('avatar_seed', 0),
        'sdp': data.get('sdp'),
        'file_meta': data.get('file_meta'),
    }, room=target)
    logger.info('[Signal] offer room=%s sender=%s target=%s', room_id, sender, target)


@socketio.on('answer')
def handle_answer(data):
    sender = request.sid
    target = data.get('target')
    room_id = data.get('room_id') or room_for_sid(sender)

    if not target:
        return

    if not is_room_valid_for_signal(room_id, sender, target):
        logger.warning('[Signal] reject answer sender=%s target=%s room=%s reason=cross-room', sender, target, room_id)
        return

    emit('answer', {
        'room_id': room_id,
        'sender': sender,
        'sdp': data.get('sdp'),
    }, room=target)
    logger.info('[Signal] answer room=%s sender=%s target=%s', room_id, sender, target)


@socketio.on('ice-candidate')
def handle_ice_candidate(data):
    sender = request.sid
    target = data.get('target')
    room_id = data.get('room_id') or room_for_sid(sender)

    if not target:
        return

    if not is_room_valid_for_signal(room_id, sender, target):
        logger.warning('[Signal] reject ice sender=%s target=%s room=%s reason=cross-room', sender, target, room_id)
        return

    emit('ice-candidate', {
        'room_id': room_id,
        'sender': sender,
        'candidate': data.get('candidate'),
    }, room=target)


@socketio.on('transfer-accepted')
def handle_transfer_accepted(data):
    sender = request.sid
    target = data.get('target')
    room_id = room_for_sid(sender)

    if target and is_room_valid_for_signal(room_id, sender, target):
        emit('transfer-accepted', {'room_id': room_id, 'sender': sender}, room=target)


@socketio.on('transfer-rejected')
def handle_transfer_rejected(data):
    sender = request.sid
    target = data.get('target')
    room_id = room_for_sid(sender)

    if target and is_room_valid_for_signal(room_id, sender, target):
        emit('transfer-rejected', {'room_id': room_id, 'sender': sender}, room=target)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    logger.info('[Server] starting async_mode=%s port=%s', socketio.async_mode, port)
    socketio.run(app, host='0.0.0.0', port=port, debug=debug)
