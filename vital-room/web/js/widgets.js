// バイタル表示の部品（ひとりで計測・ルーム・AI面接で共通）。

import { h, icon, fmt, stressLabel } from './ui.js';
import { STATUS_LABELS } from './session.js';
import { displayValues } from './vitals.js';

export const STATUS_HINTS = {
  warming_up: '顔をカメラの正面に向け、そのまま数秒お待ちください。',
  no_face: '顔が枠に入るように、カメラとの距離や向きを調整してください。',
  low_fps: '映像のコマ数が足りません。明るい場所に移るか、ほかのアプリやタブを閉じてください。',
  unstable_signal: '体や顔をなるべく動かさず、顔に均一な光が当たるようにしてください。',
  calibrating: '平常時の値を記録しています。落ち着いた姿勢で15秒ほど続けてください。',
  unstable_hrv: '心拍の間隔を安定して取れていません。動きを少なくしてください。',
  measuring: '計測中です。平常時と比べた変化を表示しています。',
};

/** 心拍・ストレス・HRV を並べた大きな表示。 */
export function vitalPanel({ compact = false } = {}) {
  const bpm = h('span', { class: 'big-num' }, '--');
  const heart = h('span', { class: 'heart' }, icon('heart', compact ? 18 : 22));
  const conf = h('span', { class: 'pill' }, '準備中');
  const meterFill = h('i');
  const stressVal = h('b', null, '--');
  const stressText = h('span', null, '—');
  const rmssd = h('b', null, '--');
  const sdnn = h('b', null, '--');
  const fps = h('b', null, '--');
  const status = h('strong', null, STATUS_LABELS.warming_up);
  const hint = h('p', { class: 'hint' }, STATUS_HINTS.warming_up);
  const statusDot = h('span', { class: 'dot' });

  const el = h('section', { class: `vital-panel ${compact ? 'compact' : ''}`, 'aria-label': 'バイタル' },
    h('div', { class: 'vp-head' },
      h('div', { class: 'vp-bpm' }, heart, bpm, h('small', null, 'BPM')),
      conf),
    h('div', { class: 'vp-stress' },
      h('div', { class: 'vp-row' }, h('span', null, 'ストレス指標'), h('span', { class: 'vp-sv' }, stressVal, stressText)),
      h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'ストレス指標' }, meterFill)),
    compact ? null : h('dl', { class: 'vp-stats' },
      h('div', null, h('dt', null, 'RMSSD'), h('dd', null, rmssd, h('small', null, ' ms'))),
      h('div', null, h('dt', null, 'SDNN'), h('dd', null, sdnn, h('small', null, ' ms'))),
      h('div', null, h('dt', null, 'フレーム'), h('dd', null, fps, h('small', null, ' fps')))),
    h('div', { class: 'vp-status' }, statusDot, h('div', null, status, compact ? null : hint)));

  return {
    el,
    update(state) {
      const d = displayValues(state);
      bpm.textContent = fmt.bpm(d.bpm);
      heart.classList.toggle('beat', d.bpm != null);
      if (d.bpm) heart.style.setProperty('--beat', `${(60 / d.bpm).toFixed(2)}s`);
      conf.textContent = d.reliable ? (d.calibrated ? '平常比で表示' : '信頼度 良') : d.bpm ? '推定中（参考）' : '準備中';
      conf.className = `pill ${d.reliable ? 'ok' : d.bpm ? 'warn' : ''}`;
      const s = d.stress;
      meterFill.style.width = `${s == null ? 0 : Math.max(2, s)}%`;
      meterFill.className = s == null ? '' : s >= 55 ? 'high' : s >= 25 ? 'mid' : 'low';
      el.querySelector('.meter').setAttribute('aria-valuenow', s == null ? 0 : Math.round(s));
      stressVal.textContent = s == null ? '--' : Math.round(s);
      stressText.textContent = s == null ? '' : ` ${stressLabel(s)}${d.calibrated ? '' : '（暫定）'}`;
      rmssd.textContent = state.hrvRmssd > 0 ? fmt.num(state.hrvRmssd) : '--';
      sdnn.textContent = state.hrvSdnn > 0 ? fmt.num(state.hrvSdnn) : '--';
      fps.textContent = state.effFps > 0 ? fmt.num(state.effFps) : '--';
      status.textContent = STATUS_LABELS[state.measurementStatus] || state.measurementStatus;
      hint.textContent = STATUS_HINTS[state.measurementStatus] || '';
      statusDot.className = `dot ${state.measurementStatus === 'measuring' ? 'ok' : state.measurementStatus === 'no_face' || state.measurementStatus === 'low_fps' ? 'bad' : 'wait'}`;
      el.classList.toggle('alert', !!state.isAnomalous);
    },
  };
}

/** 小さなバッジ（映像タイル上に重ねる）。 */
export function vitalBadge() {
  const bpm = h('b', null, '--');
  const stress = h('i');
  const el = h('div', { class: 'vbadge' }, icon('heart', 14), bpm, h('small', null, 'BPM'), h('span', { class: 'mini-meter' }, stress));
  return {
    el,
    update(v) {
      if (!v) { el.classList.add('off'); bpm.textContent = '--'; stress.style.width = '0'; return; }
      el.classList.remove('off');
      bpm.textContent = fmt.bpm(v.bpm);
      stress.style.width = `${v.stress == null ? 0 : Math.max(3, v.stress)}%`;
      stress.className = v.stress == null ? '' : v.stress >= 55 ? 'high' : v.stress >= 25 ? 'mid' : 'low';
      el.classList.toggle('alert', !!v.alert);
      el.title = v.stress == null ? '' : `ストレス指標 ${Math.round(v.stress)}（${stressLabel(v.stress)}）`;
    },
  };
}
