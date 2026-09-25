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
    MAX_TRANSCRIPT = 2000

    def __init__(self) -> None:
        self._rooms: Dict[str, Dict[str, Member]] = {}
        self._topics: Dict[str, str] = {}       # room_id -> 現在の話題/質問
        self._transcribe: Dict[str, bool] = {}  # room_id -> 文字起こしON/OFF
        self._transcripts: Dict[str, List[dict]] = {}  # room_id -> 発話ログ
        self._lock = threading.Lock()

    def set_topic(self, room_id: str, topic: str) -> None:
        with self._lock:
            if room_id in self._rooms:
                self._topics[room_id] = topic

    def get_topic(self, room_id: str) -> str:
        with self._lock:
            return self._topics.get(room_id, "")

    def get_role(self, room_id: str, client_id: str) -> str:
        with self._lock:
            m = self._rooms.get(room_id, {}).get(client_id)
            return m.role if m else ""

    def get_member(self, room_id: str, client_id: str):
        with self._lock:
            return self._rooms.get(room_id, {}).get(client_id)

    def set_transcribe(self, room_id: str, on: bool) -> None:
        with self._lock:
            if room_id in self._rooms:
                self._transcribe[room_id] = bool(on)

    def get_transcribe(self, room_id: str) -> bool:
        with self._lock:
            return self._transcribe.get(room_id, False)

    def add_transcript(self, room_id: str, segment: dict) -> None:
        with self._lock:
            if room_id not in self._rooms:
                return
            log = self._transcripts.setdefault(room_id, [])
            log.append(segment)
            if len(log) > self.MAX_TRANSCRIPT:
                del log[: len(log) - self.MAX_TRANSCRIPT]

    def get_transcript(self, room_id: str) -> List[dict]:
        with self._lock:
            return list(self._transcripts.get(room_id, []))

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
                    self._topics.pop(room_id, None)
                    self._transcribe.pop(room_id, None)
                    self._transcripts.pop(room_id, None)

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
