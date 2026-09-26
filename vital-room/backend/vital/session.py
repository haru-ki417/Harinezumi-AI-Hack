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
import uuid
import weakref
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from typing import Deque, Dict, Tuple

import numpy as np

from .config import Settings
from .hrv import hrv_from_pulse, stress_score
from .rppg import MIN_DURATION, compute_pulse
from .face import _TRACKS, _track_lock


def _release_roi(key: str) -> None:
    with _track_lock:
        _TRACKS.pop(key, None)


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
    measurement_status: str = 'warming_up'
    signal_seconds: float = 0.0
    display_bpm: float | None = None
    display_stress: float | None = None
    display_source: str = 'none'
    display_fresh: bool = False
    display_confidence: float | None = None

    def as_dict(self) -> dict:
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
        self.last_compute = float('-inf')
        self.last_result = VitalState()
        self.status = 'warming_up'
        self.signal_seconds = 0.0
        self.display_bpm: float | None = None
        self.display_stress: float | None = None
        self.display_source = 'none'
        self.display_confidence: float | None = None
        self.display_hr_base: float | None = None
        self.display_rmssd_base: float | None = None

    def add(self, t: float, rgb: Tuple[float, float, float]) -> None:
        if not np.isfinite([t, *rgb]).all() or min(rgb) <= 0:
            self.buf.clear()
            self.last_compute = float('-inf')
            return
        if self.buf:
            previous = self.buf[-1]
            if t <= previous[0]:
                return
            if t - previous[0] > 0.35:
                # 実際にフレームが途切れた(ストリーム停止)場合のみリセット。
                # 古いデータは陳腐化しているため破棄する。
                self.buf.clear()
                # A short camera/network interruption invalidates the pulse
                # window, but must not restart the entire stress calibration.
                if t - previous[0] > 3.0:
                    self.bpm_history.clear()
                    self.rmssd_history.clear()
                self.bpm = self.rmssd = self.sdnn = self.stress = 0
                self.last_compute = float('-inf')
            else:
                # 単発の外れフレーム(顔箱のブレ・照明のちらつき等)は、
                # バッファ全体を捨てず“その1フレームだけスキップ”する。
                # 以前は全消去していたため、蓄積した数秒ぶんの良データが
                # 毎回リセットされ、計測開始が遅く途切れやすかった。
                jump = np.max(np.abs(np.asarray(rgb) / np.asarray(previous[1:]) - 1))
                if jump > 0.12:
                    return
        self.buf.append((t, rgb[0], rgb[1], rgb[2]))
        cutoff = t - self.s.window_sec
        while self.buf and self.buf[0][0] < cutoff:
            self.buf.popleft()

    def _baseline(self, hist: Deque[Tuple[float, float]], t: float) -> float:
        vals = [v for (tt, v) in hist if tt < t - self.s.anom_baseline_lag]
        eligible = [tt for tt, _ in hist if tt < t - self.s.anom_baseline_lag]
        if (len(vals) < self.s.anom_min_baseline or len(eligible) < 2
                or eligible[-1] - eligible[0] < 15):
            return 0.0
        return float(np.median(vals))

    def compute(self, t: float) -> VitalState:
        s = self.s
        self.signal_seconds = self.buf[-1][0] - self.buf[0][0] if len(self.buf) > 1 else 0.0
        if len(self.buf) < s.min_samples:
            self.status = 'warming_up'
            return self._state(False)
        if t - self.last_compute < 0.4:
            return self.last_result

        arr = np.asarray(self.buf, dtype=float)
        times, rgb = arr[:, 0], arr[:, 1:4]
        dur = float(times[-1] - times[0])
        eff_fps = (len(times) - 1) / dur if dur > 0 else 0.0

        recent = times >= times[-1] - 8
        res = compute_pulse(times[recent], rgb[recent])
        if (res is None or not np.isfinite(res.bpm) or res.bpm <= 0
                or eff_fps < s.min_fps_for_hr):
            self.status = ('warming_up' if dur < MIN_DURATION else
                           'low_fps' if eff_fps < s.min_fps_for_hr else 'unstable_signal')
            self.last_compute = t
            self.last_result = self._state(False, eff_fps)
            return self.last_result

        # Display a computed estimate even when confidence is low. Keep it
        # separate from quality-approved values used in saved measurements.
        self.display_bpm = res.bpm if self.display_bpm is None else (
            (1 - s.bpm_smooth) * self.display_bpm + s.bpm_smooth * res.bpm)
        if self.display_hr_base is None:
            self.display_hr_base = self.display_bpm
        self.display_stress = float(100 * np.clip(
            (self.display_bpm - self.display_hr_base) / (0.25 * self.display_hr_base), 0, 1))
        self.display_source = 'heart_rate'
        self.display_confidence = res.confidence
        if res.confidence < s.conf_min or res.snr_db < s.snr_min_db:
            self.status = 'unstable_signal'
            self.last_compute = t
            self.last_result = self._state(False, eff_fps, display_fresh=True)
            return self.last_result

        # BPM 平滑化
        self.bpm = res.bpm if self.bpm <= 0 else (
            (1 - s.bpm_smooth) * self.bpm + s.bpm_smooth * res.bpm
        )
        self.conf = res.confidence
        self.snr_db = res.snr_db
        if not self.bpm_history or t - self.bpm_history[-1][0] >= 1:
            self.bpm_history.append((t, self.bpm))
        _trim(self.bpm_history, t - s.anom_history_sec)

        # HRV
        long_res = compute_pulse(times, rgb) if dur >= 12 and eff_fps >= 15 else None
        hrv = (hrv_from_pulse(long_res.pulse, long_res.fs)
               if long_res is not None and long_res.confidence >= s.conf_min
               and long_res.snr_db >= s.snr_min_db else None)
        if hrv is not None and abs(hrv.mean_hr - res.bpm) > 10:
            hrv = None
        if hrv is not None:
            self.rmssd = hrv.rmssd if self.rmssd <= 0 else (
                (1 - s.rmssd_smooth) * self.rmssd + s.rmssd_smooth * hrv.rmssd
            )
            self.sdnn = hrv.sdnn
            if not self.rmssd_history or t - self.rmssd_history[-1][0] >= 1:
                self.rmssd_history.append((t, self.rmssd))
            _trim(self.rmssd_history, t - s.anom_history_sec)
            if self.display_rmssd_base is None and self.rmssd > 0:
                self.display_rmssd_base = self.rmssd
            if self.display_rmssd_base is not None:
                self.display_stress = stress_score(self.bpm, self.rmssd, self.display_hr_base, self.display_rmssd_base)
                self.display_source = 'hrv'

        # ストレス & 異常判定
        bpm_base = self._baseline(self.bpm_history, t)
        rmssd_base = self._baseline(self.rmssd_history, t)
        stress_valid = hrv is not None and bpm_base > 0 and rmssd_base > 0
        self.status = ('measuring' if stress_valid else 'low_fps' if eff_fps < 15
                       else 'calibrating' if hrv is not None or dur < 12 else 'unstable_hrv')
        if stress_valid:
            self.stress = stress_score(self.bpm, self.rmssd, bpm_base, rmssd_base)
            self.display_stress = self.stress
            self.display_source = 'calibrated'
        self.display_bpm = self.bpm

        anomalous = False
        if bpm_base > 0 and (self.bpm - bpm_base) >= s.anom_delta_bpm:
            anomalous = True
        if stress_valid and self.stress >= s.stress_anom_threshold:
            anomalous = True

        self.last_compute = t
        self.last_result = self._state(anomalous, eff_fps, measurement_valid=True, stress_valid=stress_valid, display_fresh=True)
        return self.last_result

    def _state(self, anomalous: bool, eff_fps: float = 0.0, *,
               measurement_valid: bool = False, stress_valid: bool = False, display_fresh: bool = False) -> VitalState:
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
            measurement_status=self.status,
            signal_seconds=round(self.signal_seconds, 1),
            display_bpm=round(self.display_bpm, 1) if self.display_bpm is not None else None,
            display_stress=round(self.display_stress, 1) if self.display_stress is not None else None,
            display_source=self.display_source,
            display_fresh=display_fresh,
            display_confidence=round(self.display_confidence, 3) if self.display_confidence is not None else None,
        )


def _trim(hist: Deque[Tuple[float, float]], cutoff: float) -> None:
    while hist and hist[0][0] < cutoff:
        hist.popleft()


class SessionManager:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.roi_key = uuid.uuid4().hex
        weakref.finalize(self, _release_roi, self.roi_key)
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
            state = self._clients[client_id]
            result = state._state(False, state.last_result.eff_fps)
            result.measurement_status = 'no_face'
            return result
