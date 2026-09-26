"""Authenticated signaling for applicant-specific human interviews.

Media travels peer to peer. Transcript text and separately consented estimates are persisted.
Run a single API worker: signaling peers, like legacy rooms, are process local.
"""
from __future__ import annotations

import asyncio
import base64
import json
import math
import logging
import threading
import time
from collections import deque
from dataclasses import dataclass, field

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from hiring import access_session, active_human_peer, append_human_turn, save_human_measurement
from vital import SessionManager, decode_image, face_roi_rgb, load_settings
from hiring_rtc import ice_servers

try:
    from vital.face_mesh import face_roi_rgb as _mesh_roi
except Exception:
    _mesh_roi = None

router = APIRouter()
MAX_FRAME_BASE64 = 128000
MAX_FRAME_SIDE = 640
MAX_FRAME_PIXELS = 640 * 480
MAX_FRAME_FPS = 25
MAX_FRAME_WORKERS = 2
MAX_PENDING_FRAMES = 8
MAX_FRAME_AGE = 1.0
FRAME_TIMEOUT = 3
VITAL_BROADCAST_INTERVAL = 0.2
# 確定計測が途切れてから表示に直近値を保持し続ける最大秒数(点滅防止)。
VITAL_HOLD_SECONDS = 3.0
# The legacy endpoint shares the optional MediaPipe instance; app.py uses this
# same lock around its ROI call. Per-connection SessionManagers remain separate.
FRAME_ROI_LOCK = threading.Lock()
_frame_workers: set[asyncio.Task] = set()


@dataclass
class Peer:
    ws: WebSocket
    token: str
    role: str
    name: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    vital_consent: bool = False
    save_summary: bool = False
    last_persisted: float = 0.0
    vital_epoch: int = 0
    vital_manager: SessionManager | None = None
    last_frame: float = 0.0
    last_vital_broadcast: float = 0.0
    frame_task: asyncio.Task | None = None
    pending_frames: deque = field(default_factory=deque)
    capture_offset: float | None = None
    last_capture: float | None = None
    last_diagnostic: float = 0.0
    # 直近に「確定」した計測時刻。確定/非確定が細かく交互になっても、この時刻から
    # HOLD 秒間は直近値を保持して表示の点滅を防ぐ(本当に途切れたら空にする)。
    last_valid_measure: float = float("-inf")
    last_valid_stress: float = float("-inf")
    presenting: bool = False  # 画面共有中か(切断時に相手へ停止を通知するため)

    async def send(self, payload: dict, guard=None) -> None:
        async with self.lock:
            if guard is not None and not guard():
                return
            await self.ws.send_json(payload)


_peers: dict[str, dict[str, Peer]] = {}


def _reset_vitals(peer: Peer) -> bool:
    enabled = peer.vital_consent
    peer.vital_consent = False
    peer.save_summary = False
    peer.last_persisted = 0
    peer.vital_epoch += 1
    peer.vital_manager = None
    peer.last_frame = 0
    peer.last_vital_broadcast = 0
    peer.pending_frames.clear()
    peer.capture_offset = peer.last_capture = None
    peer.last_valid_measure = peer.last_valid_stress = float('-inf')
    return enabled


async def _clear_vitals(invitation_id: str, peer: Peer) -> None:
    if not _reset_vitals(peer):
        return
    for recipient in list(_peers.get(invitation_id, {}).values()):
        try:
            access_session(invitation_id, recipient.token)
            await recipient.send({"type": "vitals_clear", "client_id": peer.role, "role": peer.role})
        except (HTTPException, RuntimeError, WebSocketDisconnect, OSError):
            pass


def _active_peer(invitation_id: str, peer: Peer) -> bool:
    if _peers.get(invitation_id, {}).get(peer.role) is not peer:
        return False
    try:
        return active_human_peer(invitation_id, peer.token, peer.role)
    except HTTPException:
        return False


