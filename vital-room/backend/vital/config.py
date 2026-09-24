"""
設定。環境変数 STEALTH_VITAL_* で上書きできる。
例:  STEALTH_VITAL_ANOM_DELTA_BPM=15  STEALTH_VITAL_PORT=8080
"""
from __future__ import annotations

import os
from dataclasses import dataclass

_PREFIX = "STEALTH_VITAL_"


def _get_f(name: str, default: float) -> float:
    try:
        return float(os.environ[_PREFIX + name])
    except (KeyError, ValueError):
        return default


def _get_i(name: str, default: int) -> int:
    try:
        return int(os.environ[_PREFIX + name])
    except (KeyError, ValueError):
        return default


def _get_s(name: str, default: str) -> str:
    return os.environ.get(_PREFIX + name, default)


@dataclass
class Settings:
    # 解析
    window_sec: float = 8.0         # 解析窓長(秒)。短いほど反応が速い
    min_samples: int = 8            # 解析を始める最小フレーム数
    min_fps_for_hr: float = 6.0     # これ未満の実効fpsではBPMを更新しない
    conf_min: float = 0.40          # 信頼度(SNRシグモイド)の下限。ノイズ棄却
    snr_min_db: float = 0.5         # 帯域内SNRの下限(これ未満は更新しない)
    bpm_smooth: float = 0.45        # BPMのEMA係数(大きいほど追従が速い)
    rmssd_smooth: float = 0.30      # RMSSDのEMA係数
    # 異常/ストレス
    anom_history_sec: float = 60.0
    anom_baseline_lag: float = 3.0  # ベースライン確立までの遅延(短いほど早く出る)
    anom_min_baseline: int = 3
    anom_delta_bpm: float = 12.0
    stress_anom_threshold: float = 55.0  # このストレス以上で異常
    # サーバ
    cors_origin: str = "http://localhost:3000"
    host: str = "0.0.0.0"
    port: int = 8000


def load_settings() -> Settings:
    return Settings(
        window_sec=_get_f("WINDOW_SEC", 8.0),
        min_samples=_get_i("MIN_SAMPLES", 8),
        min_fps_for_hr=_get_f("MIN_FPS_FOR_HR", 6.0),
        conf_min=_get_f("CONF_MIN", 0.40),
        snr_min_db=_get_f("SNR_MIN_DB", 0.5),
        bpm_smooth=_get_f("BPM_SMOOTH", 0.45),
        rmssd_smooth=_get_f("RMSSD_SMOOTH", 0.30),
        anom_history_sec=_get_f("ANOM_HISTORY_SEC", 60.0),
        anom_baseline_lag=_get_f("ANOM_BASELINE_LAG", 3.0),
        anom_min_baseline=_get_i("ANOM_MIN_BASELINE", 3),
        anom_delta_bpm=_get_f("ANOM_DELTA_BPM", 12.0),
        stress_anom_threshold=_get_f("STRESS_ANOM_THRESHOLD", 55.0),
        cors_origin=_get_s("CORS_ORIGIN", "http://localhost:3000"),
        host=_get_s("HOST", "0.0.0.0"),
        port=_get_i("PORT", 8000),
    )
