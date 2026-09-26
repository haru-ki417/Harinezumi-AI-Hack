"""
rPPG DSP core — フレームワーク非依存の脈波推定。

顔ROIの RGB 時系列(不等間隔可)から脈波信号・心拍数(BPM)・信頼度を推定する。
手法: POS (Plane-Orthogonal-to-Skin, Wang et al. 2017) を
スライディング窓の overlap-add で実装 + バンドパス + FFT。

物理的制約(ナイキスト):
  心拍は 0.7〜4.0 Hz(42〜240 BPM)。取り出すには実効サンプリングレートが
  最低でも 8 Hz 必要。フロントの送信間隔は 33〜66ms(15〜30fps)にすること。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import signal

FMIN = 0.7   # 42 BPM
FMAX = 4.0   # 240 BPM
TARGET_FPS = 30.0
# 数拍ぶんあれば推定できる。初回表示を速くするため 4.5 秒に短縮
# (ゼロ詰め＋放物線補間で周波数分解能を補う)。
MIN_DURATION = 4.5


@dataclass
class PulseResult:
    """脈波推定の中間・最終結果。"""
    pulse: np.ndarray        # バンドパス済み脈波(一様サンプリング)
    fs: float                # 一様グリッドのサンプリングレート(Hz)
    bpm: float               # 推定心拍数(0 = 不能)
    confidence: float        # 0..1 スペクトルの尖鋭さ
    snr_db: float            # 帯域内SNR(dB)


def _resample_uniform(times: np.ndarray, values: np.ndarray, fps: float):
    """不等間隔時系列を一様グリッドへ線形補間。values:(N,C)。"""
    t0, t1 = float(times[0]), float(times[-1])
    n = max(2, int(round((t1 - t0) * fps)) + 1)
    grid = np.linspace(t0, t1, n)
    out = np.empty((n, values.shape[1]), dtype=float)
    for c in range(values.shape[1]):
        out[:, c] = np.interp(grid, times, values[:, c])
    return grid, out


def _pos_overlap_add(rgb: np.ndarray, fs: float) -> np.ndarray:
    """
    正統なPOS(Wang 2017): 長さ l のスライディング窓ごとにPOS投影し、
    重ね合わせ(overlap-add)して脈波を得る。rgb:(N,3) -> pulse:(N,)
    """
    n = rgb.shape[0]
    h = np.zeros(n, dtype=float)
    wl = max(8, int(round(1.6 * fs)))   # 窓長 ≒ 1.6秒
    if n < wl:
        wl = n
    eps = 1e-9
    # Same POS windows and overlap-add, evaluated in NumPy rather than hundreds
    # of Python iterations which used to stall camera ingestion during HRV.
    c = np.lib.stride_tricks.sliding_window_view(rgb, wl, axis=0).transpose(0, 2, 1)
    cn = c / (c.mean(axis=1, keepdims=True) + eps)
    s1 = cn[:, :, 1] - cn[:, :, 2]
    s2 = -2.0 * cn[:, :, 0] + cn[:, :, 1] + cn[:, :, 2]
    alpha = (s1.std(axis=1) + eps) / (s2.std(axis=1) + eps)
    hh = s1 + alpha[:, None] * s2
    hh -= hh.mean(axis=1, keepdims=True)
    indices = np.arange(hh.shape[0])[:, None] + np.arange(wl)
    return np.bincount(indices.ravel(), weights=hh.ravel(), minlength=n)


def _bandpass(x: np.ndarray, fs: float, fmin: float, fmax: float) -> np.ndarray:
    nyq = fs / 2.0
    low = max(fmin / nyq, 1e-3)
    high = min(fmax / nyq, 0.99)
    if low >= high:
        return x - x.mean()
    try:
        b, a = signal.butter(4, [low, high], btype="band")
        return signal.filtfilt(b, a, x)
    except ValueError:
        return x - x.mean()


def compute_pulse(times, rgb, fmin: float = FMIN, fmax: float = FMAX,
                  target_fps: float = TARGET_FPS):
    """
    RGB時系列から脈波・BPM・信頼度を計算する。データ不足なら None。
    HRV解析でも使えるよう、バンドパス済み脈波と fs を返す。
    """
    times = np.asarray(times, dtype=float)
    rgb = np.asarray(rgb, dtype=float)
    if (times.ndim != 1 or times.size < 8 or rgb.shape != (times.size, 3)
            or not np.isfinite(times).all() or not np.isfinite(rgb).all()
            or np.any(rgb <= 0)):
        return None
    duration = float(times[-1] - times[0])
    if duration < MIN_DURATION:
        return None

    intervals = np.diff(times)
    observed_fps = (times.size - 1) / duration
    if (np.any(intervals <= 0) or observed_fps < max(10.0, 2.5 * fmax)
            or intervals.max() > 0.35 or np.quantile(intervals, 0.95) > 0.15):
        return None
    grid, rs = _resample_uniform(times, rgb, min(target_fps, observed_fps))
    fs = (grid.size - 1) / (grid[-1] - grid[0])
    if rs.shape[0] < 16:
        return None

    pulse = _pos_overlap_add(rs, fs)
    pulse = signal.detrend(pulse, type="linear")
    pulse = _bandpass(pulse, fs, fmin, fmax)

    # ゼロ詰めで周波数分解能を上げる(窓を伸ばさずにBPM精度を改善)。
    nfft = int(2 ** np.ceil(np.log2(max(256, pulse.size * 4))))
    win = signal.windows.hann(pulse.size)
    mag = np.abs(np.fft.rfft(pulse * win, n=nfft))
    freqs = np.fft.rfftfreq(nfft, d=1.0 / fs)
    band = (freqs >= fmin) & (freqs <= fmax)
    if not band.any():
        return None

    band_mag = mag[band]
    band_freq = freqs[band]
    power = band_mag ** 2
    if not np.isfinite(power).all() or power.sum() <= 1e-12:
        return None
    peak = int(np.argmax(power))

    # 放物線補間でピーク周波数をサブビン精度に(BPMのガタつきを抑える)
    f_peak = float(band_freq[peak])
    if 0 < peak < power.size - 1:
        y0, y1, y2 = power[peak - 1], power[peak], power[peak + 1]
        denom = y0 - 2.0 * y1 + y2
        if denom != 0.0:
            delta = 0.5 * (y0 - y2) / denom
            if -1.0 < delta < 1.0:
                f_peak += delta * (band_freq[1] - band_freq[0])
    bpm = float(f_peak * 60.0)

    # 帯域内SNR: ピーク±0.2Hz の主ローブ vs それ以外(ノイズ)。
    sig_mask = np.abs(band_freq - band_freq[peak]) <= 0.2
    sig = float(power[sig_mask].sum())
    noise = float(power[~sig_mask].sum()) + 1e-9
    snr_db = float(10.0 * np.log10(sig / noise))

    # 信頼度: SNRをシグモイドで 0..1 に写像。実測で脈波がロックした状態
    # (SNR~3dB以上)で 0.9+、ノイズだけ(SNR<0)では 0.3未満になるよう較正。
    #   SNR  3dB -> 0.90 / 4dB -> 0.95 / -1.5dB(noise) -> 0.30
    confidence = float(1.0 / (1.0 + np.exp(-(snr_db + 0.25) / 1.5)))

    return PulseResult(pulse=pulse, fs=fs, bpm=bpm,
                       confidence=confidence, snr_db=snr_db)


def estimate_bpm(times, rgb, fmin: float = FMIN, fmax: float = FMAX):
    """後方互換: (bpm, confidence) を返す。"""
    res = compute_pulse(times, rgb, fmin, fmax)
    if res is None:
        return 0.0, 0.0
    return res.bpm, res.confidence
