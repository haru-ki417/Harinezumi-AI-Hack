"""
心拍変動(HRV)とストレススコア。

脈波(compute_pulseの出力)からビート(ピーク)を検出し、拍間隔(IBI)を求めて
RMSSD / SDNN を計算する。緊張・動揺の指標としては心拍数(BPM)単独より
HRV(特にRMSSDの低下)の方が妥当。

注意: rPPG のサンプリング(実効15〜30fps)ではIBIの時間分解能が数十msあり、
RMSSDは近似値。傾向(平常比の低下)を見る用途に使うこと。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import find_peaks


@dataclass
class HrvResult:
    mean_hr: float   # IBI由来の心拍数(bpm)
    rmssd: float     # 連続IBI差のRMS(ms)
    sdnn: float      # IBIの標準偏差(ms)
    n_beats: int


def hrv_from_pulse(pulse: np.ndarray, fs: float, fmax: float = 4.0):
    """脈波からHRV指標を計算。ビートが少なければ None。"""
    p = np.asarray(pulse, dtype=float)
    if p.size < int(fs * 3):
        return None
    p = p - p.mean()
    std = p.std()
    if std <= 1e-9:
        return None
    p = p / std

    min_dist = max(1, int(fs / fmax))               # 最短拍間隔(サンプル)
    peaks, _ = find_peaks(p, distance=min_dist, prominence=0.3)
    if peaks.size < 4:
        return None

    ibi_ms = np.diff(peaks) / fs * 1000.0
    # 生理的に妥当なIBIのみ(300-1500ms = 40-200bpm)
    ibi_ms = ibi_ms[(ibi_ms >= 300.0) & (ibi_ms <= 1500.0)]
    if ibi_ms.size < 3:
        return None

    rmssd = float(np.sqrt(np.mean(np.diff(ibi_ms) ** 2)))
    sdnn = float(np.std(ibi_ms))
    mean_hr = float(60000.0 / np.mean(ibi_ms))
    return HrvResult(mean_hr=mean_hr, rmssd=rmssd, sdnn=sdnn,
                     n_beats=int(ibi_ms.size) + 1)


def stress_score(hr: float, rmssd: float,
                 hr_base: float, rmssd_base: float) -> float:
    """
    平常時ベースラインからの逸脱でストレスを 0..100 で表す。
    心拍が+25%で、またはRMSSDが-50%で、それぞれ寄与が最大になる。
    """
    if hr_base <= 0 or rmssd_base <= 0:
        return 0.0
    hr_c = float(np.clip((hr - hr_base) / (0.25 * hr_base), 0.0, 1.0))
    rmssd_c = float(np.clip((rmssd_base - rmssd) / (0.5 * rmssd_base), 0.0, 1.0))
    return round(100.0 * (0.5 * hr_c + 0.5 * rmssd_c), 1)