def _jpeg_dimensions(encoded: str) -> None:
    """Check JPEG dimensions before OpenCV allocates a decoded image."""
    if encoded.startswith("data:"):
        if not encoded.startswith("data:image/jpeg;base64,"):
            raise ValueError("JPEG required")
        encoded = encoded.split(",", 1)[1]
    raw = base64.b64decode(encoded, validate=True)
    if not raw.startswith(b"\xff\xd8"):
        raise ValueError("JPEG required")
    offset = 2
    while offset + 3 < len(raw):
        if raw[offset] != 0xFF:
            raise ValueError("invalid JPEG marker")
        while offset < len(raw) and raw[offset] == 0xFF:
            offset += 1
        marker = raw[offset]
        offset += 1
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            continue
        length = int.from_bytes(raw[offset:offset + 2], "big")
        if length < 2 or offset + length > len(raw):
            raise ValueError("invalid JPEG segment")
        if marker in {0xC0, 0xC1, 0xC2}:
            if length < 8:
                raise ValueError("invalid JPEG dimensions")
            height = int.from_bytes(raw[offset + 3:offset + 5], "big")
            width = int.from_bytes(raw[offset + 5:offset + 7], "big")
            if not 1 <= width <= MAX_FRAME_SIDE or not 1 <= height <= MAX_FRAME_SIDE or width * height > MAX_FRAME_PIXELS:
                raise ValueError("frame dimensions exceed limit")
            return
        if marker == 0xDA:
            break
        offset += length
    raise ValueError("JPEG dimensions missing")


def _analyze_frame(manager: SessionManager, role: str, encoded: str, received_at: float) -> dict:
    _jpeg_dimensions(encoded)
    image = decode_image(encoded)
    if image is None or image.size == 0 or image.shape[0] * image.shape[1] > MAX_FRAME_PIXELS:
        raise ValueError("invalid frame")
    with FRAME_ROI_LOCK:
        rgb = _mesh_roi(image) if _mesh_roi is not None else None
        if rgb is None:
            rgb = face_roi_rgb(image, key=manager.roi_key)
    return (manager.peek(role) if rgb is None else manager.process(role, received_at, rgb)).as_dict()


async def _frame_result(invitation_id: str, peer: Peer, epoch: int, worker: asyncio.Task) -> None:
    def allowed(recipient: Peer) -> bool:
        return (peer.vital_consent and peer.vital_epoch == epoch
                and _active_peer(invitation_id, peer) and _active_peer(invitation_id, recipient))
    try:
        values = await asyncio.wait_for(asyncio.shield(worker), FRAME_TIMEOUT)
        values = dict(values)
        hold_now = time.monotonic()
        if hold_now - peer.last_diagnostic >= 10:
            peer.last_diagnostic = hold_now
            logging.getLogger('uvicorn.error').info(
                'Vital pipeline: status=%s fps=%s buffered_seconds=%s queue=%d',
                values.get('measurement_status', 'unknown'), values.get('eff_fps', 0),
                values.get('signal_seconds', 0), len(peer.pending_frames))
        # 確定フレームでは直近有効時刻を更新し、値をそのまま表示。非確定でも
        # HOLD 秒以内なら直近の心拍値を保持(点滅防止)、それを超えたら空にする。
        if values.get("measurement_valid") is True:
            peer.last_valid_measure = hold_now
        else:
            values["measurement_valid"] = False
            values["is_anomalous"] = False
            if hold_now - peer.last_valid_measure > VITAL_HOLD_SECONDS:
                values["current_bpm"] = 0.0
        if values.get("stress_valid") is True:
            peer.last_valid_stress = hold_now
        else:
            values["stress_valid"] = False
            if hold_now - peer.last_valid_stress > VITAL_HOLD_SECONDS:
                values["stress"] = 0.0
        if not peer.vital_consent or peer.vital_epoch != epoch:
            return
        if not _active_peer(invitation_id, peer):
            await _clear_vitals(invitation_id, peer)
            return
        now = time.monotonic()
        if now - peer.last_vital_broadcast < VITAL_BROADCAST_INTERVAL:
            return
        peer.last_vital_broadcast = now
        if peer.save_summary and values.get('measurement_valid') is True and now - peer.last_persisted >= 1:
            save_human_measurement(invitation_id, peer.token, values)
            peer.last_persisted = now
        for recipient in list(_peers.get(invitation_id, {}).values()):
            try:
                await recipient.send({"type": "vitals", "client_id": peer.role,
                                      "role": peer.role, "name": peer.name, "vitals": values},
                                     guard=lambda recipient=recipient: allowed(recipient))
            except (RuntimeError, WebSocketDisconnect, OSError):
                pass
    except asyncio.TimeoutError:
        if peer.vital_epoch == epoch:
            await _clear_vitals(invitation_id, peer)
    except Exception:
        if peer.vital_consent and peer.vital_epoch == epoch and _active_peer(invitation_id, peer):
            await peer.send({"type": "error", "message": "計測画像を読み取れませんでした。カメラを確認してください。", "status": 422, "feature": "vitals"})
    finally:
        if peer.frame_task is asyncio.current_task():
            peer.frame_task = None
            if peer.vital_consent and peer.vital_epoch == epoch:
                _start_pending_frame(invitation_id, peer)


