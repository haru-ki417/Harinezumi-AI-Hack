"""面接中のチャット。バイタル計測とは独立した接続を使用する。"""
from __future__ import annotations

import asyncio
import json
import secrets
import time
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import quote, unquote

from fastapi import APIRouter, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from starlette.requests import ClientDisconnect

router = APIRouter()
MAX_MESSAGE_LENGTH = 2000
HISTORY_LIMIT = 100
MAX_FILE_SIZE = 10 * 1024 * 1024
MAX_ATTACHMENTS = 5
MAX_ROOM_STORAGE = 50 * 1024 * 1024
MAX_STORAGE = 200 * 1024 * 1024
MAX_STORED_FILES = 1000
MAX_PENDING_FILES = 20
MAX_ACTIVE_UPLOADS = 16
PENDING_TTL = 10 * 60
UPLOAD_TIMEOUT = 60


@dataclass
class Peer:
    ws: WebSocket
    name: str
    role: str
    upload_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    sent: OrderedDict = field(default_factory=OrderedDict)


@dataclass
class Attachment:
    id: str
    owner_id: str
    name: str
    data: bytes
    content_type: str
    created_at: float = field(default_factory=time.monotonic)
    references: int = 0

    def metadata(self) -> dict:
        return {'id': self.id, 'name': self.name, 'size': len(self.data), 'content_type': self.content_type}


@dataclass
class Upload:
    owner_id: str
    data: bytearray = field(default_factory=bytearray)


@dataclass
class ChatRoom:
    peers: dict[str, Peer] = field(default_factory=dict)
    history: deque = field(default_factory=lambda: deque(maxlen=HISTORY_LIMIT))
    attachments: dict[str, Attachment] = field(default_factory=dict)
    uploads: dict[str, Upload] = field(default_factory=dict)
    storage: int = 0


_rooms: dict[str, ChatRoom] = {}
_storage = 0
_stored_files = 0
_active_uploads = 0


def _discard_attachment(room: ChatRoom, attachment_id: str) -> None:
    global _storage, _stored_files
    attachment = room.attachments.pop(attachment_id, None)
    if attachment is not None:
        room.storage -= len(attachment.data)
        _storage -= len(attachment.data)
        _stored_files -= 1


def _discard_upload(room: ChatRoom, upload_id: str) -> None:
    global _storage, _stored_files, _active_uploads
    upload = room.uploads.pop(upload_id, None)
    if upload is not None:
        size = len(upload.data)
        room.storage -= size
        _storage -= size
        _stored_files -= 1
        _active_uploads -= 1
        upload.data.clear()


def _expire_pending() -> None:
    cutoff = time.monotonic() - PENDING_TTL
    for room in _rooms.values():
        for attachment_id, attachment in list(room.attachments.items()):
            if not attachment.references and attachment.created_at < cutoff:
                _discard_attachment(room, attachment_id)


def _remove(room_id: str, room: ChatRoom, client_id: str) -> None:
    room.peers.pop(client_id, None)
    for attachment_id, attachment in list(room.attachments.items()):
        if not room.peers or (attachment.owner_id == client_id and not attachment.references):
            _discard_attachment(room, attachment_id)
    for upload_id, upload in list(room.uploads.items()):
        if not room.peers or upload.owner_id == client_id:
            _discard_upload(room, upload_id)
    if not room.peers and _rooms.get(room_id) is room:
        _rooms.pop(room_id, None)


def _session(request: Request, room_id: str) -> tuple[ChatRoom, str]:
    authorization = request.headers.get('authorization', '')
    token = authorization[7:] if authorization.startswith('Bearer ') else ''
    room = _rooms.get(room_id)
    if room is not None and token.isascii():
        for client_id, peer in room.peers.items():
            if secrets.compare_digest(token, peer.upload_token):
                return room, client_id
    raise HTTPException(status_code=401, detail='invalid_session')


def _filename(request: Request) -> str:
    encoded = request.headers.get('x-filename', '')
    try:
        name = unquote(encoded, encoding='utf-8', errors='strict').strip()
    except UnicodeError:
        raise HTTPException(status_code=400, detail='invalid_file') from None
    if (not name or name in ('.', '..') or len(encoded) > 3072 or len(name) > 255
            or any(ord(character) < 32 or ord(character) == 127 or character in '/\\' for character in name)):
        raise HTTPException(status_code=400, detail='invalid_file')
    return name


