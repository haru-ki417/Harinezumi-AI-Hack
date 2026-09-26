"""
フレーム画像のデコードと顔ROIのRGB平均抽出。

改良点:
  - 顔検出は OpenCV 同梱の Haar カスケード(追加DL不要)。
  - 額・両頬のサブROIを使い、目/口/髪を避ける。
  - YCrCb 肌マスクで肌ピクセルだけを平均対象にし、背景・髪・眼鏡の影響を低減。
  - 顔が取れないフレームは計測せず、背景を脈波として扱わない。

MediaPipe FaceMesh を使うより精度は落ちるが、依存が軽く常に動く。
より高精度が要るときは vital/face_mesh.py(任意)に差し替え可能。
"""
from __future__ import annotations

import base64
import threading
from typing import Optional, Tuple

import cv2
import numpy as np

# 顔検出は任意。壊れた/古い OpenCV ビルド(CascadeClassifier 非搭載など)でも
# バックエンドが必ず起動できるよう、生成失敗時は _CASCADE=None にして
# 顔検出不能として計測を停止する。
_CASCADE = None
try:
    _cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    if not _cascade.empty():
        _CASCADE = _cascade
except Exception:  # noqa: BLE001 - どんな失敗でも起動を止めない
    _CASCADE = None

RGB = Tuple[float, float, float]

# ===== 顔検出の高速化・安定化 =====
# 目的:
#  (速度) Haar 検出はコストが高いので、(1)縮小画像で検出し、(2)毎フレームでは
#         なく数フレームに1回だけ走らせる。
#  (精度) 検出箱はフレームごとに小刻みに揺れ、ROIが動いて脈波にノイズを乗せる。
#         EMA で箱を平滑化し、検出ミス時も直近箱を短時間だけ再利用して途切れを防ぐ。
# client 単位(key)で追跡する。key を渡さない場合は従来どおり毎フレーム全解像度検出。
_DETECT_MAXW = 384        # 検出に使う最大横幅(これより大きい画像は縮小)
_DETECT_EVERY = 6         # key指定時: 何フレームに1回 Haar を実行するか
_BOX_SMOOTH = 0.5         # 箱位置のEMA係数
_MISS_GRACE = 2           # 連続で「検出したのに見つからない」回数の許容。これを
                          # 超えたら顔が居なくなったとみなし追跡を破棄(≒0.5秒)。
_track_lock = threading.Lock()
_TRACKS: dict = {}        # key -> {"box":[x,y,w,h]|None, "miss":int, "count":int}


def _detect_raw(gray: np.ndarray):
    """縮小画像で最大の顔を検出し、元解像度の (x,y,w,h) を返す。無ければ None。"""
    if _CASCADE is None:
        return None
    try:
        h, w = gray.shape[:2]
        scale = 1.0
        det = gray
        if w > _DETECT_MAXW:
            scale = _DETECT_MAXW / float(w)
            det = cv2.resize(gray, (int(w * scale), int(h * scale)),
                             interpolation=cv2.INTER_AREA)
        # Camera frames are usually only 320px wide; an 80px minimum misses
        # ordinary seated faces. Scale the limit with the input resolution.
        ms = max(24, int(min(h, w) * scale / 6))
        faces = _CASCADE.detectMultiScale(
            det, scaleFactor=1.2, minNeighbors=5, minSize=(ms, ms)
        )
        if len(faces) == 0:
            return None
        x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        inv = 1.0 / scale
        return (x * inv, y * inv, fw * inv, fh * inv)
    except Exception:  # noqa: BLE001 - 検出失敗時は計測しない
        return None


def _get_box(gray: np.ndarray, key: Optional[str]):
    """key 指定時は検出間引き＋EMA平滑化＋ミス時再利用。無指定は毎回検出。"""
    if key is None:
        return _detect_raw(gray)
    with _track_lock:
        tr = _TRACKS.get(key)
        count = tr["count"] if tr else 0
    do_detect = tr is None or (count % _DETECT_EVERY == 0)
    box = _detect_raw(gray) if do_detect else None
    with _track_lock:
        tr = _TRACKS.get(key)
        if tr is None:
            tr = {"box": None, "miss": 0, "count": 0}
            _TRACKS[key] = tr
        if box is not None:
            if tr["box"] is None:
                tr["box"] = list(box)
            else:
                a = _BOX_SMOOTH
                tr["box"] = [(1 - a) * o + a * n for o, n in zip(tr["box"], box)]
            tr["miss"] = 0
        elif do_detect and tr["box"] is not None:
            # 検出を走らせたが見つからなかった → 直近箱を短時間だけ維持。
            tr["miss"] += 1
            if tr["miss"] > _MISS_GRACE:
                _TRACKS.pop(key, None)
                return None
        tr["count"] = count + 1
        return tuple(tr["box"]) if tr["box"] is not None else None


