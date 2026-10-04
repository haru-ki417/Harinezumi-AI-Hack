// backend/vital/session.py の ClientState をブラウザ向けに移植したもの。
// 顔ROIの平均RGBを受け取り、BPM / HRV / ストレスの推定・平滑化・異常判定を行う。
// 計算はすべて端末内で完結し、映像はどこにも送信しない。

import { computePulse, hrvFromPulse, stressScore, median, MIN_DURATION } from './dsp.js';

export const SETTINGS = Object.freeze({
  windowSec: 20.0,
  minSamples: 8,
  minFpsForHr: 10.0,
  confMin: 0.40,
  snrMinDb: 0.5,
  bpmSmooth: 0.45,
  rmssdSmooth: 0.30,
  anomHistorySec: 60.0,
  anomBaselineLag: 3.0,
  anomMinBaseline: 3,
  anomDeltaBpm: 12.0,
  stressAnomThreshold: 55.0,
});

const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };
const clip01 = (v) => Math.min(1, Math.max(0, v));

function trim(hist, cutoff) {
  while (hist.length && hist[0][0] < cutoff) hist.shift();
}

export class VitalSession {
  constructor(settings = SETTINGS) {
    this.s = settings;
    this.reset();
  }

  reset() {
    this.buf = [];
    this.bpm = 0; this.conf = 0; this.snrDb = 0;
    this.rmssd = 0; this.sdnn = 0; this.stress = 0;
    this.bpmHistory = [];
    this.rmssdHistory = [];
    this.lastCompute = -Infinity;
    this.status = 'warming_up';
    this.signalSeconds = 0;
    this.displayBpm = null;
    this.displayStress = null;
    this.displaySource = 'none';
    this.displayConfidence = null;
    this.displayHrBase = null;
    this.displayRmssdBase = null;
    this.lastResult = this._state(false);
  }

  add(t, rgb) {
    if (![t, ...rgb].every(Number.isFinite) || Math.min(...rgb) <= 0) {
      this.buf.length = 0;
      this.lastCompute = -Infinity;
      return;
    }
    const prev = this.buf[this.buf.length - 1];
    if (prev) {
      if (t <= prev[0]) return;
      if (t - prev[0] > 0.35) {
        // フレームが途切れたら脈波窓は破棄。3秒以内の中断ならベースラインは保持。
        this.buf.length = 0;
        if (t - prev[0] > 3.0) { this.bpmHistory.length = 0; this.rmssdHistory.length = 0; }
        this.bpm = this.rmssd = this.sdnn = this.stress = 0;
        this.lastCompute = -Infinity;
      } else {
        // 単発の外れフレームはそのフレームだけ捨てる。
        let jump = 0;
        for (let c = 0; c < 3; c++) jump = Math.max(jump, Math.abs(rgb[c] / prev[c + 1] - 1));
        if (jump > 0.12) return;
      }
    }
    this.buf.push([t, rgb[0], rgb[1], rgb[2]]);
    const cutoff = t - this.s.windowSec;
    let drop = 0;
    while (drop < this.buf.length && this.buf[drop][0] < cutoff) drop++;
    if (drop) this.buf.splice(0, drop);
  }

  _baseline(hist, t) {
    const eligible = hist.filter(([tt]) => tt < t - this.s.anomBaselineLag);
    if (eligible.length < this.s.anomMinBaseline || eligible.length < 2
        || eligible[eligible.length - 1][0] - eligible[0][0] < 15) return 0;
    return median(eligible.map(([, v]) => v));
  }

