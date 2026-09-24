"""
Stealth Vital API — FastAPI エントリポイント。

単体(セルフモニタリング):
  POST /api/vital   { image_base64 } -> VitalResponse
  WS   /ws/vital     {"image_base64": "..."} を送るたびに VitalResponse
  GET  /health

同意付き・透明な双方向ルーム:
  WS   /ws/room/{room_id}
       1) 最初に {"type":"join","role":"...","name":"...","consent":true} を送る
          (consent が true でなければ拒否)
       2) 以降 {"type":"frame","image_base64":"..."} を送る
       3) サーバは全参加者のバイタルをまとめて全員へ配信
          {"type":"room","participants":[{client_id,role,name,vitals}, ...]}
       全員が同意し、互いのバイタルが見える(=透明)。

起動:  uvicorn app:app --host 0.0.0.0 --port 8000 --reload
依存:  pip install -r requirements.txt
"""
from __future__ import annotations

import time
import uuid
from typing import Dict

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from vital import (
    RoomManager,
    SessionManager,
    VitalState,
    decode_image,
    face_roi_rgb,
    load_settings,
)

# FaceMesh(任意/高精度)があれば使い、無ければ Haar 版にフォールバック
try:  # pragma: no cover - 環境依存
    from vital.face_mesh import face_roi_rgb as _mesh_roi  # type: ignore

    def _roi(img):
        r = _mesh_roi(img)
        return r if r is not None else face_roi_rgb(img)
except Exception:  # noqa: BLE001
    _roi = face_roi_rgb


settings = load_settings()
manager = SessionManager(settings)
rooms = RoomManager()

app = FastAPI(title="Stealth Vital API", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.cors_origin],
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


class VitalRequest(BaseModel):
    image_base64: str


class VitalResponse(BaseModel):
    current_bpm: float
    is_anomalous: bool
    confidence: float = 0.0
    snr_db: float = 0.0
    hrv_rmssd: float = 0.0
    hrv_sdnn: float = 0.0
    stress: float = 0.0
    eff_fps: float = 0.0


def _vitals_for(client_id: str, image_base64: str) -> VitalState:
    img = decode_image(image_base64)
    rgb = _roi(img)
    if rgb is None:
        return manager.peek(client_id)
    return manager.process(client_id, time.monotonic(), rgb)


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "3.0.0"}


@app.post("/api/vital", response_model=VitalResponse)
async def vital(req: VitalRequest, request: Request) -> VitalResponse:
    client_id = request.client.host if request.client else "default"
    return VitalResponse(**_vitals_for(client_id, req.image_base64).as_dict())


@app.websocket("/ws/vital")
async def ws_vital(ws: WebSocket) -> None:
    await ws.accept()
    client_id = ws.client.host if ws.client else "ws-default"
    try:
        while True:
            data = await ws.receive_json()
            image_b64 = data.get("image_base64", "") if isinstance(data, dict) else ""
            st = _vitals_for(client_id, image_b64)
            await ws.send_json(VitalResponse(**st.as_dict()).model_dump())
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


# ===== 同意付き・透明な双方向ルーム =====

# room_id -> {client_id: WebSocket}  (イベントループ内でのみ操作)
_conns: Dict[str, Dict[str, WebSocket]] = {}
_last_bcast: Dict[str, float] = {}
_BCAST_MIN_INTERVAL = 0.1  # 100ms(1参加者あたり最大~10更新/秒)


def _register(room_id: str, client_id: str, ws: WebSocket) -> None:
    _conns.setdefault(room_id, {})[client_id] = ws


def _unregister(room_id: str, client_id: str) -> None:
    conns = _conns.get(room_id)
    if conns and client_id in conns:
        del conns[client_id]
        if not conns:
            _conns.pop(room_id, None)
            _last_bcast.pop(room_id, None)


async def _broadcast(room_id: str, force: bool = False) -> None:
    now = time.monotonic()
    if not force and (now - _last_bcast.get(room_id, 0.0)) < _BCAST_MIN_INTERVAL:
        return
    _last_bcast[room_id] = now
    payload = {
        "type": "room",
        "participants": rooms.snapshot(room_id),
        "topic": rooms.get_topic(room_id),
        "transcribe": rooms.get_transcribe(room_id),
    }
    for cid, ws in list(_conns.get(room_id, {}).items()):
        try:
            await ws.send_json(payload)
        except Exception:  # noqa: BLE001
            _unregister(room_id, cid)


async def _broadcast_msg(room_id: str, payload: dict) -> None:
    """単発メッセージ(文字起こし等)を全員へ配信。"""
    for cid, ws in list(_conns.get(room_id, {}).items()):
        try:
            await ws.send_json(payload)
        except Exception:  # noqa: BLE001
            _unregister(room_id, cid)


@app.websocket("/ws/room/{room_id}")
async def ws_room(ws: WebSocket, room_id: str) -> None:
    await ws.accept()
    client_id = uuid.uuid4().hex[:8]
    joined = False
    try:
        first = await ws.receive_json()
        consent = isinstance(first, dict) and first.get("consent") is True \
            and first.get("type") == "join"
        if not consent:
            await ws.send_json({"type": "error", "reason": "consent_required"})
            await ws.close()
            return

        role = str(first.get("role", "candidate"))[:20]
        name = str(first.get("name", "参加者"))[:40]
        rooms.join(room_id, client_id, role, name, True)
        _register(room_id, client_id, ws)
        joined = True
        await ws.send_json({"type": "joined", "client_id": client_id})
        await _broadcast(room_id, force=True)

        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "frame":
                st = _vitals_for(client_id, msg.get("image_base64", ""))
                rooms.update_vitals(room_id, client_id, st.as_dict())
                await _broadcast(room_id)
            elif msg.get("type") == "topic":
                rooms.set_topic(room_id, str(msg.get("topic", ""))[:120])
                await _broadcast(room_id, force=True)
            elif msg.get("type") == "transcribe":
                # 面接官のみON/OFF可
                if rooms.get_role(room_id, client_id) == "interviewer":
                    rooms.set_transcribe(room_id, bool(msg.get("on")))
                    await _broadcast(room_id, force=True)
            elif msg.get("type") == "transcript":
                text = str(msg.get("text", "")).strip()[:1000]
                if text:
                    m = rooms.get_member(room_id, client_id)
                    seg = {
                        "client_id": client_id,
                        "name": m.name if m else "",
                        "role": m.role if m else "",
                        "text": text,
                        "ts": time.time(),
                    }
                    rooms.add_transcript(room_id, seg)
                    await _broadcast_msg(room_id, {"type": "transcript", "segment": seg})
            elif msg.get("type") == "leave":
                break
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        if joined:
            rooms.leave(room_id, client_id)
            _unregister(room_id, client_id)
            await _broadcast(room_id, force=True)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
