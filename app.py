"""ShareX signaling server with deterministic 2-peer room lifecycle."""

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

SOCKET_ASYNC_MODE = os.environ.get('SOCKET_ASYNC_MODE', 'threading')
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

thread_lock = Lock()
cleanup_task_started = False

ROOM_EXPIRY = int(os.environ.get('ROOM_EXPIRY_SECONDS', '1800'))
CLEANUP_INTERVAL = int(os.environ.get('CLEANUP_INTERVAL_SECONDS', '60'))
MAX_ROOM_PEERS = 2

ROLE_HOST = 'HOST'
ROLE_JOINER = 'JOINER'
STATE_WAITING = 'waiting'
STATE_READY = 'ready'
STATE_CLOSED = 'closed'

# sid -> peer profile
peers = {}
# room_id -> room model
rooms = {}
# numeric code -> room_id
numeric_codes = {}


def generate_room_id():
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=12))


def generate_numeric_code():
    for _ in range(200):
        code = str(random.randint(100, 999))
        if code not in numeric_codes:
            return code
    return str(random.randint(1000, 9999))


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


def build_peer_view(sid):
    peer = peers.get(sid, {})
    return {
        'id': sid,
        'name': peer.get('name', 'Unknown Device'),
        'avatar_seed': peer.get('avatar_seed', 0),
    }


def room_state_from_count(count):
    if count <= 0:
        return STATE_CLOSED
    if count == 1:
        return STATE_WAITING
    return STATE_READY


def is_room_expired(room):
    return (time.time() - room['created_at']) > ROOM_EXPIRY


def emit_room_state(room_id):
    room = rooms.get(room_id)
    if not room:
        return
    peer_list = list(room['peers'].keys())
    socketio.emit('room-state-update', {
        'room_id': room_id,
        'state': room['state'],
        'host_id': room['host_sid'],
        'peers': [build_peer_view(sid) for sid in peer_list],
    }, room=room_id)


def delete_room(room_id):
    room = rooms.pop(room_id, None)
    if not room:
        return
    numeric_codes.pop(room['numeric_code'], None)
    logger.info('[Room] deleted room=%s code=%s', room_id, room['numeric_code'])


def remove_peer_from_room(sid):
    peer = peers.get(sid)
    if not peer:
        return None

    room_id = peer.get('room_id')
    if not room_id:
        return None

    room = rooms.get(room_id)
    peer['room_id'] = None
    peer['role'] = None

    if not room:
        return None

    room['peers'].pop(sid, None)

    if sid == room['host_sid'] and room['peers']:
        # Deterministic reassignment by join order.
        sorted_by_join = sorted(room['peers'].items(), key=lambda item: item[1]['joined_at'])
        new_host = sorted_by_join[0][0]
        room['host_sid'] = new_host
        room['peers'][new_host]['role'] = ROLE_HOST
        if new_host in peers:
            peers[new_host]['role'] = ROLE_HOST

    count = len(room['peers'])
    if count == 0:
        delete_room(room_id)
        return room_id

    room['state'] = room_state_from_count(count)
    return room_id


def validate_room_membership(sid, room_id):
    room = rooms.get(room_id)
    if not room:
        return False, 'Room not found or expired', None
    if sid not in room['peers']:
        return False, 'You are not a member of this room', room
    return True, None, room


def cleanup_expired_rooms():
    expired = []
    with thread_lock:
        for room_id, room in rooms.items():
            if is_room_expired(room):
                expired.append(room_id)

        for room_id in expired:
            room = rooms.get(room_id)
            if not room:
                continue
            for sid in list(room['peers'].keys()):
                if sid in peers:
                    peers[sid]['room_id'] = None
                    peers[sid]['role'] = None
            room['state'] = STATE_CLOSED
            socketio.emit('room-state-update', {
                'room_id': room_id,
                'state': STATE_CLOSED,
                'host_id': room['host_sid'],
                'peers': [],
            }, room=room_id)
            delete_room(room_id)


def background_cleanup():
    while True:
        socketio.sleep(CLEANUP_INTERVAL)
        cleanup_expired_rooms()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/health')
def health():
    with thread_lock:
        room_count = len(rooms)
        peer_count = len(peers)
    return jsonify({
        'status': 'ok',
        'peers': peer_count,
        'rooms': room_count,
        'async_mode': socketio.async_mode,
        'timestamp': time.time(),
    })


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
def handle_connect():
    global cleanup_task_started

    sid = request.sid
    with thread_lock:
        if not cleanup_task_started:
            socketio.start_background_task(background_cleanup)
            cleanup_task_started = True
            logger.info('[Server] background cleanup task started')

        peers[sid] = {
            'id': sid,
            'name': 'Unknown Device',
            'ip': get_client_ip(),
            'avatar_seed': generate_avatar_seed(),
            'room_id': None,
            'role': None,
            'joined_at': time.time(),
        }

    emit('connected', {
        'id': sid,
        'avatar_seed': peers[sid]['avatar_seed'],
    })
    logger.info('[Peer] connected sid=%s', sid)


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid

    with thread_lock:
        if sid not in peers:
            return
        room_id = remove_peer_from_room(sid)
        peers.pop(sid, None)
        room_exists = bool(room_id and room_id in rooms)

    if room_id and room_exists:
        socketio.emit('peer-left', {'id': sid, 'room_id': room_id}, room=room_id)
        emit_room_state(room_id)
    logger.info('[Peer] disconnected sid=%s room=%s', sid, room_id)