def _content_type(data: bytes) -> str:
    # Only raster formats with recognized signatures may be displayed as images.
    # Supplied MIME types/extensions must never turn HTML or SVG into active content.
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if data.startswith((b'GIF87a', b'GIF89a')):
        return 'image/gif'
    if len(data) >= 12 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'image/webp'
    if data.startswith(b'%PDF-'):
        return 'application/pdf'
    return 'application/octet-stream'


def _check_capacity(room: ChatRoom, size: int) -> None:
    if size > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail='file_too_large')
    if room.storage + size > MAX_ROOM_STORAGE:
        raise HTTPException(status_code=507, detail='room_storage_full')
    if _storage + size > MAX_STORAGE:
        raise HTTPException(status_code=507, detail='storage_full')


@router.post('/api/chat/{room_id}/attachments', status_code=201)
async def upload_attachment(request: Request, room_id: str) -> dict:
    global _storage, _stored_files, _active_uploads
    room, client_id = _session(request, room_id)
    name = _filename(request)
    _expire_pending()
    length = request.headers.get('content-length')
    if length is not None:
        try:
            size = int(length)
        except ValueError:
            raise HTTPException(status_code=400, detail='invalid_file') from None
        if size <= 0:
            raise HTTPException(status_code=400, detail='invalid_file')
        _check_capacity(room, size)
    pending = sum(attachment.owner_id == client_id and not attachment.references
                  for attachment in room.attachments.values())
    pending += sum(upload.owner_id == client_id for upload in room.uploads.values())
    if pending >= MAX_PENDING_FILES or _active_uploads >= MAX_ACTIVE_UPLOADS:
        raise HTTPException(status_code=429, detail='too_many_attachments')
    if _stored_files >= MAX_STORED_FILES:
        raise HTTPException(status_code=507, detail='storage_full')
    attachment_id = uuid.uuid4().hex
    upload = Upload(owner_id=client_id)
    room.uploads[attachment_id] = upload
    _stored_files += 1
    _active_uploads += 1

    async def receive() -> None:
        global _storage
        async for chunk in request.stream():
            if _rooms.get(room_id) is not room or client_id not in room.peers:
                raise HTTPException(status_code=401, detail='invalid_session')
            if len(upload.data) + len(chunk) > MAX_FILE_SIZE:
                raise HTTPException(status_code=413, detail='file_too_large')
            _check_capacity(room, len(chunk))
            upload.data.extend(chunk)
            room.storage += len(chunk)
            _storage += len(chunk)

    try:
        await asyncio.wait_for(receive(), timeout=UPLOAD_TIMEOUT)
        if _rooms.get(room_id) is not room or client_id not in room.peers:
            raise HTTPException(status_code=401, detail='invalid_session')
        if not upload.data:
            raise HTTPException(status_code=400, detail='invalid_file')
        data = bytes(upload.data)
        attachment = Attachment(attachment_id, client_id, name, data, _content_type(data))
        room.attachments[attachment_id] = attachment
        room.uploads.pop(attachment_id)
        _active_uploads -= 1
        upload.data.clear()
        return attachment.metadata()
    except (asyncio.TimeoutError, ClientDisconnect):
        raise HTTPException(status_code=408, detail='upload_interrupted') from None
    finally:
        _discard_upload(room, attachment_id)


@router.get('/api/chat/{room_id}/attachments/{attachment_id}')
async def download_attachment(request: Request, room_id: str, attachment_id: str) -> Response:
    room, client_id = _session(request, room_id)
    _expire_pending()
    attachment = room.attachments.get(attachment_id)
    if attachment is None or (not attachment.references and attachment.owner_id != client_id):
        raise HTTPException(status_code=404, detail='invalid_file')
    return Response(content=attachment.data, media_type=attachment.content_type, headers={
        'Content-Disposition': "attachment; filename*=UTF-8''" + quote(attachment.name, safe=''),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
    })


@router.delete('/api/chat/{room_id}/attachments/{attachment_id}', status_code=204)
async def delete_attachment(request: Request, room_id: str, attachment_id: str) -> Response:
    room, client_id = _session(request, room_id)
    attachment = room.attachments.get(attachment_id)
    if attachment is None or attachment.owner_id != client_id:
        raise HTTPException(status_code=404, detail='invalid_file')
    if attachment.references:
        raise HTTPException(status_code=409, detail='attachment_in_use')
    _discard_attachment(room, attachment_id)
    return Response(status_code=204)


