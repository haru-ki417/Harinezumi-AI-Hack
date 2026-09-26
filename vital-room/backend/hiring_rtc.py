"""Authenticated, short-lived TURN configuration for cross-network WebRTC."""
import base64
import hashlib
import hmac
import os
import time


def ice_servers(invitation_id: str, role: str) -> list[dict]:
    servers = [{'urls': 'stun:stun.l.google.com:19302'}]
    urls = [url.strip() for url in os.environ.get('HIRING_TURN_URLS', '').split(',')
            if url.strip().startswith(('turn:', 'turns:'))]
    secret = os.environ.get('HIRING_TURN_SECRET', '')
    if urls and secret:
        username = f'{int(time.time()) + 10800}:{invitation_id}:{role}'
        credential = base64.b64encode(hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()).decode()
        servers.append({'urls': urls, 'username': username, 'credential': credential})
    return servers
