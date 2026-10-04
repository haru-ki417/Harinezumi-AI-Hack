// Vital Room Web — rPPG の信号処理（サーバー版 backend/vital/rppg.py・hrv.py を JavaScript に移したもの）
//   POS 法（Wang 2017）の overlap-add → 直線のトレンド除去 → 4 次バターワースの帯域通過（前後 2 回）
//   → ハン窓 + ゼロ詰め FFT → 放物線補間 → SNR・信頼度。HRV はピーク検出 → IBI → RMSSD / SDNN。
//   数値は numpy / scipy と同じ手順で計算する（test/dsp.test.mjs でサーバー版と結果を比べる）。

export const FMIN = 0.7;   // 42 BPM
export const FMAX = 4.0;   // 240 BPM
export const TARGET_FPS = 30;
export const MIN_DURATION = 4.5;

// ---------------------------------------------------------------- 小さな道具
const mean = a => { let s = 0; for (const v of a) s += v; return s / a.length; };
const std = a => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / a.length); };

function quantile(values, q) {
  const s = Float64Array.from(values).sort();
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export function median(values) { return quantile(values, 0.5); }

function interp(x, xp, fp) {
  // np.interp（xp は増加）
  const out = new Float64Array(x.length);
  let j = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v <= xp[0]) { out[i] = fp[0]; continue; }
    if (v >= xp[xp.length - 1]) { out[i] = fp[fp.length - 1]; continue; }
    while (j < xp.length - 2 && xp[j + 1] < v) j++;
    while (j > 0 && xp[j] > v) j--;
    const t = (v - xp[j]) / (xp[j + 1] - xp[j]);
    out[i] = fp[j] + (fp[j + 1] - fp[j]) * t;
  }
  return out;
}

function linspace(a, b, n) {
  const out = new Float64Array(n);
  const step = (b - a) / (n - 1);
  for (let i = 0; i < n; i++) out[i] = a + step * i;
  out[n - 1] = b;
  return out;
}

// ---------------------------------------------------------------- 複素数（フィルターの設計用）
const C = (re, im = 0) => ({ re, im });
const cadd = (a, b) => C(a.re + b.re, a.im + b.im);
const csub = (a, b) => C(a.re - b.re, a.im - b.im);
const cmul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cdiv = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const cscale = (a, s) => C(a.re * s, a.im * s);
function csqrt(a) {
  const r = Math.hypot(a.re, a.im);
  const re = Math.sqrt((r + a.re) / 2), im = Math.sqrt(Math.max(0, (r - a.re) / 2));
  return C(re, a.im < 0 ? -im : im);
}
function poly(roots) {
  // np.poly（実係数になる組の根）
  let c = [C(1)];
  for (const r of roots) {
    const next = new Array(c.length + 1).fill(null).map(() => C(0));
    for (let i = 0; i < c.length; i++) {
      next[i] = cadd(next[i], c[i]);
      next[i + 1] = csub(next[i + 1], cmul(c[i], r));
    }
    c = next;
  }
  return c.map(v => v.re);
}

/** scipy.signal.butter(order, [low, high], btype='band') と同じ係数（周波数はナイキストで割った値） */
export function butterBandpass(order, low, high) {
  const fs = 2, fs2 = 2 * fs;
  const w1 = 2 * fs * Math.tan(Math.PI * low / fs), w2 = 2 * fs * Math.tan(Math.PI * high / fs);
  const bw = w2 - w1, wo = Math.sqrt(w1 * w2);
  // アナログの原型（buttap）
  const p = [];
  for (let m = -order + 1; m < order; m += 2) {
    const th = Math.PI * m / (2 * order);
    p.push(C(-Math.cos(th), -Math.sin(th)));
  }
  // lp2bp_zpk
  const pbp = [];
  const plp = p.map(v => cscale(v, bw / 2));
  for (const v of plp) pbp.push(cadd(v, csqrt(csub(cmul(v, v), C(wo * wo)))));
  for (const v of plp) pbp.push(csub(v, csqrt(csub(cmul(v, v), C(wo * wo)))));
  const zbp = new Array(order).fill(null).map(() => C(0));
  let k = Math.pow(bw, order);
  // bilinear_zpk
  const zz = zbp.map(z => cdiv(cadd(C(fs2), z), csub(C(fs2), z)));
  const pz = pbp.map(q => cdiv(cadd(C(fs2), q), csub(C(fs2), q)));
  for (let i = 0; i < pbp.length - zbp.length; i++) zz.push(C(-1));
  let num = C(1), den = C(1);
  for (const z of zbp) num = cmul(num, csub(C(fs2), z));
  for (const q of pbp) den = cmul(den, csub(C(fs2), q));
  k *= cdiv(num, den).re;
  const b = poly(zz).map(v => v * k);
  const a = poly(pz);
  return { b, a };
}