def _append_message(room: ChatRoom, message: dict) -> None:
    for metadata in message['attachments']:
        room.attachments[metadata['id']].references += 1
    if len(room.history) == HISTORY_LIMIT:
        evicted = room.history[0]
        for metadata in evicted.get('attachments', []):
            attachment = room.attachments.get(metadata['id'])
            if attachment is not None:
                attachment.references -= 1
                if not attachment.references:
                    _discard_attachment(room, attachment.id)
        # Avoid replaying metadata for files that have already left history.
        sender = room.peers.get(evicted['sender_id'])
        if sender is not None:
            sender.sent.pop(evicted['request_id'], None)
    room.history.append(message)


async def _send(peer: Peer, payload: dict) -> None:
    # 複数の送信者が同時に話しても、同じソケットへの書き込みを直列化する。
    async with peer.lock:
        await asyncio.wait_for(peer.ws.send_json(payload), timeout=5)


async def _broadcast(room_id: str, room: ChatRoom, message: dict) -> None:
    async def deliver(client_id: str, peer: Peer) -> None:
        try:
            await _send(peer, {"type": "chat_message", "message": message})
        except Exception:
            _remove(room_id, room, client_id)
            try:
                await peer.ws.close()
            except Exception:
                pass

    await asyncio.gather(*(deliver(cid, peer) for cid, peer in list(room.peers.items())))


@router.websocket('/ws/chat/{room_id}')
async def chat_socket(ws: WebSocket, room_id: str) -> None:
    await ws.accept()
    client_id = uuid.uuid4().hex
    room: ChatRoom | None = None
    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=15)
        if not isinstance(first, dict) or first.get('type') != 'join' or first.get('consent') is not True:
            await ws.send_json({'type': 'chat_error', 'reason': 'consent_required'})
            return
        name = first.get('name')
        role = first.get('role')
        if not isinstance(name, str) or not name.strip() or len(name) > 40 or role not in ('candidate', 'interviewer'):
            await ws.send_json({'type': 'chat_error', 'reason': 'invalid_profile'})
            return
        if not room_id.strip() or len(room_id) > 100:
            await ws.send_json({'type': 'chat_error', 'reason': 'invalid_room'})
            return

        peer = Peer(ws=ws, name=name.strip(), role=role)
        room = _rooms.setdefault(room_id, ChatRoom())
        async with peer.lock:
            room.peers[client_id] = peer
            await ws.send_json({'type': 'chat_joined', 'client_id': client_id,
                                'upload_token': peer.upload_token, 'messages': list(room.history)})

        while client_id in room.peers:
            try:
                data = await ws.receive_json()
            except json.JSONDecodeError:
                await _send(peer, {'type': 'chat_error', 'reason': 'invalid_message'})
                continue
            if not isinstance(data, dict):
                await _send(peer, {'type': 'chat_error', 'reason': 'invalid_message'})
                continue
            if data.get('type') == 'leave':
                break
            request_id = data.get('request_id')
            text = data.get('text')
            attachment_ids = data.get('attachment_ids', [])
            if (data.get('type') != 'chat' or not isinstance(request_id, str)
                    or not request_id.strip() or len(request_id) > 64
                    or not isinstance(text, str) or len(text) > MAX_MESSAGE_LENGTH
                    or not isinstance(attachment_ids, list) or len(attachment_ids) > MAX_ATTACHMENTS
                    or any(not isinstance(identifier, str) for identifier in attachment_ids)
                    or len(set(attachment_ids)) != len(attachment_ids)
                    or (not text.strip() and not attachment_ids)):
                await _send(peer, {
                    'type': 'chat_error', 'reason': 'invalid_message',
                    'request_id': request_id if isinstance(request_id, str) and len(request_id) <= 64 else None,
                })
                continue
            if request_id in peer.sent:
                await _send(peer, {'type': 'chat_message', 'message': peer.sent[request_id]})
                continue
            _expire_pending()
            if any(identifier not in room.attachments or room.attachments[identifier].owner_id != client_id
                   for identifier in attachment_ids):
                await _send(peer, {'type': 'chat_error', 'reason': 'invalid_attachment', 'request_id': request_id})
                continue
            message = {
                'id': uuid.uuid4().hex, 'request_id': request_id,
                'sender_id': client_id, 'name': peer.name, 'role': peer.role,
                'text': text.strip(), 'sent_at': datetime.now(timezone.utc).isoformat(),
                'attachments': [room.attachments[identifier].metadata() for identifier in attachment_ids],
            }
            peer.sent[request_id] = message
            if len(peer.sent) > HISTORY_LIMIT:
                peer.sent.popitem(last=False)
            _append_message(room, message)
            await _broadcast(room_id, room, message)
    except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError):
        pass
    finally:
        if room is not None:
            _remove(room_id, room, client_id)
        try:
            await ws.close()
        except Exception:
            pass
