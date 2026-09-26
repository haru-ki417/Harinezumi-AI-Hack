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

import json
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from hiring import router as hiring_router
from hiring_live import FRAME_ROI_LOCK, router as hiring_live_router
from interview_speech import router as interview_speech_router

from vital import (
    RoomManager,
    SessionManager,
    VitalState,
    decode_image,
    face_roi_rgb,
    load_settings,
)

# ルームチャット(チームメイト機能)。取り込めない環境でも起動は止めない。
try:  # pragma: no cover - 環境依存
    from chat import router as chat_router  # type: ignore
except Exception:  # noqa: BLE001
    chat_router = None

# FaceMesh(任意/高精度)があれば使い、無ければ Haar 版にフォールバック
try:  # pragma: no cover - 環境依存
    from vital.face_mesh import face_roi_rgb as _mesh_roi  # type: ignore

    def _roi(img, key=None):
        r = _mesh_roi(img)
        return r if r is not None else face_roi_rgb(img, key=key)
except Exception:  # noqa: BLE001
    _roi = face_roi_rgb


settings = load_settings()
manager = SessionManager(settings)
rooms = RoomManager()

app = FastAPI(title="Stealth Vital API", version="3.0.0")
app.include_router(hiring_router)
app.include_router(hiring_live_router)
app.include_router(interview_speech_router)
if chat_router is not None:
    app.include_router(chat_router)
app.add_middleware(
    CORSMiddleware,
    # ローカル開発ではフロントのポートが 3000/3001… と変わるため、
    # localhost / 127.0.0.1 の任意ポートを許可する(どのフロントでも動くように)。
    allow_origins=[settings.cors_origin],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
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
    with FRAME_ROI_LOCK:
        rgb = _roi(img, key=client_id)
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


# ===== 事前質問フォーム(ESを踏まえた深掘り質問と、候補者の事前回答) =====
# room_id -> {"enabled": bool, "questions": [str], "answers": [{"name": str, "answers": [str]}]}
_forms: Dict[str, dict] = {}


class FormQuestions(BaseModel):
    questions: list[str]


class FormAnswers(BaseModel):
    name: str = ""
    answers: list[str]


def _empty_form() -> dict:
    return {"enabled": False, "questions": [], "answers": []}


@app.get("/api/form/{room_id}")
async def get_form(room_id: str) -> dict:
    return _forms.get(room_id, _empty_form())


@app.post("/api/form/{room_id}")
async def set_form(room_id: str, body: FormQuestions) -> dict:
    qs = [q.strip()[:200] for q in body.questions if q.strip()][:20]
    f = _forms.setdefault(room_id, _empty_form())
    f["questions"] = qs
    f["enabled"] = len(qs) > 0
    return f


@app.post("/api/form/{room_id}/answers")
async def submit_answers(room_id: str, body: FormAnswers) -> dict:
    f = _forms.setdefault(room_id, _empty_form())
    ans = [a.strip()[:2000] for a in body.answers]
    name = (body.name or "候補者")[:40]
    # 同名の再回答は上書き、それ以外は追加。
    for entry in f["answers"]:
        if entry.get("name") == name:
            entry["answers"] = ans
            break
    else:
        f["answers"].append({"name": name, "answers": ans})
    return {"ok": True, "count": len(f["answers"])}


# ===== 面接後フィードバック(面接官の評価。候補者に共有可) =====
# room_id -> {rating,strengths,improvements,notes:[{questionId,note}],shared,submitted}
_feedback: Dict[str, dict] = {}


class NoteItem(BaseModel):
    questionId: int = 0
    note: str = ""


class FeedbackBody(BaseModel):
    rating: int = 0
    strengths: str = ""
    improvements: str = ""
    notes: list[NoteItem] = []
    shared: bool = False


def _empty_feedback() -> dict:
    return {"rating": 0, "strengths": "", "improvements": "",
            "notes": [], "shared": False, "submitted": False}


@app.get("/api/feedback/{room_id}")
async def get_feedback(room_id: str) -> dict:
    return _feedback.get(room_id, _empty_feedback())


@app.post("/api/feedback/{room_id}")
async def set_feedback(room_id: str, body: FeedbackBody) -> dict:
    fb = {
        "rating": max(0, min(5, int(body.rating))),
        "strengths": body.strengths.strip()[:4000],
        "improvements": body.improvements.strip()[:4000],
        "notes": [{"questionId": int(n.questionId), "note": n.note.strip()[:2000]}
                  for n in body.notes if n.note.strip()][:30],
        "shared": bool(body.shared),
        "submitted": True,
    }
    _feedback[room_id] = fb
    return fb


# ===== 面接記録の保存(サーバ保存＋手元DL) =====
# 面接ごとに 心拍・ストレス・質問内容・回答時間 などをファイルへ保存する。
# サーバ側では records/ に JSON を1面接1ファイルで書き出し、識別のため
# room_id・sessionId・保存時刻でファイル名を付ける。フロントは同じ record を
# 手元に JSON / CSV でダウンロードできる(records.ts)。
_RECORDS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "records")