def decode_image(image_base64: str) -> Optional[np.ndarray]:
    """純粋なBase64(またはdata URL)をBGR画像へデコード。"""
    if not image_base64:
        return None
    if "," in image_base64[:64]:
        image_base64 = image_base64.split(",", 1)[1]
    try:
        raw = base64.b64decode(image_base64, validate=False)
    except (ValueError, TypeError):
        return None
    if not raw:
        return None
    arr = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)  # BGR


def _skin_mask(bgr: np.ndarray) -> np.ndarray:
    """YCrCb空間の肌色範囲でマスクを作る(0/1)。"""
    ycrcb = cv2.cvtColor(bgr, cv2.COLOR_BGR2YCrCb)
    cr = ycrcb[:, :, 1]
    cb = ycrcb[:, :, 2]
    mask = (cr >= 133) & (cr <= 173) & (cb >= 77) & (cb <= 127)
    return mask.astype(np.uint8)


def _mean_rgb_masked(bgr_roi: np.ndarray) -> Optional[RGB]:
    """ROI内の肌ピクセルのみでRGB平均。肌が少なければ全画素で代替。"""
    if bgr_roi.size == 0:
        return None
    luminance = cv2.cvtColor(bgr_roi, cv2.COLOR_BGR2GRAY)
    if np.mean((luminance < 20) | (luminance > 245)) > 0.4:
        return None
    mask = _skin_mask(bgr_roi)
    if mask.sum() >= 30:
        sel = mask.astype(bool)
        b = float(bgr_roi[:, :, 0][sel].mean())
        g = float(bgr_roi[:, :, 1][sel].mean())
        r = float(bgr_roi[:, :, 2][sel].mean())
    else:
        b = float(bgr_roi[:, :, 0].mean())
        g = float(bgr_roi[:, :, 1].mean())
        r = float(bgr_roi[:, :, 2].mean())
    return (r, g, b)


def face_roi_rgb(img: Optional[np.ndarray], key: Optional[str] = None) -> Optional[RGB]:
    """
    額・両頬(肌マスク適用)の平均RGBを返す。顔が取れなければ None。

    key を渡すと client 単位で顔箱を追跡し、検出の間引き・EMA平滑化・ミス時
    再利用で、速度とROIの安定性(=脈波のS/N)を両立する。無指定は従来動作。
    """
    if img is None or img.size == 0:
        return None
    if _CASCADE is None:
        return None

    try:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    except Exception:  # noqa: BLE001
        return None

    box = _get_box(gray, key)
    if box is None:
        return None

    x, y, w, h = (int(round(v)) for v in box)
    # 額 + 左右頬のサブROIを集めて平均(肌の割合が高い領域)
    regions = [
        (x + int(w * 0.30), y + int(h * 0.08), int(w * 0.40), int(h * 0.18)),  # 額
        (x + int(w * 0.12), y + int(h * 0.45), int(w * 0.24), int(h * 0.22)),  # 左頬
        (x + int(w * 0.64), y + int(h * 0.45), int(w * 0.24), int(h * 0.22)),  # 右頬
    ]
    acc = []
    H, W = img.shape[:2]
    for rx, ry, rw, rh in regions:
        rx0, ry0 = max(0, rx), max(0, ry)
        rx1, ry1 = min(W, rx + rw), min(H, ry + rh)
        if rx1 <= rx0 or ry1 <= ry0:
            continue
        roi = img[ry0:ry1, rx0:rx1]
        m = _mean_rgb_masked(roi)
        if m is not None:
            acc.append(m)
    if acc:
        arr = np.asarray(acc, dtype=float)
        return (float(arr[:, 0].mean()),
                float(arr[:, 1].mean()),
                float(arr[:, 2].mean()))
    return None
