"""
[任意] MediaPipe FaceMesh を使う高精度ROI抽出。

Haarベースの face.py より正確に額・頬を取り、フレーム間で安定する。
使うには追加インストールが必要:

    pip install mediapipe

app.py 側で以下のように差し替えると有効化できる:

    try:
        from vital.face_mesh import face_roi_rgb, decode_image
    except Exception:
        from vital.face import face_roi_rgb, decode_image

注意: この環境では mediapipe を導入・実測できていないため未検証。
導入できない環境では自動で例外になるので、上記の try/except で
face.py にフォールバックする運用にすること。
"""
from __future__ import annotations

from typing import Optional, Tuple

import cv2
import numpy as np

from .face import _skin_mask, decode_image  # 再利用

RGB = Tuple[float, float, float]

# FaceMesh の代表的ランドマーク番号(額・左右頬まわり)
_FOREHEAD = [10, 338, 297, 332, 284, 251, 389, 67, 109, 108, 151]
_LEFT_CHEEK = [50, 205, 206, 216, 212, 202, 118, 117, 123]
_RIGHT_CHEEK = [280, 425, 426, 436, 432, 422, 347, 346, 352]

try:  # 遅延インポート(未導入でもモジュール読み込みは失敗させない)
    import mediapipe as mp  # type: ignore
    _MESH = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True, max_num_faces=1, refine_landmarks=False,
        min_detection_confidence=0.5,
    )
except Exception:  # noqa: BLE001
    _MESH = None


def _poly_mean_rgb(bgr: np.ndarray, pts: np.ndarray) -> Optional[RGB]:
    if pts.shape[0] < 3:
        return None
    mask = np.zeros(bgr.shape[:2], dtype=np.uint8)
    cv2.fillConvexPoly(mask, cv2.convexHull(pts), 1)
    skin = _skin_mask(bgr)
    sel = (mask.astype(bool)) & (skin.astype(bool))
    if sel.sum() < 30:
        sel = mask.astype(bool)
    if sel.sum() == 0:
        return None
    luminance = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)[sel]
    if np.mean((luminance < 20) | (luminance > 245)) > 0.4:
        return None
    b = float(bgr[:, :, 0][sel].mean())
    g = float(bgr[:, :, 1][sel].mean())
    r = float(bgr[:, :, 2][sel].mean())
    return (r, g, b)


def face_roi_rgb(img: Optional[np.ndarray]) -> Optional[RGB]:
    """FaceMeshで額・両頬の肌ROI平均RGBを返す。取得不能なら None。"""
    if _MESH is None or img is None or img.size == 0:
        return None
    h, w = img.shape[:2]
    res = _MESH.process(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    if not res.multi_face_landmarks:
        return None
    lm = res.multi_face_landmarks[0].landmark

    acc = []
    for idxs in (_FOREHEAD, _LEFT_CHEEK, _RIGHT_CHEEK):
        pts = np.array(
            [[int(lm[i].x * w), int(lm[i].y * h)] for i in idxs if i < len(lm)],
            dtype=np.int32,
        )
        m = _poly_mean_rgb(img, pts)
        if m is not None:
            acc.append(m)
    if not acc:
        return None
    arr = np.asarray(acc, dtype=float)
    return (float(arr[:, 0].mean()),
            float(arr[:, 1].mean()),
            float(arr[:, 2].mean()))


__all__ = ["face_roi_rgb", "decode_image"]
