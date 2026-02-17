"""ShareX signaling server with authoritative deterministic 2-peer rooms."""

import logging
import os
import random
import string
import time
from threading import Lock

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room

app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'sharex-secret-key-change-in-prod')

CORS(app, resources={r"/*": {"origins": "*"}})

socketio = SocketIO(
    app,
    cors_allowed_origins='*',
    async_mode=os.environ.get('SOCKET_ASYNC_MODE', 'threading'),
    ping_timeout=30,
    ping_interval=15,
    logger=False,
    engineio_logger=False,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ROOM_EXPIRY = int(os.environ.get('ROOM_EXPIRY_SECONDS', '1800'))
CLEANUP_INTERVAL = int(os.environ.get('CLEANUP_INTERVAL_SECONDS', '60'))
MAX_ROOM_PEERS = 2

thread_lock = Lock()
cleanup_task_started = False

peers = {}  # sid -> profile
rooms = {}  # room_id -> authoritative room model
numeric_codes = {}  # numeric_code -> room_id


def now_ts():
    return time.time()


def generate_room_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))


def generate_numeric_code():
    for _ in range(100):
        code = f"{random.randint(100, 999)}"
        if code not in numeric_codes:
            return code
    return f"{random.randint(1000, 9999)}"


def generate_avatar_seed():
    return random.randint(1, 10000)


def get_client_ip():
    forwarded = request.headers.get('X-Forwarded-For', '')
    if forwarded:
        return forwarded.split(',')[0].strip()
    real_ip = request.headers.get('X-Real-IP', '')
    if real_ip:
        return real_ip.strip()
    return request.remote_addr or '127.0.0.1'


def room_is_expired(room):
    return (now_ts() - room['created_at']) > ROOM_EXPIRY


def build_peer_view(sid):
    profile = peers.get(sid, {})
    return {
        'id': sid,
        'name': profile.get('name', 'Unknown Device'),
        'avatar_seed': profile.get('avatar_seed', 0),
    }


def room_state_payload(room):
    return {
        'room_id': room['room_id'],
        'host_id': room['host_id'],
        'peers': [build_peer_view(peer_sid) for peer_sid in room['peers']],
    }


def delete_room(room_id):
    room = rooms.pop(room_id, None)
    if not room:
        return
    numeric_codes.pop(room['numeric_code'], None)
    logger.info('[Room] deleted room=%s code=%s', room_id, room['numeric_code'])


def remove_peer_from_room(sid):
    profile = peers.get(sid)
    if not profile:
        return None

    room_id = profile.get('room_id')
    profile['room_id'] = None
    profile['role'] = None

    if not room_id:
        return None

    room = rooms.get(room_id)
    if not room:
        return room_id

    if sid in room['peers']:
        room['peers'].remove(sid)

    if room['offer_from'] == sid:
        room['offer_from'] = None

    if not room['peers']:
        delete_room(room_id)
        return room_id

    # Host leaving closes room for determinism.
    if sid == room['host_id']:
        for peer_sid in list(room['peers']):
            if peer_sid in peers:
                peers[peer_sid]['room_id'] = None
                peers[peer_sid]['role'] = None
        delete_room(room_id)
        return room_id

    return room_id


def validate_room_sender(sid, room_id):
    room = rooms.get(room_id)
    if not room:
        return None, 'Room not found'
    if room_is_expired(room):
        delete_room(room_id)
        return None, 'Room expired'
    if sid not in room['peers']:
        return None, 'Peer is not in room'
    return room, None


def emit_room_state(room_id):
    room = rooms.get(room_id)
    if not room:
        return
    socketio.emit('room-state', room_state_payload(room), room=room_id)


def cleanup_expired_rooms():
    expired = []
    with thread_lock:
        for room_id, room in rooms.items():
            if room_is_expired(room):
                expired.append(room_id)

        for room_id in expired:
            room = rooms.get(room_id)
            if not room:
                continue
            for sid in room['peers']:
                if sid in peers:
                    peers[sid]['room_id'] = None
                    peers[sid]['role'] = None
            delete_room(room_id)


def cleanup_task():
    while True:
        socketio.sleep(CLEANUP_INTERVAL)
        cleanup_expired_rooms()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/health')
def health():
    return jsonify({'status': 'ok', 'rooms': len(rooms), 'peers': len(peers), 'timestamp': now_ts()})


@app.route('/ice-config')
def ice_config():
    ice_servers = [{'urls': 'stun:stun.l.google.com:19302'}]
    turn_url = os.environ.get('TURN_URL')
    turn_username = os.environ.get('TURN_USERNAME')
    turn_password = os.environ.get('TURN_PASSWORD')
    if turn_url and turn_username and turn_password:
        ice_servers.append({'urls': turn_url, 'username': turn_username, 'credential': turn_password})
    return jsonify({'iceServers': ice_servers})


