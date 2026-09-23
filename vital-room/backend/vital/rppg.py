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
MIN_DURATION = 6.0


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
    n = max(2, int(round((t1 - t0) * fps)))
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
    # 投影行列 P = [[0,1,-1],[-2,1,1]]
    for m in range(0, n - wl + 1):
        c = rgb[m:m + wl]                           # (wl,3)
        mean = c.mean(axis=0) + eps
        cn = c / mean                               # 時間正規化
        s1 = cn[:, 1] - cn[:, 2]                    # G - B
        s2 = -2.0 * cn[:, 0] + cn[:, 1] + cn[:, 2]  # -2R + G + B
        alpha = (s1.std() + eps) / (s2.std() + eps)
        hh = s1 + alpha * s2
        h[m:m + wl] += hh - hh.mean()               # overlap-add
    return h


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
    if times.size < 8 or rgb.shape[0] != times.size:
        return None
    duration = float(times[-1] - times[0])
    if duration < MIN_DURATION:
        return None

    _, rs = _resample_uniform(times, rgb, target_fps)
    fs = target_fps
    if rs.shape[0] < 16:
        return None

    pulse = _pos_overlap_add(rs, fs)
    pulse = signal.detrend(pulse, type="linear")
    pulse = _bandpass(pulse, fs, fmin, fmax)

    win = signal.windows.hann(pulse.size)
    mag = np.abs(np.fft.rfft(pulse * win))
    freqs = np.fft.rfftfreq(pulse.size, d=1.0 / fs)
    band = (freqs >= fmin) & (freqs <= fmax)
    if not band.any():
        return None

    band_mag = mag[band]
    band_freq = freqs[band]
    power = band_mag ** 2
    peak = int(np.argmax(power))
    bpm = float(band_freq[peak] * 60.0)

    total = power.sum() + 1e-9
    confidence = float(power[peak] / total)
    sig_mask = np.abs(band_freq - band_freq[peak]) <= 0.2
    sig = power[sig_mask].sum()
    noise = power[~sig_mask].sum() + 1e-9
    snr_db = float(10.0 * np.log10(sig / noise))

    return PulseResult(pulse=pulse, fs=fs, bpm=bpm,
                       confidence=confidence, snr_db=snr_db)


def estimate_bpm(times, rgb, fmin: float = FMIN, fmax: float = FMAX):
    """後方互換: (bpm, confidence) を返す。"""
    res = compute_pulse(times, rgb, fmin, fmax)
    if res is None:
        return 0.0, 0.0
    return res.bpm, res.confidence