function lfilter(b, a, x, zi) {
  // scipy.signal.lfilter（直接形 II 転置）。a[0] = 1 を前提
  const n = Math.max(a.length, b.length);
  const bb = b.concat(new Array(n - b.length).fill(0)), aa = a.concat(new Array(n - a.length).fill(0));
  const z = zi ? zi.slice() : new Array(n - 1).fill(0);
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const yi = bb[0] * xi + (z[0] || 0);
    for (let j = 1; j < n - 1; j++) z[j - 1] = bb[j] * xi + z[j] - aa[j] * yi;
    if (n > 1) z[n - 2] = bb[n - 1] * xi - aa[n - 1] * yi;
    y[i] = yi;
  }
  return y;
}

function lfilterZi(b, a) {
  // scipy.signal.lfilter_zi: (I - A^T) zi = B
  const n = a.length;
  const m = n - 1;
  const IminusA = [];
  for (let r = 0; r < m; r++) {
    IminusA.push(new Array(m).fill(0));
  }
  // companion(a).T
  // companion: first row = -a[1:]/a[0], subdiagonal ones
  for (let r = 0; r < m; r++) {
    for (let c = 0; c < m; c++) {
      let comp = 0; // companion[c][r]（転置）
      if (c === 0) comp = -a[r + 1] / a[0];
      else if (c === r + 1) comp = 1;
      IminusA[r][c] = (r === c ? 1 : 0) - comp;
    }
  }
  const B = [];
  for (let i = 1; i < n; i++) B.push(b[i] - a[i] * b[0]);
  // ガウスの消去法
  const M = IminusA.map((row, i) => row.concat([B[i]]));
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < m; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let c = col; c <= m; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[m] / row[i]);
}

/** scipy.signal.filtfilt(b, a, x)（padtype='odd'、padlen = 3 * max(len(a), len(b))） */
export function filtfilt(b, a, x) {
  const padlen = 3 * Math.max(a.length, b.length);
  if (x.length <= padlen) throw new RangeError('signal too short');
  const n = x.length;
  const ext = new Float64Array(n + 2 * padlen);
  for (let i = 0; i < padlen; i++) ext[i] = 2 * x[0] - x[padlen - i];
  for (let i = 0; i < n; i++) ext[padlen + i] = x[i];
  for (let i = 0; i < padlen; i++) ext[padlen + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  const zi = lfilterZi(b, a);
  let y = lfilter(b, a, ext, zi.map(v => v * ext[0]));
  y = y.reverse();
  y = lfilter(b, a, y, zi.map(v => v * y[0]));
  y = y.reverse();
  return y.slice(padlen, padlen + n);
}

function detrendLinear(x) {
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const icpt = (sy - slope * sx) / n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] - (icpt + slope * i);
  return out;
}

function hann(m) {
  const w = new Float64Array(m);
  if (m === 1) { w[0] = 1; return w; }
  for (let i = 0; i < m; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (m - 1));
  return w;
}