def _start_pending_frame(invitation_id: str, peer: Peer) -> None:
    """Bounded backlog absorbs tunnel jitter; old camera images are never replayed."""
    now = time.monotonic()
    while peer.pending_frames and now - peer.pending_frames[0][2] > MAX_FRAME_AGE:
        peer.pending_frames.popleft()
    if (peer.frame_task is not None or not peer.pending_frames
            or len(_frame_workers) >= MAX_FRAME_WORKERS or peer.vital_manager is None):
        return
    encoded, sampled_at, _ = peer.pending_frames.popleft()
    worker = asyncio.create_task(asyncio.to_thread(
        _analyze_frame, peer.vital_manager, peer.role, encoded, sampled_at,
    ))
    _frame_workers.add(worker)

    def done(completed: asyncio.Task) -> None:
        _frame_workers.discard(completed)
        if not completed.cancelled():
            completed.exception()
    worker.add_done_callback(done)
    peer.frame_task = asyncio.create_task(_frame_result(
        invitation_id, peer, peer.vital_epoch, worker,
    ))


async def _vital_message(invitation_id: str, peer: Peer, msg: dict) -> None:
    if _peers.get(invitation_id, {}).get(peer.role) is not peer:
        raise HTTPException(403, "この面接の接続ではありません。")
    if msg.get("type") == "vital_consent" and msg.get("enabled") is False:
        await _clear_vitals(invitation_id, peer)
        await _broadcast_state(invitation_id)
        return
    if not _active_peer(invitation_id, peer):
        await _clear_vitals(invitation_id, peer)
        raise HTTPException(409, "入室許可後の対人面接中のみ計測・共有できます。")
    if msg.get("type") == "vital_consent":
        if msg.get("enabled") is not True:
            raise HTTPException(422, "計測・共有への同意を確認してください。")
        if not peer.vital_consent:
            peer.vital_epoch += 1
            peer.vital_manager = SessionManager(load_settings())
            peer.vital_consent = True
        peer.save_summary = msg.get('save_summary') is True
        await _broadcast_state(invitation_id)
        return
    if not peer.vital_consent or peer.vital_manager is None:
        raise HTTPException(403, "心拍・ストレスの計測と共有に同意してから開始してください。")
    encoded = msg.get("image_base64")
    if not isinstance(encoded, str) or not 1 <= len(encoded) <= MAX_FRAME_BASE64:
        raise HTTPException(413, "計測画像が大きすぎるか、形式が正しくありません。")
    now = time.monotonic()
    captured = msg.get('captured_at')
    if captured is not None:
        if (isinstance(captured, bool) or not isinstance(captured, (int, float))
                or not math.isfinite(captured) or captured < 0):
            raise HTTPException(422, '計測画像の撮影時刻が不正です。')
        # The clock is relative to this browser. Bound its speed against server
        # time while allowing up to 500ms of frames to arrive as one burst.
        offset = peer.capture_offset if peer.capture_offset is not None else now - captured
        sampled_at = captured + offset
        if (sampled_at > now + 0.5 or sampled_at < now - MAX_FRAME_AGE
                or (peer.last_capture is not None and captured - peer.last_capture < 1 / MAX_FRAME_FPS - 1e-6)):
            return
        peer.capture_offset = offset
        peer.last_capture = captured
        if len(peer.pending_frames) >= MAX_PENDING_FRAMES:
            peer.pending_frames.popleft()
        peer.pending_frames.append((encoded, sampled_at, now))
        _start_pending_frame(invitation_id, peer)
        return
    # Drop excess frames rather than queueing old camera images or disconnecting
    # the participant's call. No more than one frame is outstanding per peer.
    if now - peer.last_frame < 1 / MAX_FRAME_FPS or peer.frame_task is not None or len(_frame_workers) >= MAX_FRAME_WORKERS:
        return
    peer.last_frame = now
    # Reserve the global slot before yielding; simultaneous rooms cannot each
    # schedule workers against an as-yet-empty set.
    worker = asyncio.create_task(asyncio.to_thread(
        _analyze_frame, peer.vital_manager, peer.role, encoded, now,
    ))
    _frame_workers.add(worker)

    def done(completed: asyncio.Task) -> None:
        _frame_workers.discard(completed)
        if not completed.cancelled():
            completed.exception()
    worker.add_done_callback(done)
    peer.frame_task = asyncio.create_task(_frame_result(
        invitation_id, peer, peer.vital_epoch, worker,
    ))