def _safe_slug(s: str, fallback: str = "room") -> str:
    """ファイル名に使える安全な文字だけ残す。"""
    slug = re.sub(r"[^0-9A-Za-z_-]+", "-", str(s or "")).strip("-")
    return slug[:48] or fallback


@app.get("/api/records/{room_id}")
async def list_records(room_id: str) -> dict:
    """この room の保存済み面接記録の一覧(ファイル名と概要)。"""
    slug = _safe_slug(room_id)
    items: list[dict] = []
    if os.path.isdir(_RECORDS_DIR):
        prefix = f"{slug}__"
        for fn in sorted(os.listdir(_RECORDS_DIR), reverse=True):
            if not (fn.startswith(prefix) and fn.endswith(".json")):
                continue
            try:
                with open(os.path.join(_RECORDS_DIR, fn), encoding="utf-8") as fh:
                    rec = json.load(fh)
                summary = rec.get("summary") or {}
                items.append({
                    "file": fn,
                    "sessionId": rec.get("sessionId", ""),
                    "savedAt": rec.get("savedAt", ""),
                    "questions": len(rec.get("questions") or summary.get("questions") or []),
                    "participants": len(rec.get("participants") or summary.get("participants") or []),
                })
            except Exception:  # noqa: BLE001
                continue
    return {"room_id": room_id, "count": len(items), "records": items}


@app.post("/api/records/{room_id}")
async def save_record(room_id: str, body: Dict[str, Any]) -> dict:
    """1面接分の記録(summary＋transcript＋form＋feedback など)を JSON で保存。

    body はフロントが組み立てた任意の JSON。識別用に room_id・保存時刻・
    sessionId を付与してから records/ に書き出す。
    """
    os.makedirs(_RECORDS_DIR, exist_ok=True)
    # 保存された面接記録は個人データを含むため Git 管理から除外する
    # (records/ ごと ignore。既存の .gitignore には触れない)。
    gi = os.path.join(_RECORDS_DIR, ".gitignore")
    if not os.path.exists(gi):
        try:
            with open(gi, "w", encoding="utf-8") as fh:
                fh.write("*\n!.gitignore\n")
        except Exception:  # noqa: BLE001
            pass
    now = datetime.now(timezone.utc)
    session_id = str(body.get("sessionId") or uuid.uuid4().hex[:12])
    record = dict(body)
    record["room_id"] = room_id
    record["sessionId"] = session_id
    record["savedAt"] = now.isoformat()

    stamp = now.strftime("%Y%m%d-%H%M%S")
    fname = f"{_safe_slug(room_id)}__{stamp}__{_safe_slug(session_id, 'sess')}.json"
    path = os.path.join(_RECORDS_DIR, fname)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, ensure_ascii=False, indent=2)
    return {"ok": True, "file": fname, "sessionId": session_id, "savedAt": record["savedAt"]}


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


async def _broadcast_msg(room_id: str, payload: dict, except_id: str | None = None) -> None:
    """単発メッセージ(文字起こし・画面共有等)を配信。except_id は除外。"""
    for cid, ws in list(_conns.get(room_id, {}).items()):
        if except_id is not None and cid == except_id:
            continue
        try:
            await ws.send_json(payload)
        except Exception:  # noqa: BLE001
            _unregister(room_id, cid)


@app.websocket("/ws/room/{room_id}")
async def ws_room(ws: WebSocket, room_id: str) -> None:
    await ws.accept()
    client_id = uuid.uuid4().hex[:8]
    joined = False
    presenting = False
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
            elif msg.get("type") == "screen":
                # 画面共有フレームを送信者以外へ中継(名前も付与)。
                img = msg.get("image_base64", "")
                if img:
                    presenting = True
                    m = rooms.get_member(room_id, client_id)
                    await _broadcast_msg(room_id, {
                        "type": "screen",
                        "client_id": client_id,
                        "name": m.name if m else "",
                        "image_base64": img,
                    }, except_id=client_id)
            elif msg.get("type") == "screen_stop":
                presenting = False
                await _broadcast_msg(
                    room_id, {"type": "screen_stop", "client_id": client_id})
            elif msg.get("type") == "leave":
                break
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        if presenting:
            try:
                await _broadcast_msg(
                    room_id, {"type": "screen_stop", "client_id": client_id})
            except Exception:  # noqa: BLE001
                pass
        if joined:
            rooms.leave(room_id, client_id)
            _unregister(room_id, client_id)
            await _broadcast(room_id, force=True)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