function rfftPower(x, nfft) {
  // ゼロ詰めした実数列の FFT（基数 2）。|X|² を 0..nfft/2 で返す
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  re.set(x.subarray ? x.subarray(0, Math.min(x.length, nfft)) : x.slice(0, nfft));
  for (let i = 1, j = 0; i < nfft; i++) {
    let bit = nfft >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= nfft; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < nfft; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  const out = new Float64Array(nfft / 2 + 1);
  for (let i = 0; i < out.length; i++) out[i] = re[i] * re[i] + im[i] * im[i];
  return out;
}

// ---------------------------------------------------------------- POS（overlap-add）
function posOverlapAdd(rgb, fs) {
  const n = rgb.length;
  const h = new Float64Array(n);
  let wl = Math.max(8, Math.round(1.6 * fs));
  if (n < wl) wl = n;
  const eps = 1e-9;
  const s1 = new Float64Array(wl), s2 = new Float64Array(wl);
  for (let start = 0; start + wl <= n; start++) {
    let mr = 0, mg = 0, mb = 0;
    for (let k = 0; k < wl; k++) { const v = rgb[start + k]; mr += v[0]; mg += v[1]; mb += v[2]; }
    mr = mr / wl + eps; mg = mg / wl + eps; mb = mb / wl + eps;
    for (let k = 0; k < wl; k++) {
      const v = rgb[start + k];
      const r = v[0] / mr, g = v[1] / mg, b = v[2] / mb;
      s1[k] = g - b;
      s2[k] = -2 * r + g + b;
    }
    const alpha = (std(s1) + eps) / (std(s2) + eps);
    let m = 0;
    for (let k = 0; k < wl; k++) { s1[k] = s1[k] + alpha * s2[k]; m += s1[k]; }
    m /= wl;
    for (let k = 0; k < wl; k++) h[start + k] += s1[k] - m;
  }
  return h;
}

function bandpass(x, fs, fmin, fmax) {
  const nyq = fs / 2;
  const low = Math.max(fmin / nyq, 1e-3), high = Math.min(fmax / nyq, 0.99);
  const m = mean(x);
  if (low >= high) return x.map(v => v - m);
  try {
    const { b, a } = butterBandpass(4, low, high);
    return filtfilt(b, a, x);
  } catch {
    return x.map(v => v - m);
  }
}

/**
 * RGB の時系列（不等間隔でよい）から脈波・心拍数・信頼度を求める（rppg.compute_pulse）。データが足りなければ null。
 * times: 秒、rgb: [[r, g, b], ...]
 */
export function computePulse(times, rgb, fmin = FMIN, fmax = FMAX, targetFps = TARGET_FPS) {
  const n = times.length;
  if (n < 8 || rgb.length !== n) return null;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(times[i])) return null;
    const v = rgb[i];
    if (!(v[0] > 0 && v[1] > 0 && v[2] > 0) || !Number.isFinite(v[0] + v[1] + v[2])) return null;
  }
  const duration = times[n - 1] - times[0];
  if (duration < MIN_DURATION) return null;
  const intervals = [];
  for (let i = 1; i < n; i++) intervals.push(times[i] - times[i - 1]);
  const observedFps = (n - 1) / duration;
  if (intervals.some(v => v <= 0) || observedFps < Math.max(10, 2.5 * fmax)
      || Math.max(...intervals) > 0.35 || quantile(intervals, 0.95) > 0.15) return null;

  const fpsGrid = Math.min(targetFps, observedFps);
  const m = Math.max(2, Math.round(duration * fpsGrid) + 1);
  const grid = linspace(times[0], times[n - 1], m);
  const chan = c => interp(grid, times, rgb.map(v => v[c]));
  const R = chan(0), G = chan(1), B = chan(2);
  const fs = (m - 1) / (grid[m - 1] - grid[0]);
  if (m < 16) return null;
  const rs = Array.from({ length: m }, (_, i) => [R[i], G[i], B[i]]);

  let pulse = posOverlapAdd(rs, fs);
  pulse = detrendLinear(pulse);
  pulse = bandpass(pulse, fs, fmin, fmax);

  const nfft = 2 ** Math.ceil(Math.log2(Math.max(256, pulse.length * 4)));
  const win = hann(pulse.length);
  const windowed = new Float64Array(pulse.length);
  for (let i = 0; i < pulse.length; i++) windowed[i] = pulse[i] * win[i];
  const power = rfftPower(windowed, nfft);
  const df = fs / nfft;
  const bandIdx = [];
  for (let i = 0; i < power.length; i++) { const f = i * df; if (f >= fmin && f <= fmax) bandIdx.push(i); }
  if (!bandIdx.length) return null;
  const bp = bandIdx.map(i => power[i]);
  const bf = bandIdx.map(i => i * df);
  const total = bp.reduce((s, v) => s + v, 0);
  if (!Number.isFinite(total) || total <= 1e-12) return null;
  let peak = 0;
  for (let i = 1; i < bp.length; i++) if (bp[i] > bp[peak]) peak = i;
  let fPeak = bf[peak];
  if (peak > 0 && peak < bp.length - 1) {
    const y0 = bp[peak - 1], y1 = bp[peak], y2 = bp[peak + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      const delta = 0.5 * (y0 - y2) / denom;
      if (delta > -1 && delta < 1) fPeak += delta * (bf[1] - bf[0]);
    }
  }
  const bpm = fPeak * 60;
  let sig = 0, noise = 1e-9;
  for (let i = 0; i < bp.length; i++) { if (Math.abs(bf[i] - bf[peak]) <= 0.2) sig += bp[i]; else noise += bp[i]; }
  const snrDb = 10 * Math.log10(sig / noise);
  const confidence = 1 / (1 + Math.exp(-(snrDb + 0.25) / 1.5));
  return { pulse, fs, bpm, confidence, snrDb };
}