  compute(t) {
    const s = this.s;
    const b = this.buf;
    this.signalSeconds = b.length > 1 ? b[b.length - 1][0] - b[0][0] : 0;
    if (b.length < s.minSamples) {
      this.status = 'warming_up';
      return this._state(false);
    }
    if (t - this.lastCompute < 0.4) return this.lastResult;

    const times = b.map((r) => r[0]);
    const rgb = b.map((r) => [r[1], r[2], r[3]]);
    const dur = times[times.length - 1] - times[0];
    const effFps = dur > 0 ? (times.length - 1) / dur : 0;

    const tEnd = times[times.length - 1];
    let first = 0;
    while (first < times.length && times[first] < tEnd - 8) first++;
    const res = computePulse(times.slice(first), rgb.slice(first));
    if (!res || !Number.isFinite(res.bpm) || res.bpm <= 0 || effFps < s.minFpsForHr) {
      this.status = dur < MIN_DURATION ? 'warming_up'
        : effFps < s.minFpsForHr ? 'low_fps' : 'unstable_signal';
      this.lastCompute = t;
      this.lastResult = this._state(false, effFps);
      return this.lastResult;
    }

    // 信頼度が低くても表示用の推定値は出す（保存・判定には使わない）。
    this.displayBpm = this.displayBpm == null ? res.bpm
      : (1 - s.bpmSmooth) * this.displayBpm + s.bpmSmooth * res.bpm;
    if (this.displayHrBase == null) this.displayHrBase = this.displayBpm;
    this.displayStress = 100 * clip01((this.displayBpm - this.displayHrBase) / (0.25 * this.displayHrBase));
    this.displaySource = 'heart_rate';
    this.displayConfidence = res.confidence;
    if (res.confidence < s.confMin || res.snrDb < s.snrMinDb) {
      this.status = 'unstable_signal';
      this.lastCompute = t;
      this.lastResult = this._state(false, effFps, { displayFresh: true });
      return this.lastResult;
    }

    this.bpm = this.bpm <= 0 ? res.bpm : (1 - s.bpmSmooth) * this.bpm + s.bpmSmooth * res.bpm;
    this.conf = res.confidence;
    this.snrDb = res.snrDb;
    const lastB = this.bpmHistory[this.bpmHistory.length - 1];
    if (!lastB || t - lastB[0] >= 1) this.bpmHistory.push([t, this.bpm]);
    trim(this.bpmHistory, t - s.anomHistorySec);

    // HRV（12秒以上・15fps以上のときのみ）
    const longRes = dur >= 12 && effFps >= 15 ? computePulse(times, rgb) : null;
    let hrv = longRes && longRes.confidence >= s.confMin && longRes.snrDb >= s.snrMinDb
      ? hrvFromPulse(longRes.pulse, longRes.fs) : null;
    if (hrv && Math.abs(hrv.meanHr - res.bpm) > 10) hrv = null;
    if (hrv) {
      this.rmssd = this.rmssd <= 0 ? hrv.rmssd : (1 - s.rmssdSmooth) * this.rmssd + s.rmssdSmooth * hrv.rmssd;
      this.sdnn = hrv.sdnn;
      const lastR = this.rmssdHistory[this.rmssdHistory.length - 1];
      if (!lastR || t - lastR[0] >= 1) this.rmssdHistory.push([t, this.rmssd]);
      trim(this.rmssdHistory, t - s.anomHistorySec);
      if (this.displayRmssdBase == null && this.rmssd > 0) this.displayRmssdBase = this.rmssd;
      if (this.displayRmssdBase != null) {
        this.displayStress = stressScore(this.bpm, this.rmssd, this.displayHrBase, this.displayRmssdBase);
        this.displaySource = 'hrv';
      }
    }

    const bpmBase = this._baseline(this.bpmHistory, t);
    const rmssdBase = this._baseline(this.rmssdHistory, t);
    const stressValid = !!hrv && bpmBase > 0 && rmssdBase > 0;
    this.status = stressValid ? 'measuring' : effFps < 15 ? 'low_fps'
      : (hrv || dur < 12) ? 'calibrating' : 'unstable_hrv';
    if (stressValid) {
      this.stress = stressScore(this.bpm, this.rmssd, bpmBase, rmssdBase);
      this.displayStress = this.stress;
      this.displaySource = 'calibrated';
    }
    this.displayBpm = this.bpm;

    let anomalous = false;
    if (bpmBase > 0 && this.bpm - bpmBase >= s.anomDeltaBpm) anomalous = true;
    if (stressValid && this.stress >= s.stressAnomThreshold) anomalous = true;

    this.lastCompute = t;
    this.lastResult = this._state(anomalous, effFps, { measurementValid: true, stressValid, displayFresh: true });
    return this.lastResult;
  }

  process(t, rgb) {
    this.add(t, rgb);
    return this.compute(t);
  }

  /** 顔が見つからないフレーム用（session.py の peek 相当）。 */
  peek() {
    const r = this._state(false, this.lastResult.effFps);
    r.measurementStatus = 'no_face';
    return r;
  }

  _state(anomalous, effFps = 0, { measurementValid = false, stressValid = false, displayFresh = false } = {}) {
    return {
      currentBpm: round(this.bpm, 1),
      isAnomalous: anomalous,
      confidence: round(this.conf, 3),
      snrDb: round(this.snrDb, 1),
      hrvRmssd: round(this.rmssd, 1),
      hrvSdnn: round(this.sdnn, 1),
      stress: round(this.stress, 1),
      effFps: round(effFps, 1),
      measurementValid,
      stressValid,
      measurementStatus: this.status,
      signalSeconds: round(this.signalSeconds, 1),
      displayBpm: this.displayBpm == null ? null : round(this.displayBpm, 1),
      displayStress: this.displayStress == null ? null : round(this.displayStress, 1),
      displaySource: this.displaySource,
      displayFresh,
      displayConfidence: this.displayConfidence == null ? null : round(this.displayConfidence, 3),
    };
  }
}

export const STATUS_LABELS = {
  warming_up: '計測を準備中',
  no_face: '顔が見つかりません',
  low_fps: 'フレームレートが不足',
  unstable_signal: '信号が不安定',
  calibrating: '平常値を記録中',
  unstable_hrv: '心拍変動を安定化中',
  measuring: '計測中',
};
