// カメラ映像 → 顔ROIのRGB → VitalSession をフレームごとに回すループ。
// 映像はこのページの中だけで処理し、保存も送信もしない。

import { loadDetector, FaceTracker } from './face.js';
import { VitalSession } from './session.js';

export class VitalMonitor {
  /**
   * @param {{ onState?: (state, info) => void }} opts
   *   info = { box: [x,y,w,h] (0..1) | null, face: boolean }
   */
  constructor({ onState } = {}) {
    this.onState = onState || (() => {});
    this.session = new VitalSession();
    this.tracker = new FaceTracker();
    this.video = null;
    this.detector = null;
    this.running = false;
    this.handle = 0;
    this.state = this.session.lastResult;
    this.box = null;
  }

  async start(video) {
    this.video = video;
    this.detector = await loadDetector();
    if (this.running) return;
    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.video && this.handle && this.video.cancelVideoFrameCallback) {
      try { this.video.cancelVideoFrameCallback(this.handle); } catch { /* noop */ }
    } else if (this.handle) cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  /** 平常値（ベースライン）と脈波バッファを捨てて計測をやり直す。 */
  reset() {
    this.session.reset();
    this.tracker.reset();
    this.state = this.session.lastResult;
  }

  _schedule() {
    if (!this.running) return;
    const v = this.video;
    if (v && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.handle = v.requestVideoFrameCallback(() => this._tick());
    } else {
      this.handle = requestAnimationFrame(() => this._tick());
    }
  }

  _tick() {
    if (!this.running) return;
    const v = this.video;
    try {
      if (v && v.readyState >= 2 && !v.paused) {
        const now = performance.now();
        const { rgb, box } = this.tracker.process(this.detector, v, now);
        this.box = box;
        const t = now / 1000;
        this.state = rgb ? this.session.process(t, rgb) : this.session.peek();
        this.onState(this.state, { box, face: !!rgb });
      }
    } catch (err) {
      console.warn('vital frame skipped', err);
    }
    this._schedule();
  }
}

/** 表示用：状態から「今見せる値」を決める。 */
export function displayValues(state) {
  const bpm = state.measurementValid ? state.currentBpm : state.displayBpm;
  const stress = state.stressValid ? state.stress : state.displayStress;
  return {
    bpm: bpm && bpm > 0 ? bpm : null,
    stress: stress == null ? null : stress,
    reliable: state.measurementValid,
    calibrated: state.stressValid,
  };
}
