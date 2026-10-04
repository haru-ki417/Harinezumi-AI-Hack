// 顔検出と ROI(額・両頬)の平均 RGB 抽出。
// backend/vital/face.py の ROI 比率・YCrCb 肌マスク・箱の平滑化をブラウザ向けに移植。
// 顔検出は MediaPipe Face Detector(BlazeFace short range)を端末内で実行する。

import { CDN } from './config.js';

const BOX_SMOOTH = 0.5;     // 顔箱の EMA 係数
const MISS_GRACE = 2;       // 検出失敗をこの回数まで許容（直近の箱を再利用）
const DETECT_EVERY = 2;     // 何フレームに 1 回検出するか
const SAMPLE_W = 320;       // RGB 抽出用に縮小する横幅

// 額 + 左右頬（顔箱に対する比率）。face.py と同じ。
export const ROI_REGIONS = [
  [0.30, 0.08, 0.40, 0.18],
  [0.12, 0.45, 0.24, 0.22],
  [0.64, 0.45, 0.24, 0.22],
];

let detectorPromise = null;

/** MediaPipe Face Detector を一度だけ読み込む。 */
export function loadDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const vision = await import(CDN.mediapipe + '/vision_bundle.mjs');
      const fileset = await vision.FilesetResolver.forVisionTasks(CDN.mediapipe + '/wasm');
      return vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: CDN.faceModel, delegate: 'CPU' },
        runningMode: 'VIDEO',
        minDetectionConfidence: 0.5,
      });
    })().catch((err) => { detectorPromise = null; throw err; });
  }
  return detectorPromise;
}

/** YCrCb の肌色範囲（OpenCV の 8bit 変換と同じ式）。 */
function isSkin(r, g, b) {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cr = (r - y) * 0.713 + 128;
  const cb = (b - y) * 0.564 + 128;
  return cr >= 133 && cr <= 173 && cb >= 77 && cb <= 127;
}

/** ROI の肌ピクセル平均 RGB。暗すぎ/白飛びが多い場合は null。 */
function meanRgbMasked(data) {
  const n = data.length / 4;
  if (!n) return null;
  let clipped = 0, sr = 0, sg = 0, sb = 0, sc = 0, ar = 0, ag = 0, ab = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum < 20 || lum > 245) clipped++;
    ar += r; ag += g; ab += b;
    if (isSkin(r, g, b)) { sr += r; sg += g; sb += b; sc++; }
  }
  if (clipped / n > 0.4) return null;
  return sc >= 30 ? [sr / sc, sg / sc, sb / sc] : [ar / n, ag / n, ab / n];
}

export class FaceTracker {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.reset();
  }

  reset() {
    this.box = null;     // 縮小キャンバス座標 [x, y, w, h]
    this.miss = 0;
    this.count = 0;
    this.lastTs = -1;
  }

  /**
   * 1 フレーム処理する。戻り値 { rgb, box } （box は 0..1 の正規化座標）。
   * 顔が無ければ rgb=null。
   */
  process(detector, video, tsMs) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return { rgb: null, box: null };
    const scale = Math.min(1, SAMPLE_W / vw);
    const w = Math.round(vw * scale), h = Math.round(vh * scale);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }

    const doDetect = this.box === null || this.count % DETECT_EVERY === 0;
    this.count++;
    if (doDetect) {
      // detectForVideo のタイムスタンプは単調増加でなければならない。
      const ts = Math.max(tsMs, this.lastTs + 1);
      this.lastTs = ts;
      let found = null;
      try {
        const res = detector.detectForVideo(video, ts);
        let best = 0;
        for (const d of res.detections || []) {
          const bb = d.boundingBox;
          if (bb && bb.width * bb.height > best) {
            best = bb.width * bb.height;
            found = [bb.originX * scale, bb.originY * scale, bb.width * scale, bb.height * scale];
          }
        }
      } catch { found = null; }
      if (found) {
        this.box = this.box ? this.box.map((o, i) => (1 - BOX_SMOOTH) * o + BOX_SMOOTH * found[i]) : found;
        this.miss = 0;
      } else if (this.box) {
        this.miss++;
        if (this.miss > MISS_GRACE) this.box = null;
      }
    }
    if (!this.box) return { rgb: null, box: null };

    this.ctx.drawImage(video, 0, 0, w, h);
    const [x, y, bw, bh] = this.box.map(Math.round);
    const acc = [];
    for (const [fx, fy, fw, fh] of ROI_REGIONS) {
      const rx0 = Math.max(0, x + Math.trunc(bw * fx)), ry0 = Math.max(0, y + Math.trunc(bh * fy));
      const rx1 = Math.min(w, x + Math.trunc(bw * fx) + Math.trunc(bw * fw));
      const ry1 = Math.min(h, y + Math.trunc(bh * fy) + Math.trunc(bh * fh));
      if (rx1 <= rx0 || ry1 <= ry0) continue;
      const m = meanRgbMasked(this.ctx.getImageData(rx0, ry0, rx1 - rx0, ry1 - ry0).data);
      if (m) acc.push(m);
    }
    const norm = [this.box[0] / w, this.box[1] / h, this.box[2] / w, this.box[3] / h];
    if (!acc.length) return { rgb: null, box: norm };
    const rgb = [0, 1, 2].map((c) => acc.reduce((s, v) => s + v[c], 0) / acc.length);
    return { rgb, box: norm };
  }
}
