import { h, icon, fmt, toast, store, lineChart, average, confirmDialog, download, stressLabel } from '../ui.js';
import { ensureConsent, openMedia, stopMedia, cameraStage, cameraErrorMessage, listCameras } from '../camera.js';
import { VitalMonitor, displayValues } from '../vitals.js';
import { vitalPanel } from '../widgets.js';
import { setLeaveGuard } from '../nav.js';

export const name = 'measure';

/** 1秒ごとの記録から結果サマリーを作る（保存・表示で共通）。 */
export function summarize(samples, durationSec) {
  const valid = samples.filter((s) => s.valid);
  const bpms = (valid.length >= 5 ? valid : samples).map((s) => s.bpm).filter((v) => v > 0);
  const stress = samples.filter((s) => s.calibrated).map((s) => s.stress);
  return {
    duration: Math.round(durationSec),
    bpmAvg: average(bpms), bpmMin: bpms.length ? Math.min(...bpms) : null, bpmMax: bpms.length ? Math.max(...bpms) : null,
    rmssdAvg: average(samples.map((s) => (s.rmssd > 0 ? s.rmssd : null))),
    stressAvg: average(stress), stressMax: stress.length ? Math.max(...stress) : null,
    reliableRatio: samples.length ? valid.length / samples.length : 0,
  };
}

export function summaryView(summary, samples) {
  const chart = h('canvas', { class: 'chart', height: 160 });
  const stressChart = h('canvas', { class: 'chart', height: 120 });
  const el = h('div', { class: 'summary' },
    h('div', { class: 'stat-grid' },
      stat('平均心拍', fmt.bpm(summary.bpmAvg), 'BPM'),
      stat('範囲', summary.bpmMin ? `${Math.round(summary.bpmMin)}–${Math.round(summary.bpmMax)}` : '--', 'BPM'),
      stat('平均 RMSSD', fmt.num(summary.rmssdAvg), 'ms'),
      stat('ストレス指標', summary.stressAvg == null ? '--' : Math.round(summary.stressAvg), summary.stressAvg == null ? '平常値の記録が足りません' : `平均 · 最大 ${Math.round(summary.stressMax)}（${stressLabel(summary.stressAvg)}）`),
      stat('計測時間', fmt.time(summary.duration), ''),
      stat('安定して取れた割合', `${Math.round(summary.reliableRatio * 100)}`, '%')),
    h('h3', { class: 'chart-title' }, '心拍の推移'), chart,
    h('h3', { class: 'chart-title' }, 'ストレス指標の推移'), stressChart);
  requestAnimationFrame(() => {
    lineChart(chart, [{ points: samples.filter((s) => s.bpm > 0).map((s) => [s.t, s.bpm]), color: '#ff5c7a' }], { tMin: 0, tMax: summary.duration });
    lineChart(stressChart, [{ points: samples.filter((s) => s.stress != null).map((s) => [s.t, s.stress]), color: '#94e4bb' }], { min: 0, max: 100, tMin: 0, tMax: summary.duration });
  });
  return el;
}

function stat(label, value, unit) {
  return h('div', { class: 'stat' }, h('span', null, label), h('b', null, value), unit ? h('small', null, unit) : null);
}

