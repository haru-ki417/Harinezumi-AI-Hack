"""
フレーム画像のデコードと顔ROIのRGB平均抽出。

改良点:
  - 顔検出は OpenCV 同梱の Haar カスケード(追加DL不要)。
  - 額・両頬のサブROIを使い、目/口/髪を避ける。
  - YCrCb 肌マスクで肌ピクセルだけを平均対象にし、背景・髪・眼鏡の影響を低減。
  - 顔が取れないフレームは画面中央にフォールバック(バッファが途切れにくい)。

MediaPipe FaceMesh を使うより精度は落ちるが、依存が軽く常に動く。
より高精度が要るときは vital/face_mesh.py(任意)に差し替え可能。
"""
from __future__ import annotations

import base64
from typing import Optional, Tuple

import cv2
import numpy as np

_CASCADE = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)

RGB = Tuple[float, float, float]


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


def face_roi_rgb(img: Optional[np.ndarray]) -> Optional[RGB]:
    """
    額・両頬(肌マスク適用)の平均RGBを返す。顔が取れなければ中央領域で代替。
    """
    if img is None or img.size == 0:
        return None

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = _CASCADE.detectMultiScale(
        gray, scaleFactor=1.2, minNeighbors=5, minSize=(80, 80)
    )

    if len(faces) > 0:
        x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
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
            roi = img[ry0:ry1, rx0:rx1]
            m = _mean_rgb_masked(roi)
            if m is not None:
                acc.append(m)
        if acc:
            arr = np.asarray(acc, dtype=float)
            return (float(arr[:, 0].mean()),
                    float(arr[:, 1].mean()),
                    float(arr[:, 2].mean()))

    # フォールバック: 中央領域
    H, W = img.shape[:2]
    roi = img[int(H * 0.30):int(H * 0.70), int(W * 0.35):int(W * 0.65)]
    return _mean_rgb_masked(roi)