@socketio.on('connect')
def on_connect():
    global cleanup_task_started
    sid = request.sid

    with thread_lock:
        peers[sid] = {
            'id': sid,
            'name': 'Unknown Device',
            'avatar_seed': generate_avatar_seed(),
            'ip': get_client_ip(),
            'room_id': None,
            'role': None,
        }
        if not cleanup_task_started:
            cleanup_task_started = True
            socketio.start_background_task(cleanup_task)

    logger.info('[Peer] connected sid=%s', sid)
    emit('connected', {'id': sid, 'avatar_seed': peers[sid]['avatar_seed']})


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    with thread_lock:
        room_id = remove_peer_from_room(sid)
        peers.pop(sid, None)
        room_exists = bool(room_id and room_id in rooms)

    if room_id and room_exists:
        emit_room_state(room_id)
    logger.info('[Peer] disconnected sid=%s room=%s', sid, room_id)


@socketio.on('set-name')
def on_set_name(data):
    sid = request.sid
    name = (data or {}).get('name', '').strip() or 'Unknown Device'
    with thread_lock:
        if sid in peers:
            peers[sid]['name'] = name[:40]


@socketio.on('create-room')
def on_create_room(_payload):
    sid = request.sid
    logger.info('[Room] create-room requested sid=%s', sid)

    with thread_lock:
        if sid not in peers:
            emit('join-error', {'message': 'Peer not connected'})
            return

        remove_peer_from_room(sid)

        room_id = generate_room_id()
        while room_id in rooms:
            room_id = generate_room_id()
        numeric_code = generate_numeric_code()

        room = {
            'room_id': room_id,
            'numeric_code': numeric_code,
            'host_id': sid,
            'peers': [sid],
            'created_at': now_ts(),
            'offer_from': None,
        }
        rooms[room_id] = room
        numeric_codes[numeric_code] = room_id

        peers[sid]['room_id'] = room_id
        peers[sid]['role'] = 'HOST'

    join_room(room_id)
    emit('room-created', {'room_id': room_id, 'numeric_code': numeric_code, 'host_id': sid})
    emit_room_state(room_id)


@socketio.on('join-room')
def on_join_room(data):
    sid = request.sid
    payload = data or {}
    requested_room_id = payload.get('room_id')
    code = str(payload.get('code', '')).strip()

    logger.info('[Room] join-room requested sid=%s room=%s code=%s', sid, requested_room_id, code)

    with thread_lock:
        if sid not in peers:
            emit('join-error', {'message': 'Peer not connected'})
            return

        room_id = requested_room_id or numeric_codes.get(code)
        room = rooms.get(room_id) if room_id else None

        if not room:
            emit('join-error', {'message': 'Room not found'})
            return
        if room_is_expired(room):
            delete_room(room_id)
            emit('join-error', {'message': 'Room expired'})
            return

        if sid not in room['peers'] and len(room['peers']) >= MAX_ROOM_PEERS:
            emit('join-error', {'message': 'Room is full'})
            return

        remove_peer_from_room(sid)

        if sid not in room['peers']:
            room['peers'].append(sid)

        peers[sid]['room_id'] = room_id
        peers[sid]['role'] = 'HOST' if sid == room['host_id'] else 'JOINER'

    join_room(room_id)
    emit('room-joined', {'room_id': room_id})
    emit_room_state(room_id)


def reject_signal(message):
    emit('signal-error', {'message': message})


def forward_signal(event_name, payload):
    sender = request.sid
    data = payload or {}
    room_id = data.get('room_id') or peers.get(sender, {}).get('room_id')
    target = data.get('target')

    if not room_id or not target:
        reject_signal('Invalid signaling payload')
        return

    with thread_lock:
        room, error = validate_room_sender(sender, room_id)
        if error:
            reject_signal(error)
            return

        if target not in room['peers']:
            reject_signal('Target peer is not in room')
            return

        if len(room['peers']) < 2:
            reject_signal('Room is not ready')
            return

        if event_name == 'offer':
            if sender != room['host_id']:
                reject_signal('Only host can create offer')
                return
            room['offer_from'] = sender

        if event_name == 'answer':
            if room['offer_from'] is None:
                reject_signal('Answer before offer is not allowed')
                return

        if event_name == 'ice-candidate':
            if room['offer_from'] is None:
                reject_signal('ICE before offer is not allowed')
                return

    body = {'room_id': room_id, 'sender': sender}
    if 'sdp' in data:
        body['sdp'] = data['sdp']
    if 'candidate' in data:
        body['candidate'] = data['candidate']
    if 'file_meta' in data:
        body['file_meta'] = data['file_meta']

    logger.info('[Signal] %s room=%s sender=%s target=%s', event_name, room_id, sender, target)
    socketio.emit(event_name, body, room=target)


@socketio.on('offer')
def on_offer(data):
    forward_signal('offer', data)


@socketio.on('answer')
def on_answer(data):
    forward_signal('answer', data)


@socketio.on('ice-candidate')
def on_ice(data):
    forward_signal('ice-candidate', data)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
