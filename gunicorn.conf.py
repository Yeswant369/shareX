"""
Gunicorn Configuration for ShareX
Optimized for WebSocket (Flask-SocketIO) on Render
"""

import os

# Bind
bind = f"0.0.0.0:{os.environ.get('PORT', '5000')}"

# Worker class — must be eventlet for SocketIO
worker_class = "eventlet"

# Single worker — required for SocketIO in-memory state
workers = 1

# Timeout
timeout = 120

# Keep alive
keepalive = 5

# Logging
accesslog = "-"
errorlog = "-"
loglevel = "info"

# Graceful restart
graceful_timeout = 30

# Max requests before worker restart (memory leak prevention)
max_requests = 1000
max_requests_jitter = 50
