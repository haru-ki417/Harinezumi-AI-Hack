"""
同意付き・透明な双方向ルーム。

各参加者は「計測に同意」した上でルームに参加し、自分のバイタルを送る。
サーバは全参加者のバイタルをまとめて全員に配る(=互いに見える=透明)。
同意していない参加は拒否する。

このモジュールはフレームワーク非依存(純データ)。WebSocketの配線は app.py 側。
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class Member:
    client_id: str
    role: str            # 'interviewer' | 'candidate' など
    name: str
    consented: bool
    vitals: dict = field(default_factory=dict)
    joined_at: float = 0.0


class RoomManager:
    def __init__(self) -> None:
        self._rooms: Dict[str, Dict[str, Member]] = {}
        self._lock = threading.Lock()

    def join(self, room_id: str, client_id: str, role: str,
             name: str, consent: bool) -> bool:
        """同意がなければ参加を拒否(False)。"""
        if not consent:
            return False
        with self._lock:
            room = self._rooms.setdefault(room_id, {})
            room[client_id] = Member(
                client_id=client_id, role=role, name=name,
                consented=True, joined_at=time.time(),
            )
        return True

    def leave(self, room_id: str, client_id: str) -> None:
        with self._lock:
            room = self._rooms.get(room_id)
            if room and client_id in room:
                del room[client_id]
                if not room:
                    del self._rooms[room_id]

    def update_vitals(self, room_id: str, client_id: str, vitals: dict) -> None:
        with self._lock:
            room = self._rooms.get(room_id)
            if room and client_id in room:
                room[client_id].vitals = vitals

    def snapshot(self, room_id: str) -> List[dict]:
        """ルーム全員の公開用スナップショット(全員に配る内容)。"""
        with self._lock:
            room = self._rooms.get(room_id, {})
            return [
                {
                    "client_id": m.client_id,
                    "role": m.role,
                    "name": m.name,
                    "vitals": m.vitals,
                }
                for m in sorted(room.values(), key=lambda x: x.joined_at)
            ]

    def member_ids(self, room_id: str) -> List[str]:
        with self._lock:
            return list(self._rooms.get(room_id, {}).keys())

    def count(self, room_id: str) -> int:
        with self._lock:
            return len(self._rooms.get(room_id, {}))