async def _state(invitation_id: str, peer: Peer) -> None:
    _, session = access_session(invitation_id, peer.token)
    peers = _peers.get(invitation_id, {})
    if session["invitation"]["status"] != "in_progress":
        for participant in list(peers.values()):
            await _clear_vitals(invitation_id, participant)
    await peer.send({
        "type": "state", "session": session, "ice_servers": ice_servers(invitation_id, peer.role),
        "peers": [{"client_id": p.role, "role": p.role, "name": p.name,
                   "vital_consent": p.vital_consent} for p in peers.values()],
    })


async def _broadcast_state(invitation_id: str) -> None:
    for peer in list(_peers.get(invitation_id, {}).values()):
        try:
            await _state(invitation_id, peer)
        except HTTPException:
            await _clear_vitals(invitation_id, peer)
            try:
                await peer.ws.close(code=4003)
            except RuntimeError:
                pass
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass


async def _refresh(invitation_id: str, peer: Peer) -> None:
    while True:
        await asyncio.sleep(2)
        try:
            await _state(invitation_id, peer)
        except HTTPException as exc:
            await _clear_vitals(invitation_id, peer)
            await peer.send({"type": "error", "message": str(exc.detail), "status": exc.status_code})
            await peer.ws.close(code=4003)
            return
        except (RuntimeError, WebSocketDisconnect, OSError):
            return


async def _message(ws: WebSocket) -> dict:
    raw = await ws.receive_text()
    if len(raw) > MAX_FRAME_BASE64 + 2048:
        raise HTTPException(413, "メッセージが長すぎます。")
    try:
        data = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, "メッセージの形式が正しくありません。") from exc
    if not isinstance(data, dict):
        raise HTTPException(400, "メッセージの形式が正しくありません。")
    if data.get("type") not in ("frame", "screen") and len(raw) > 64_000:
        raise HTTPException(413, "メッセージが長すぎます。")
    return data


