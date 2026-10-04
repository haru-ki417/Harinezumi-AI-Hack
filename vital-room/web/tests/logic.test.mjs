// Web 版の端末内ロジックのテスト（node --test で実行。依存パッケージなし）。
// Python 版（backend/vital, interview_*.py）との数値一致は開発時に scipy で確認済み。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computePulse, hrvFromPulse, butterBandpass, stressScore } from '../js/dsp.js';
import { VitalSession } from '../js/session.js';
import { nextQuestion, localFeedback, sequenceRatio } from '../js/interview.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

function synth({ bpm, seconds, fps = 30, noise = 0.2, seed = 1 }) {
  const r = rng(seed), times = [], rgb = [];
  let phase = 0;
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps + (r() - 0.5) * 0.004;
    phase += 2 * Math.PI * (bpm / 60) / fps * (1 + 0.03 * Math.sin(2 * Math.PI * 0.2 * t));
    const p = Math.sin(phase) + 0.3 * Math.sin(2 * phase);
    times.push(t);
    rgb.push([150 + 0.4 * p + noise * gauss(r), 110 + 0.9 * p + noise * gauss(r), 90 + 0.3 * p + noise * gauss(r)]);
  }
  return { times, rgb };
}

test('Butterworth band-pass matches scipy.signal.butter(4, [0.05, 0.27], "band")', () => {
  const { b, a } = butterBandpass(4, 0.05, 0.27);
  assert.equal(b.length, 9); assert.equal(a.length, 9);
  assert.ok(Math.abs(a[0] - 1) < 1e-12);
  assert.ok(Math.abs(b[0] - 0.006661336726303001) < 1e-9, `b0=${b[0]}`);
});

for (const bpm of [58, 72, 95, 120]) {
  test(`computePulse recovers ${bpm} BPM`, () => {
    const { times, rgb } = synth({ bpm, seconds: 15, seed: bpm });
    const res = computePulse(times, rgb);
    assert.ok(res, 'result');
    assert.ok(Math.abs(res.bpm - bpm) < 1.5, `bpm=${res.bpm}`);
    assert.ok(res.confidence > 0.5);
  });
}

test('computePulse rejects short or invalid input', () => {
  const { times, rgb } = synth({ bpm: 70, seconds: 3 });
  assert.equal(computePulse(times, rgb), null);
  const long = synth({ bpm: 70, seconds: 10 });
  long.rgb[5] = [0, 1, 1];
  assert.equal(computePulse(long.times, long.rgb), null);
});

test('HRV is computed from a clean pulse', () => {
  const fs = 30, p = [];
  let phase = 0;
  for (let i = 0; i < 30 * fs; i++) { phase += 2 * Math.PI * (70 / 60) / fs * (1 + 0.03 * Math.sin(2 * Math.PI * 0.2 * i / fs)); p.push(Math.sin(phase)); }
  const h = hrvFromPulse(p, fs);
  assert.ok(h && Math.abs(h.meanHr - 70) < 1.5 && h.rmssd > 0 && h.beats >= 30);
});

test('stressScore follows the baseline definition', () => {
  assert.equal(stressScore(70, 40, 70, 40), 0);
  assert.equal(stressScore(87.5, 20, 70, 40), 100);
  assert.equal(stressScore(80, 40, 0, 40), 0);
});

test('VitalSession reaches a reliable estimate and calibrates', () => {
  const { times, rgb } = synth({ bpm: 66, seconds: 40, noise: 0.05, seed: 9 });
  const s = new VitalSession();
  let last;
  times.forEach((t, i) => { last = s.process(t, rgb[i]); });
  assert.ok(last.measurementValid);
  assert.ok(Math.abs(last.currentBpm - 66) < 2, `bpm=${last.currentBpm}`);
  assert.ok(['measuring', 'calibrating', 'unstable_hrv'].includes(last.measurementStatus));
});

test('interview planner asks a follow-up, respects refusal and finishes', () => {
  const tpl = { questions: ['学生時代に力を入れて取り組んだ経験について教えてください。', 'この職種を志望する理由を教えてください。'] };
  const tr = [];
  const q0 = nextQuestion(tpl, tr);
  assert.equal(q0.question_index, 0);
  tr.push({ id: 'a0', role: 'ai', text: q0.text, question_index: 0 });
  tr.push({ id: 'c0', role: 'candidate', text: 'チームで分担してイベントを企画しました。', question_index: 0 });
  const q1 = nextQuestion(tpl, tr);
  assert.equal(q1.is_follow_up, true);
  tr.push({ id: 'a1', role: 'ai', text: q1.text, question_index: 0 });
  tr.push({ id: 'c1', role: 'candidate', text: '答えたくありません。', question_index: 0 });
  const q2 = nextQuestion(tpl, tr);
  assert.equal(q2.question_index, 1); assert.equal(q2.is_follow_up, false);
  assert.equal(nextQuestion({ ...tpl, _remaining_seconds: 0 }, tr).text, '');
});

test('feedback quotes only what the candidate said', () => {
  const tpl = { questions: ['学生時代に力を入れて取り組んだ経験について教えてください。'] };
  const tr = [
    { id: 'a0', role: 'ai', text: tpl.questions[0], question_index: 0 },
    { id: 'c0', role: 'candidate', text: '参加者が減っていたため、アンケートを実施しました。その結果、参加者が30%増えました。', question_index: 0 },
  ];
  const fb = localFeedback(tpl, tr);
  assert.equal(fb.question_reviews.length, 1);
  for (const ev of fb.question_reviews[0].evidence) assert.ok(tr[1].text.includes(ev.quote));
  assert.ok(fb.strengths.length > 0);
  assert.ok(!/採用|合否|スコア/.test(JSON.stringify(fb)));
});

test('sequenceRatio matches difflib on simple strings', () => {
  assert.equal(sequenceRatio('abcd', 'abcd'), 1);
  assert.equal(sequenceRatio('abcd', 'bcde'), 0.75);
  assert.equal(sequenceRatio('', 'abc'), 0);
});
