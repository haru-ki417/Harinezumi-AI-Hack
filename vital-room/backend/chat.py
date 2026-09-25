"""面接前から使えるチャット。バイタル計測とは独立した接続を使用する。"""
from __future__ import annotations

import asyncio
import json
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()
MAX_MESSAGE_LENGTH = 2000
HISTORY_LIMIT = 100


@dataclass
class Peer:
    ws: WebSocket
    name: str
    role: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    sent: OrderedDict = field(default_factory=OrderedDict)


@dataclass
class ChatRoom:
    peers: dict[str, Peer] = field(default_factory=dict)
    history: deque = field(default_factory=lambda: deque(maxlen=HISTORY_LIMIT))


_rooms: dict[str, ChatRoom] = {}


def _remove(room_id: str, room: ChatRoom, client_id: str) -> None:
    room.peers.pop(client_id, None)
    if not room.peers and _rooms.get(room_id) is room:
        _rooms.pop(room_id, None)


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
            await ws.send_json({'type': 'chat_joined', 'client_id': client_id, 'messages': list(room.history)})

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
            if (data.get('type') != 'chat' or not isinstance(request_id, str)
                    or not request_id.strip() or len(request_id) > 64
                    or not isinstance(text, str) or not text.strip() or len(text) > MAX_MESSAGE_LENGTH):
                await _send(peer, {
                    'type': 'chat_error', 'reason': 'invalid_message',
                    'request_id': request_id if isinstance(request_id, str) and len(request_id) <= 64 else None,
                })
                continue
            if request_id in peer.sent:
                await _send(peer, {'type': 'chat_message', 'message': peer.sent[request_id]})
                continue
            message = {
                'id': uuid.uuid4().hex, 'request_id': request_id,
                'sender_id': client_id, 'name': peer.name, 'role': peer.role,
                'text': text.strip(), 'sent_at': datetime.now(timezone.utc).isoformat(),
            }
            peer.sent[request_id] = message
            if len(peer.sent) > HISTORY_LIMIT:
                peer.sent.popitem(last=False)
            room.history.append(message)
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