export function mount(root) {
  const stage = cameraStage();
  const panel = vitalPanel();
  const bpmChart = h('canvas', { class: 'chart', height: 130 });
  const stressChart = h('canvas', { class: 'chart', height: 100 });
  const timer = h('span', { class: 'timer' }, '0:00');
  const camSelect = h('select', { class: 'select', 'aria-label': 'カメラ', hidden: true });
  const startBtn = h('button', { class: 'btn primary' }, icon('play', 18), '計測をはじめる');
  const resetBtn = h('button', { class: 'btn ghost', disabled: true, title: '平常値を記録し直す' }, icon('refresh', 18), h('span', null, '平常値をリセット'));
  const finishBtn = h('button', { class: 'btn ghost', disabled: true }, icon('stop', 18), h('span', null, '終了'));
  const side = h('div', { class: 'm-side' },
    panel.el,
    h('div', { class: 'card charts' },
      h('h3', { class: 'chart-title' }, '心拍 ', h('small', null, 'BPM')), bpmChart,
      h('h3', { class: 'chart-title' }, 'ストレス指標 ', h('small', null, '0–100')), stressChart));
  const layout = h('div', { class: 'measure-layout' },
    h('div', { class: 'm-stage' },
      stage.el,
      h('div', { class: 'stage-bar' }, startBtn, resetBtn, finishBtn, h('span', { class: 'spacer' }), camSelect, timer)),
    side);
  root.append(h('div', { class: 'page-head' },
    h('h1', null, 'ひとりで計測'),
    h('p', null, '明るい場所で、顔がカメラの正面に来るように座ってください。最初の15〜20秒で平常値を記録し、その後の変化を表示します。')), layout);
  stage.setMessage('「計測をはじめる」を押すとカメラが起動します');

  let stream = null, startedAt = 0, samples = [], tick = 0, lastUi = 0;
  const monitor = new VitalMonitor({
    onState: (state, info) => {
      const now = performance.now();
      if (now - lastUi < 120) return;
      lastUi = now;
      panel.update(state);
      stage.setBox(info.box);
      stage.setMessage(info.face ? '' : '顔が見つかりません');
    },
  });

  function record() {
    const t = (performance.now() - startedAt) / 1000;
    timer.textContent = fmt.time(t);
    const s = monitor.state, d = displayValues(s);
    samples.push({ t, bpm: d.bpm, stress: d.stress, valid: s.measurementValid, calibrated: s.stressValid, rmssd: s.hrvRmssd });
    redraw(t);
  }

  function redraw(t) {
    if (!bpmChart.isConnected) return;
    lineChart(bpmChart, [{ points: samples.filter((x) => x.bpm).map((x) => [x.t, x.bpm]), color: '#ff5c7a' }], { tMin: Math.max(0, t - 120), tMax: Math.max(t, 30) });
    lineChart(stressChart, [{ points: samples.filter((x) => x.stress != null).map((x) => [x.t, x.stress]), color: '#94e4bb' }], { min: 0, max: 100, tMin: Math.max(0, t - 120), tMax: Math.max(t, 30) });
  }

  async function start(deviceId) {
    if (!(await ensureConsent())) return;
    startBtn.disabled = true;
    stage.setMessage('カメラを起動しています…');
    try {
      stopMedia(stream);
      stream = await openMedia({ deviceId });
      await stage.setStream(stream);
    } catch (err) {
      stage.setMessage(cameraErrorMessage(err));
      startBtn.disabled = false;
      return;
    }
    stage.setMessage('顔検出モデルを読み込んでいます…');
    try {
      await monitor.start(stage.video);
    } catch (err) {
      console.error(err);
      stage.setMessage('顔検出モデルを読み込めませんでした。通信環境を確認して再読み込みしてください。');
      startBtn.disabled = false;
      return;
    }
    stage.setMessage('');
    const cams = await listCameras();
    if (cams.length > 1) {
      camSelect.replaceChildren(...cams.map((c, i) => h('option', { value: c.deviceId }, c.label || `カメラ ${i + 1}`)));
      const active = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (active) camSelect.value = active;
      camSelect.hidden = false;
    }
    if (!startedAt) {
      startedAt = performance.now(); samples = [];
      tick = setInterval(record, 1000);
    }
    startBtn.hidden = true;
    resetBtn.disabled = false; finishBtn.disabled = false;
    setLeaveGuard(() => confirmDialog({ title: '計測を中断しますか？', body: 'この計測の結果は保存されません。', ok: '中断する', danger: true }));
  }

  camSelect.addEventListener('change', () => { monitor.reset(); start(camSelect.value); });
  startBtn.addEventListener('click', () => start());
  resetBtn.addEventListener('click', () => { monitor.reset(); toast('平常値を記録し直します。落ち着いた姿勢でお待ちください。'); });
  finishBtn.addEventListener('click', finish);

  function stopAll() {
    monitor.stop(); clearInterval(tick); tick = 0;
    stopMedia(stream); stream = null;
    setLeaveGuard(null);
  }

  function finish() {
    const duration = (performance.now() - startedAt) / 1000;
    stopAll();
    const summary = summarize(samples, duration);
    const saved = { value: false };
    const saveBtn = h('button', { class: 'btn primary' }, icon('check', 18), '記録に保存');
    saveBtn.addEventListener('click', () => {
      if (saved.value) return;
      const ok = store.addHistory({ type: 'measure', title: 'ひとりで計測', summary,
        samples: samples.map((s) => [Math.round(s.t), s.bpm && Math.round(s.bpm * 10) / 10, s.stress == null ? null : Math.round(s.stress)]) });
      saved.value = ok;
      if (ok) { saveBtn.disabled = true; saveBtn.lastChild.textContent = '保存しました'; } else toast('保存できませんでした（ブラウザーの保存領域を確認してください）', 'error');
    });
    const csv = () => download(`vitalroom-measure-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`,
      'seconds,bpm,stress,reliable\n' + samples.map((s) => [s.t.toFixed(0), s.bpm ? s.bpm.toFixed(1) : '', s.stress == null ? '' : s.stress.toFixed(0), s.valid ? 1 : 0].join(',')).join('\n'), 'text/csv');
    root.replaceChildren(
      h('div', { class: 'page-head' }, h('h1', null, '計測の結果'),
        h('p', null, summary.reliableRatio < 0.3
          ? '安定して計測できた時間が短いため、値の信頼性は低めです。明るさや姿勢を整えて、もう一度試すのがおすすめです。'
          : '平常時との比較から求めた参考値です。体調の判断には使わないでください。')),
      h('div', { class: 'card' }, summaryView(summary, samples),
        h('div', { class: 'row wrap' }, saveBtn,
          h('button', { class: 'btn ghost', onclick: csv }, icon('download', 18), 'CSV'),
          h('span', { class: 'spacer' }),
          h('a', { class: 'btn ghost', href: '#/' }, 'ホームへ'),
          h('button', { class: 'btn ghost', onclick: () => window.dispatchEvent(new HashChangeEvent('hashchange')) }, icon('refresh', 18), 'もう一度'))));
  }

  const onResize = () => { if (samples.length && tick) redraw((performance.now() - startedAt) / 1000); };
  window.addEventListener('resize', onResize);
  return () => { stopAll(); window.removeEventListener('resize', onResize); };
}
