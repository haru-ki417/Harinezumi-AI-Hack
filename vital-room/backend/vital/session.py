"""
クライアントごとの時系列バッファと、BPM/HRV/ストレスの推定・平滑化・異常検知。

タイムスタンプはサーバ受信時刻を使い通信ジッタに強くする。フロントは
{ image_base64 } しか送らないため、クライアントのホスト(IP)でセッションを分ける。

異常(is_anomalous)は次のどちらかで真:
  - 平滑化BPMが直近ベースライン中央値より anom_delta_bpm 以上高い
  - ストレススコアが stress_anom_threshold 以上
信頼度の低いフレームは状態を更新しないため、ノイズでの誤発火を抑える。
"""
from __future__ import annotations

import threading
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from typing import Deque, Dict, Tuple

import numpy as np

from .config import Settings
from .hrv import hrv_from_pulse, stress_score
from .rppg import compute_pulse


@dataclass
class VitalState:
    current_bpm: float = 0.0
    is_anomalous: bool = False
    confidence: float = 0.0
    snr_db: float = 0.0
    hrv_rmssd: float = 0.0      # ms
    hrv_sdnn: float = 0.0       # ms
    stress: float = 0.0         # 0..100
    eff_fps: float = 0.0
    measurement_valid: bool = False  # True only for a fresh accepted BPM estimate.
    stress_valid: bool = False       # Requires fresh HRV and both baselines.

    def as_dict(self) -> Dict[str, float | bool]:
        return asdict(self)


class ClientState:
    def __init__(self, settings: Settings) -> None:
        self.s = settings
        self.buf: Deque[Tuple[float, float, float, float]] = deque()
        self.bpm: float = 0.0
        self.conf: float = 0.0
        self.snr_db: float = 0.0
        self.rmssd: float = 0.0
        self.sdnn: float = 0.0
        self.stress: float = 0.0
        self.bpm_history: Deque[Tuple[float, float]] = deque()
        self.rmssd_history: Deque[Tuple[float, float]] = deque()

    def add(self, t: float, rgb: Tuple[float, float, float]) -> None:
        self.buf.append((t, rgb[0], rgb[1], rgb[2]))
        cutoff = t - self.s.window_sec
        while self.buf and self.buf[0][0] < cutoff:
            self.buf.popleft()

    def _baseline(self, hist: Deque[Tuple[float, float]], t: float) -> float:
        vals = [v for (tt, v) in hist if tt < t - self.s.anom_baseline_lag]
        if len(vals) < self.s.anom_min_baseline:
            return 0.0
        return float(np.median(vals))

    def compute(self, t: float) -> VitalState:
        s = self.s
        if len(self.buf) < s.min_samples:
            return self._state(False)

        arr = np.asarray(self.buf, dtype=float)
        times, rgb = arr[:, 0], arr[:, 1:4]
        dur = float(times[-1] - times[0])
        eff_fps = (len(times) - 1) / dur if dur > 0 else 0.0

        res = compute_pulse(times, rgb)
        if (res is None or res.bpm <= 0 or res.confidence < s.conf_min
                or res.snr_db < s.snr_min_db or eff_fps < s.min_fps_for_hr):
            return self._state(False, eff_fps)

        # BPM 平滑化
        self.bpm = res.bpm if self.bpm <= 0 else (
            (1 - s.bpm_smooth) * self.bpm + s.bpm_smooth * res.bpm
        )
        self.conf = res.confidence
        self.snr_db = res.snr_db
        self.bpm_history.append((t, self.bpm))
        _trim(self.bpm_history, t - s.anom_history_sec)

        # HRV
        hrv = hrv_from_pulse(res.pulse, res.fs)
        if hrv is not None:
            self.rmssd = hrv.rmssd if self.rmssd <= 0 else (
                (1 - s.rmssd_smooth) * self.rmssd + s.rmssd_smooth * hrv.rmssd
            )
            self.sdnn = hrv.sdnn
            self.rmssd_history.append((t, self.rmssd))
            _trim(self.rmssd_history, t - s.anom_history_sec)

        # ストレス & 異常判定
        bpm_base = self._baseline(self.bpm_history, t)
        rmssd_base = self._baseline(self.rmssd_history, t)
        stress_valid = hrv is not None and bpm_base > 0 and rmssd_base > 0
        if stress_valid:
            self.stress = stress_score(self.bpm, self.rmssd, bpm_base, rmssd_base)

        anomalous = False
        if bpm_base > 0 and (self.bpm - bpm_base) >= s.anom_delta_bpm:
            anomalous = True
        if stress_valid and self.stress >= s.stress_anom_threshold:
            anomalous = True

        return self._state(anomalous, eff_fps, measurement_valid=True, stress_valid=stress_valid)

    def _state(self, anomalous: bool, eff_fps: float = 0.0, *,
               measurement_valid: bool = False, stress_valid: bool = False) -> VitalState:
        return VitalState(
            current_bpm=round(self.bpm, 1),
            is_anomalous=anomalous,
            confidence=round(self.conf, 3),
            snr_db=round(self.snr_db, 1),
            hrv_rmssd=round(self.rmssd, 1),
            hrv_sdnn=round(self.sdnn, 1),
            stress=round(self.stress, 1),
            eff_fps=round(eff_fps, 1),
            measurement_valid=measurement_valid,
            stress_valid=stress_valid,
        )


def _trim(hist: Deque[Tuple[float, float]], cutoff: float) -> None:
    while hist and hist[0][0] < cutoff:
        hist.popleft()


class SessionManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._clients: "defaultdict[str, ClientState]" = defaultdict(
            lambda: ClientState(settings)
        )
        self._lock = threading.Lock()

    def process(self, client_id: str, t: float,
                rgb: Tuple[float, float, float]) -> VitalState:
        with self._lock:
            st = self._clients[client_id]
            st.add(t, rgb)
            return st.compute(t)

    def peek(self, client_id: str) -> VitalState:
        with self._lock:
            return self._clients[client_id]._state(False)