@router.websocket("/ws/hiring/{invitation_id}")
async def human_interview(ws: WebSocket, invitation_id: str) -> None:
    await ws.accept()
    peer = None
    refresh = None
    try:
        first = await asyncio.wait_for(_message(ws), timeout=10)
        if first.get("type") != "join" or not isinstance(first.get("token"), str):
            raise HTTPException(401, "面接への認証が必要です。")
        token = first["token"]
        if len(token) > 256:
            raise HTTPException(401, "認証情報が無効です。")
        role, session = access_session(invitation_id, token)
        invitation = session["invitation"]
        if invitation["mode"] != "human":
            raise HTTPException(400, "この面接はAI面接です。")
        if invitation["status"] in ("completed", "revoked", "expired"):
            raise HTTPException(409, "この面接は終了しています。")
        peer = Peer(ws, token, role, "面接官" if role == "interviewer"
                    else invitation["candidate_name"])
        group = _peers.setdefault(invitation_id, {})
        old = group.get(role)
        group[role] = peer
        if old is not None:
            await _clear_vitals(invitation_id, old)
            await old.ws.close(code=4001, reason="別の画面から接続されました。")
        await _broadcast_state(invitation_id)
        refresh = asyncio.create_task(_refresh(invitation_id, peer))
        rate_start = asyncio.get_running_loop().time()
        rate_count = 0
        while True:
            msg = await _message(ws)
            now = asyncio.get_running_loop().time()
            if now - rate_start >= 10:
                rate_start, rate_count = now, 0
            rate_count += 1
            if rate_count > 600:
                raise HTTPException(429, "送信が多すぎます。少し待って再接続してください。")
            if _peers.get(invitation_id, {}).get(role) is not peer:
                break
            try:
                if msg.get("type") in ("vital_consent", "frame"):
                    await _vital_message(invitation_id, peer, msg)
                    continue
                _, current = access_session(invitation_id, token)
                if msg.get("type") == "ping":
                    await _state(invitation_id, peer)
                    continue
                if current["invitation"]["status"] != "in_progress":
                    raise HTTPException(409, "入室許可後、面接中に送信できます。")
                if msg.get("type") == "signal":
                    if not isinstance(msg.get("data"), dict):
                        raise HTTPException(400, "接続情報の形式が正しくありません。")
                    other_role = "candidate" if role == "interviewer" else "interviewer"
                    other = _peers.get(invitation_id, {}).get(other_role)
                    if other:
                        _, other_session = access_session(invitation_id, other.token)
                        if other_session["invitation"]["status"] == "in_progress":
                            # Admission is a REST transition. Deliver its state before
                            # an offer, even if this peer's periodic refresh is later.
                            await _state(invitation_id, other)
                            await other.send({"type": "signal", "data": msg["data"], "role": role})
                elif msg.get("type") == "transcript":
                    if not isinstance(msg.get("text"), str) or not isinstance(msg.get("request_id"), str):
                        raise HTTPException(400, "発言と送信IDが必要です。")
                    await append_human_turn(invitation_id, token, msg["text"], msg["request_id"])
                    await peer.send({"type": "transcript_saved", "request_id": msg["request_id"]})
                    await _broadcast_state(invitation_id)
                elif msg.get("type") in ("screen", "screen_stop"):
                    # 画面共有フレームを相手に中継(WebRTC通話とは独立。画像は保存しない)。
                    other_role = "candidate" if role == "interviewer" else "interviewer"
                    other = _peers.get(invitation_id, {}).get(other_role)
                    if msg.get("type") == "screen":
                        img = msg.get("image_base64")
                        if not isinstance(img, str) or not 1 <= len(img) <= MAX_FRAME_BASE64:
                            raise HTTPException(413, "共有画像が大きすぎるか、形式が正しくありません。")
                        peer.presenting = True
                        if other:
                            await other.send({"type": "screen", "role": role, "image_base64": img})
                    else:
                        peer.presenting = False
                        if other:
                            await other.send({"type": "screen_stop", "role": role})
            except HTTPException as exc:
                await peer.send({"type": "error", "message": str(exc.detail), "status": exc.status_code,
                                 "request_id": msg.get("request_id")})
    except HTTPException as exc:
        try:
            await ws.send_json({"type": "error", "message": str(exc.detail), "status": exc.status_code})
            await ws.close(code=4003)
        except (RuntimeError, WebSocketDisconnect):
            pass
    except asyncio.TimeoutError:
        await ws.close(code=4008)
    except (WebSocketDisconnect, RuntimeError, OSError):
        pass
    finally:
        if refresh:
            refresh.cancel()
            await asyncio.gather(refresh, return_exceptions=True)
        if peer and _peers.get(invitation_id, {}).get(peer.role) is peer:
            await _clear_vitals(invitation_id, peer)
            if peer.presenting:
                # 画面共有中に切断したら、相手側の表示を消す。
                other_role = "candidate" if peer.role == "interviewer" else "interviewer"
                other = _peers.get(invitation_id, {}).get(other_role)
                if other:
                    try:
                        await other.send({"type": "screen_stop", "role": peer.role})
                    except (RuntimeError, WebSocketDisconnect, OSError):
                        pass
            del _peers[invitation_id][peer.role]
            if not _peers[invitation_id]:
                del _peers[invitation_id]
            await _broadcast_state(invitation_id)
        if peer:
            _reset_vitals(peer)
            if peer.frame_task:
                peer.frame_task.cancel()
                await asyncio.gather(peer.frame_task, return_exceptions=True)