@socketio.on('set-name')
def handle_set_name(data):
    sid = request.sid
    name = (data or {}).get('name', 'Unknown Device').strip() or 'Unknown Device'
    with thread_lock:
        if sid in peers:
            peers[sid]['name'] = name[:40]


@socketio.on('create-room')
def handle_create_room(_data):
    sid = request.sid

    with thread_lock:
        if sid not in peers:
            emit('join-error', {'message': 'Peer not connected'})
            return

        remove_peer_from_room(sid)

        room_id = generate_room_id()
        while room_id in rooms:
            room_id = generate_room_id()
        numeric_code = generate_numeric_code()

        now = time.time()
        rooms[room_id] = {
            'room_id': room_id,
            'numeric_code': numeric_code,
            'host_sid': sid,
            'created_at': now,
            'state': STATE_WAITING,
            'peers': {
                sid: {
                    'role': ROLE_HOST,
                    'joined_at': now,
                }
            },
        }
        numeric_codes[numeric_code] = room_id
        peers[sid]['room_id'] = room_id
        peers[sid]['role'] = ROLE_HOST

    join_room(room_id)
    emit('room-created', {
        'room_id': room_id,
        'numeric_code': numeric_code,
        'code': numeric_code,
        'host_id': sid,
    })
    emit_room_state(room_id)


@socketio.on('join-room')
def handle_join_room(data):
    sid = request.sid
    payload = data or {}
    requested_room_id = payload.get('room_id')
    code = payload.get('code')

    with thread_lock:
        if sid not in peers:
            emit('join-error', {'message': 'Peer not connected'})
            return

        room_id = requested_room_id or numeric_codes.get(str(code))
        room = rooms.get(room_id) if room_id else None

        if not room:
            emit('join-error', {'message': 'Room not found or expired'})
            return
        if is_room_expired(room):
            emit('join-error', {'message': 'Room has expired'})
            delete_room(room_id)
            return

        if sid not in room['peers'] and len(room['peers']) >= MAX_ROOM_PEERS:
            emit('join-error', {'message': 'Room is full'})
            return

        remove_peer_from_room(sid)

        if sid not in room['peers']:
            room['peers'][sid] = {
                'role': ROLE_JOINER,
                'joined_at': time.time(),
            }

        peers[sid]['room_id'] = room_id
        peers[sid]['role'] = room['peers'][sid]['role']
        room['state'] = room_state_from_count(len(room['peers']))

        room_peer_views = [build_peer_view(peer_sid) for peer_sid in room['peers'].keys()]
        host_id = room['host_sid']

    join_room(room_id)
    emit('room-joined', {
        'room_id': room_id,
        'host_id': host_id,
        'numeric_code': room['numeric_code'],
        'code': room['numeric_code'],
        'peers': room_peer_views,
    })
    socketio.emit('peer-joined', {'id': sid, 'room_id': room_id}, room=room_id, skip_sid=sid)
    emit_room_state(room_id)


@socketio.on('leave-room')
def handle_leave_room(_data):
    sid = request.sid

    with thread_lock:
        room_id = peers.get(sid, {}).get('room_id')
        if not room_id:
            return
        remove_peer_from_room(sid)
        room_exists = room_id in rooms

    leave_room(room_id)
    socketio.emit('peer-left', {'id': sid, 'room_id': room_id}, room=room_id)
    if room_exists:
        emit_room_state(room_id)


def forward_signal(event_name, payload):
    sender = request.sid
    data = payload or {}
    target = data.get('target')
    room_id = data.get('room_id') or peers.get(sender, {}).get('room_id')

    if not target or not room_id:
        emit('join-error', {'message': 'Invalid signaling payload'})
        return

    with thread_lock:
        valid, message, room = validate_room_membership(sender, room_id)
        if not valid:
            emit('join-error', {'message': message})
            return
        if target not in room['peers']:
            emit('join-error', {'message': 'Target is not in this room'})
            return

        if event_name == 'offer' and room['host_sid'] != sender:
            emit('join-error', {'message': 'Only host can create offer'})
            return

    body = {
        'room_id': room_id,
        'sender': sender,
    }
    if 'sdp' in data:
        body['sdp'] = data['sdp']
    if 'candidate' in data:
        body['candidate'] = data['candidate']
    if 'file_meta' in data:
        body['file_meta'] = data['file_meta']

    socketio.emit(event_name, body, room=target)


@socketio.on('offer')
def handle_offer(data):
    forward_signal('offer', data)


@socketio.on('answer')
def handle_answer(data):
    forward_signal('answer', data)


@socketio.on('ice-candidate')
def handle_ice_candidate(data):
    forward_signal('ice-candidate', data)


@socketio.on('transfer-accepted')
def handle_transfer_accepted(data):
    forward_signal('transfer-accepted', data)


@socketio.on('transfer-rejected')
def handle_transfer_rejected(data):
    forward_signal('transfer-rejected', data)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    debug = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    logger.info('[Server] starting async_mode=%s port=%s', socketio.async_mode, port)
    socketio.run(app, host='0.0.0.0', port=port, debug=debug, allow_unsafe_werkzeug=True)