// ---------------------------------------------------------------- ピーク検出（scipy.signal.find_peaks の distance・prominence）
export function findPeaks(x, distance, prominence) {
  // 極大（平らな頂上は真ん中）
  let peaks = [];
  let i = 1;
  const last = x.length - 1;
  while (i < last) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < last && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) { peaks.push(Math.floor((i + ahead - 1) / 2)); i = ahead; }
    }
    i++;
  }
  // 近すぎるピークは高い方を残す
  if (distance > 1 && peaks.length) {
    const d = Math.ceil(distance);
    const keep = new Array(peaks.length).fill(true);
    const order = peaks.map((p, k) => k).sort((a, b) => x[peaks[a]] - x[peaks[b]] || a - b);
    for (let o = order.length - 1; o >= 0; o--) {
      const j = order[o];
      if (!keep[j]) continue;
      for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < d; k--) keep[k] = false;
      for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < d; k++) keep[k] = false;
    }
    peaks = peaks.filter((_, k) => keep[k]);
  }
  // 際立ち（prominence）
  return peaks.filter(peak => {
    let leftMin = x[peak];
    for (let k = peak; k >= 0 && x[k] <= x[peak]; k--) if (x[k] < leftMin) leftMin = x[k];
    let rightMin = x[peak];
    for (let k = peak; k <= last && x[k] <= x[peak]; k++) if (x[k] < rightMin) rightMin = x[k];
    return x[peak] - Math.max(leftMin, rightMin) >= prominence;
  });
}

/** 脈波から HRV（hrv.hrv_from_pulse）。拍が足りなければ null */
export function hrvFromPulse(pulse, fs, fmax = FMAX) {
  if (fs < 15 || pulse.length < Math.floor(fs * 12)) return null;
  const m = mean(pulse), s = std(pulse);
  if (s <= 1e-9) return null;
  const p = pulse.map(v => (v - m) / s);
  const minDist = Math.max(1, Math.floor(fs / fmax));
  const peaks = findPeaks(p, minDist, 0.3);
  if (peaks.length < 10) return null;
  const refined = peaks.map(peak => {
    const den = p[peak - 1] - 2 * p[peak] + p[peak + 1];
    return Math.abs(den) > 1e-9 ? peak + Math.max(-0.5, Math.min(0.5, 0.5 * (p[peak - 1] - p[peak + 1]) / den)) : peak;
  });
  const ibi = [];
  for (let i = 1; i < refined.length; i++) ibi.push((refined[i] - refined[i - 1]) / fs * 1000);
  const med = median(ibi);
  const valid = ibi.map(v => v >= 300 && v <= 1500 && Math.abs(v - med) <= 0.25 * med);
  const adjacent = [];
  for (let i = 0; i < valid.length - 1; i++) adjacent.push(valid[i] && valid[i + 1]);
  const validRatio = valid.filter(Boolean).length / valid.length;
  if (validRatio < 0.9 || adjacent.filter(Boolean).length < 7) return null;
  const diffs = [];
  for (let i = 0; i < adjacent.length; i++) if (adjacent[i]) diffs.push((ibi[i + 1] - ibi[i]) ** 2);
  const rmssd = Math.sqrt(mean(diffs));
  const ok = ibi.filter((_, i) => valid[i]);
  return { meanHr: 60000 / mean(ok), rmssd, sdnn: std(ok), beats: ok.length + 1 };
}

/** 平常時からのずれでストレスを 0..100（hrv.stress_score）。心拍 +25%・RMSSD -50% で最大 */
export function stressScore(hr, rmssd, hrBase, rmssdBase) {
  if (hrBase <= 0 || rmssdBase <= 0) return 0;
  const clip = v => Math.max(0, Math.min(1, v));
  const hrC = clip((hr - hrBase) / (0.25 * hrBase));
  const rC = clip((rmssdBase - rmssd) / (0.5 * rmssdBase));
  return Math.round(1000 * (0.5 * hrC + 0.5 * rC)) / 10;
}
