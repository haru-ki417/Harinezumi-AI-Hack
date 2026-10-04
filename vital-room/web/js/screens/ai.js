import { h, icon, fmt, toast, store, average, confirmDialog, download } from '../ui.js';
import { ensureConsent, openMedia, stopMedia, cameraStage, cameraErrorMessage } from '../camera.js';
import { VitalMonitor, displayValues } from '../vitals.js';
import { vitalPanel } from '../widgets.js';
import { nextQuestion, localFeedback, cleanQuestions, QUESTION_SETS, MAX_FOLLOW_UPS, MAX_QUESTIONS } from '../interview.js';
import { setLeaveGuard } from '../nav.js';

export const name = 'ai';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const SETUP_KEY = 'vitalroom.ai-setup.v1';

export function mount(root) {
  const saved = store.get(SETUP_KEY, {});
  let setId = QUESTION_SETS.some((s) => s.id === saved.setId) || saved.setId === 'custom' ? saved.setId : 'standard';
  const custom = h('textarea', { class: 'input', rows: 5, maxlength: 2000, placeholder: '1行に1つずつ質問を書いてください（最大20問）' });
  custom.value = saved.custom || '';
  const customWrap = h('div', { class: 'field', hidden: setId !== 'custom' }, h('span', null, '質問（1行に1問）'), custom);
  const cards = [...QUESTION_SETS, { id: 'custom', title: '自分で作る', note: '面接予定の企業の質問などを入力', questions: [] }]
    .map((s) => h('button', { type: 'button', class: 'set-card', 'aria-pressed': String(s.id === setId), onclick: () => {
      setId = s.id;
      cards.forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.id === setId)));
      customWrap.hidden = setId !== 'custom';
    }, 'data-id': s.id },
    h('b', null, s.title), h('span', null, s.note),
    s.questions.length ? h('small', null, `${s.questions.length}問 ・ 深掘り最大${MAX_FOLLOW_UPS}回`) : h('small', null, '最大20問')));

  const limit = h('select', { class: 'select', 'aria-label': '制限時間' },
    [['0', 'なし'], ['600', '10分'], ['900', '15分'], ['1200', '20分']].map(([v, t]) => h('option', { value: v }, t)));
  limit.value = String(saved.limit ?? 0);
  const voiceOut = h('input', { type: 'checkbox', id: 'opt-voice', checked: saved.voiceOut ?? !!window.speechSynthesis, disabled: !window.speechSynthesis });
  const voiceIn = h('input', { type: 'checkbox', id: 'opt-stt', checked: !!SR && (saved.voiceIn ?? true), disabled: !SR });
  const vitals = h('input', { type: 'checkbox', id: 'opt-vitals', checked: saved.vitals ?? true });
  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const startBtn = h('button', { class: 'btn primary lg' }, icon('play', 18), '面接をはじめる');

  root.append(
    h('div', { class: 'page-head' }, h('h1', null, 'AI面接練習'),
      h('p', null, 'AI面接官が質問し、回答の内容に合わせて「理由」「結果」「学び」などを深掘りします。終了後に、あなたの発言を引用しながら振り返りを作成します。')),
    h('div', { class: 'ai-setup' },
      h('section', { class: 'card' },
        h('h2', { class: 'card-title' }, '質問セット'),
        h('div', { class: 'set-grid' }, cards),
        customWrap),
      h('section', { class: 'card form' },
        h('h2', { class: 'card-title' }, '設定'),
        h('label', { class: 'field inline' }, h('span', null, '制限時間'), limit),
        h('label', { class: 'check', for: 'opt-voice' }, voiceOut, h('span', null, '質問を読み上げる', window.speechSynthesis ? null : h('small', null, '（このブラウザーは非対応）'))),
        h('label', { class: 'check', for: 'opt-stt' }, voiceIn, h('span', null, '声で回答する（音声入力）', SR ? null : h('small', null, '（このブラウザーは非対応。文字で回答できます）'))),
        h('label', { class: 'check', for: 'opt-vitals' }, vitals, h('span', null, '回答中の心拍を自分用に記録する', h('small', null, '（振り返りの内容には使いません）'))),
        SR ? h('p', { class: 'note' }, '音声入力はブラウザーの音声認識機能を使います（Chrome では音声が Google のサーバーで処理されます）。気になる場合はオフにして、文字で回答してください。') : null,
        errorBox, startBtn)));

  startBtn.addEventListener('click', async () => {
    const questions = setId === 'custom' ? cleanQuestions(custom.value.split('\n')) : QUESTION_SETS.find((s) => s.id === setId).questions;
    if (!questions.length) { errorBox.textContent = '質問を1つ以上入力してください。'; errorBox.hidden = false; return; }
    if (setId === 'custom' && custom.value.split('\n').filter((l) => l.trim()).length > MAX_QUESTIONS) toast(`質問は先頭の${MAX_QUESTIONS}問を使います。`, 'warn');
    store.set(SETUP_KEY, { setId, custom: custom.value, limit: Number(limit.value), voiceOut: voiceOut.checked, voiceIn: voiceIn.checked, vitals: vitals.checked });
    if (vitals.checked && !(await ensureConsent())) return;
    root.replaceChildren();
    cleanupRun = run(root, {
      template: { questions },
      limitSec: Number(limit.value),
      voiceOut: voiceOut.checked && !!window.speechSynthesis,
      voiceIn: voiceIn.checked && !!SR,
      vitals: vitals.checked,
    });
  });

  let cleanupRun = null;
  return () => cleanupRun?.();
}

// ---------------------------------------------------------------- 面接中

function run(root, opts) {
  const { template, limitSec } = opts;
  const transcript = [];
  const samples = [];         // [t, bpm, stress, questionIndex]
  const startedAt = performance.now();
  const elapsed = () => (performance.now() - startedAt) / 1000;
  let current = null;         // 現在の質問
  let turnNo = 0;
  let ended = false;

  // 面接官
  const avatar = h('div', { class: 'avatar' }, icon('bot', 34));
  const progress = h('span', { class: 'q-progress' });
  const followTag = h('span', { class: 'tag', hidden: true }, '深掘り');
  const qText = h('p', { class: 'q-text', 'aria-live': 'polite' });
  const replayBtn = h('button', { class: 'btn ghost sm', hidden: !opts.voiceOut }, icon('speaker', 16), 'もう一度聞く');
  const timer = h('span', { class: 'timer' }, limitSec ? fmt.time(limitSec) : '0:00');

  // 回答
  const answer = h('textarea', { class: 'input answer', rows: 5, maxlength: 6000, placeholder: opts.voiceIn ? 'マイクのボタンを押して話すと、ここに文字が入ります。直接入力・修正もできます。' : 'ここに回答を入力してください。' });
  const interim = h('p', { class: 'interim', hidden: !opts.voiceIn });
  const micBtn = h('button', { class: 'btn ghost mic', hidden: !opts.voiceIn, 'aria-pressed': 'false' }, icon('mic', 18), h('span', null, '話す'));
  const sendBtn = h('button', { class: 'btn primary' }, icon('send', 18), '回答する');
  const skipBtn = h('button', { class: 'btn ghost' }, icon('skip', 18), 'パス');
  const endBtn = h('button', { class: 'btn ghost danger-text' }, '終了');
  const log = h('ol', { class: 'ai-log' });

  // 計測
  let stream = null, monitor = null, panel = null, stage = null;
  if (opts.vitals) {
    stage = cameraStage();
    panel = vitalPanel({ compact: true });
  }

  root.append(h('div', { class: 'ai-run' },
    h('section', { class: 'card interviewer' },
      h('div', { class: 'iv-head' }, avatar, h('div', null, h('b', null, 'AI面接官'), h('div', { class: 'iv-meta' }, progress, followTag)), h('span', { class: 'spacer' }), timer),
      qText,
      h('div', { class: 'row' }, replayBtn)),
    h('section', { class: 'card answer-card' },
      h('label', { class: 'field' }, h('span', null, 'あなたの回答'), answer),
      interim,
      h('div', { class: 'row wrap' }, micBtn, h('span', { class: 'spacer' }), skipBtn, sendBtn),
      h('p', { class: 'note' }, h('span', { class: 'kbd-hint' }, 'Ctrl + Enter（Mac は ⌘ + Enter）でも回答できます。'), '答えにくい質問は「パス」で次へ進めます。')),
    opts.vitals ? h('aside', { class: 'ai-vitals' }, stage.el, panel.el) : null,
    h('section', { class: 'card log-card' }, h('div', { class: 'row' }, h('h2', { class: 'card-title' }, 'やり取り'), h('span', { class: 'spacer' }), endBtn), log)));

  // ---- 読み上げ
  const synth = window.speechSynthesis;
  let jaVoice = null;
  const pickVoice = () => { jaVoice = synth?.getVoices().find((v) => /^ja/i.test(v.lang)) || null; };
  if (synth) { pickVoice(); synth.addEventListener?.('voiceschanged', pickVoice); }
  function speak(text, then) {
    if (!opts.voiceOut || !synth) { then?.(); return; }
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = 1.02;
    if (jaVoice) u.voice = jaVoice;
    avatar.classList.add('speaking');
    let done = false;
    const finish = () => { if (done) return; done = true; avatar.classList.remove('speaking'); then?.(); };
    u.onend = finish; u.onerror = finish;
    // 一部の環境では onend が来ないことがあるため保険をかける
    setTimeout(finish, 1500 + text.length * 260);
    synth.speak(u);
  }

  // ---- 音声入力
  let rec = null, listening = false, finalText = '';
  function startListening() {
    if (!opts.voiceIn || listening || ended) return;
    try {
      rec = new SR();
      rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
      finalText = answer.value;
      rec.onresult = (e) => {
        let inter = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) { finalText += r[0].transcript; answer.value = finalText; }
          else inter += r[0].transcript;
        }
        interim.textContent = inter;
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          toast('マイクが使えないため、文字で回答してください。', 'warn');
          opts.voiceIn = false; micBtn.hidden = true; stopListening();
        } else if (e.error === 'network') {
          toast('音声認識サービスに接続できません。文字で回答してください。', 'warn');
          stopListening();
        }
      };
      rec.onend = () => { if (listening) { try { rec.start(); } catch { setListening(false); } } };
      rec.start();
      setListening(true);
    } catch { setListening(false); }
  }
  function syncFinal() { finalText = answer.value; }
  function stopListening() {
    setListening(false);
    try { rec?.stop(); } catch { /* noop */ }
    rec = null; interim.textContent = '';
  }
  function setListening(on) {
    listening = on;
    micBtn.setAttribute('aria-pressed', String(on));
    micBtn.lastChild.textContent = on ? '聞き取り中…（止める）' : '話す';
    micBtn.classList.toggle('on', on);
  }
  answer.addEventListener('input', syncFinal);
  micBtn.onclick = () => (listening ? stopListening() : startListening());

  // ---- 進行
  function ask(q) {
    current = q;
    transcript.push({ id: `q${turnNo++}`, role: 'ai', text: q.text, question_index: q.question_index });
    const main = template.questions.length;
    progress.textContent = `質問 ${q.question_index + 1} / ${main}`;
    followTag.hidden = !q.is_follow_up;
    qText.textContent = q.text;
    log.append(h('li', { class: 'ai' }, h('span', null, q.is_follow_up ? '深掘り' : `質問 ${q.question_index + 1}`), h('p', null, q.text)));
    answer.value = ''; finalText = '';
    sendBtn.disabled = skipBtn.disabled = false;
    if (matchMedia('(hover: hover)').matches) answer.focus({ preventScroll: true });
    else qText.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    speak(q.text, () => { if (opts.voiceIn) startListening(); });
  }

  function submit(textOverride) {
    if (ended || !current) return;
    const text = (textOverride ?? answer.value).trim();
    if (!text) { toast('回答を入力するか、「パス」を押してください。'); return; }
    stopListening();
    synth?.cancel();
    transcript.push({ id: `c${turnNo++}`, role: 'candidate', text, question_index: current.question_index });
    log.append(h('li', { class: 'me' }, h('span', null, 'あなた'), h('p', null, text)));
    const tpl = limitSec ? { ...template, _remaining_seconds: Math.max(0, limitSec - elapsed()) } : template;
    const next = nextQuestion(tpl, transcript);
    if (!next.text) { finish(); return; }
    sendBtn.disabled = skipBtn.disabled = true;
    qText.textContent = '';
    setTimeout(() => { if (!ended) ask(next); }, 450);
  }

  sendBtn.onclick = () => submit();
  skipBtn.onclick = () => submit('この質問はパスします。');
  answer.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
  replayBtn.onclick = () => current && speak(current.text);
  endBtn.onclick = async () => {
    if (await confirmDialog({ title: '面接を終了しますか？', body: 'ここまでの回答で振り返りを作成します。', ok: '終了する' })) finish();
  };

  const clock = setInterval(() => {
    const t = elapsed();
    timer.textContent = limitSec ? fmt.time(limitSec - t) : fmt.time(t);
    timer.classList.toggle('warn', !!limitSec && limitSec - t < 60);
    if (monitor) {
      const d = displayValues(monitor.state);
      samples.push([t, d.bpm, d.stress, current?.question_index ?? -1]);
    }
    if (limitSec && t >= limitSec + 30) { toast('制限時間になりました。'); finish(); }
  }, 1000);

  if (opts.vitals) {
    let lastUi = 0;
    monitor = new VitalMonitor({ onState: (state, info) => {
      const t = performance.now();
      if (t - lastUi < 150) return;
      lastUi = t;
      panel.update(state); stage.setBox(info.box);
    } });
    stage.setMessage('カメラを起動しています…');
    openMedia().then(async (s) => {
      if (ended) { stopMedia(s); return; }
      stream = s;
      await stage.setStream(s);
      stage.setMessage('');
      await monitor.start(stage.video);
    }).catch((err) => stage.setMessage(err?.name ? cameraErrorMessage(err) : '心拍の計測を開始できませんでした。'));
  }

  setLeaveGuard(() => confirmDialog({ title: '面接を中断しますか？', body: 'ここまでの回答は保存されません。', ok: '中断する', danger: true }));
  // ユーザー操作の直後に最初の質問を読み上げる（iOS の読み上げ制限対策）
  ask(nextQuestion(template, transcript));

  function teardown() {
    ended = true;
    clearInterval(clock);
    stopListening();
    synth?.cancel();
    monitor?.stop();
    stopMedia(stream);
    setLeaveGuard(null);
  }

  function finish() {
    if (ended) return;
    teardown();
    const feedback = localFeedback(template, transcript);
    const vitalsByQ = opts.vitals ? perQuestion(samples, template.questions) : [];
    showFeedback(root, { template, transcript, feedback, vitalsByQ, duration: elapsed() });
  }

  return () => { if (!ended) teardown(); };
}

function perQuestion(samples, questions) {
  return questions.map((q, i) => {
    const s = samples.filter((r) => r[3] === i);
    return { index: i, question: q, seconds: s.length, bpm: average(s.map((r) => r[1])), stress: average(s.map((r) => r[2])) };
  }).filter((r) => r.seconds > 0 && r.bpm != null);
}

// ---------------------------------------------------------------- 振り返り

function quote(ev) {
  return h('blockquote', { class: 'quote' }, `「${ev.quote}」`);
}

export function feedbackView({ feedback, vitalsByQ = [], transcript = [] }) {
  const fb = feedback;
  return h('div', { class: 'feedback' },
    h('p', { class: 'fb-summary' }, fb.summary),
    fb.strengths.length || fb.improvements.length ? h('div', { class: 'fb-cols' },
      h('section', null, h('h3', { class: 'fb-h good' }, icon('check', 18), '伝わっている点'),
        fb.strengths.length ? fb.strengths.map((p) => h('article', { class: 'point good' },
          h('b', null, p.title), h('p', null, p.observation), p.evidence.map(quote))) : h('p', { class: 'note' }, '引用できる要素はまだありません。')),
      h('section', null, h('h3', { class: 'fb-h next' }, icon('spark', 18), '補うとよい点'),
        fb.improvements.length ? fb.improvements.map((p) => h('article', { class: 'point next' },
          h('b', null, p.title), h('p', null, p.observation), p.evidence.map(quote), h('p', { class: 'suggest' }, p.suggestion)))
          : h('p', { class: 'note' }, '大きく補う点は見つかりませんでした。'))) : null,
    h('h3', { class: 'fb-section' }, '質問ごとの振り返り'),
    fb.question_reviews.map((r, i) => h('details', { class: 'review', open: i === 0 },
      h('summary', null, h('span', { class: 'rv-no' }, r.question_index >= 0 ? `Q${r.question_index + 1}` : '—'), h('span', null, r.question)),
      h('p', null, r.summary),
      r.evidence.length ? h('div', { class: 'rv-quotes' }, r.evidence.map(quote)) : null,
      r.strengths.length ? h('div', { class: 'rv-block' }, h('b', null, '触れている要素'), h('ul', null, r.strengths.map((s) => h('li', null, s)))) : null,
      r.improvements.length ? h('div', { class: 'rv-block' }, h('b', null, '次に補うなら'), h('ul', null, r.improvements.map((s) => h('li', null, s)))) : null,
      r.answer_outline.length ? h('div', { class: 'rv-block outline' }, h('b', null, '答え方の構成例（[ ] を自分の言葉で埋める）'), h('ol', null, r.answer_outline.map((s) => h('li', null, s)))) : null)),
    fb.practice_plan.length ? h('section', { class: 'plan' }, h('h3', { class: 'fb-section' }, '次の練習'), h('ol', null, fb.practice_plan.map((s) => h('li', null, s)))) : null,
    vitalsByQ.length ? h('section', { class: 'plan' },
      h('h3', { class: 'fb-section' }, '参考：質問ごとの心拍'),
      h('p', { class: 'note' }, '自分の振り返り用の参考値です。上の振り返りの内容には使っていません。'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, '質問'), h('th', null, '時間'), h('th', null, '平均 BPM'), h('th', null, 'ストレス指標'))),
        h('tbody', null, vitalsByQ.map((v) => h('tr', null, h('td', null, `Q${v.index + 1} ${v.question}`), h('td', null, fmt.time(v.seconds)), h('td', null, fmt.bpm(v.bpm)), h('td', null, fmt.num(v.stress)))))))) : null,
    transcript.length ? h('details', { class: 'review' }, h('summary', null, h('span', { class: 'rv-no' }, icon('chat', 16)), h('span', null, `やり取りの全文（${transcript.length}件）`)),
      h('ol', { class: 'ai-log' }, transcript.map((t) => h('li', { class: t.role === 'candidate' ? 'me' : 'ai' }, h('span', null, t.role === 'candidate' ? 'あなた' : 'AI面接官'), h('p', null, t.text))))) : null);
}

function showFeedback(root, data) {
  const saveBtn = h('button', { class: 'btn primary' }, icon('check', 18), h('span', null, '記録に保存'));
  saveBtn.onclick = () => {
    const ok = store.addHistory({ type: 'ai', title: 'AI面接練習', duration: Math.round(data.duration),
      template: data.template, transcript: data.transcript, feedback: data.feedback, vitalsByQ: data.vitalsByQ });
    if (ok) { saveBtn.disabled = true; saveBtn.lastChild.textContent = '保存しました'; } else toast('保存できませんでした。', 'error');
  };
  const txt = () => download(`vitalroom-ai-interview-${new Date().toISOString().slice(0, 10)}.txt`,
    data.transcript.map((t) => `${t.role === 'candidate' ? 'あなた' : 'AI面接官'}: ${t.text}`).join('\n\n'));
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', null, '振り返り'),
      h('p', null, '話した内容の「伝わり方」を、発言の引用をもとに整理しました。経験の有無や能力を判定するものではありません。')),
    h('div', { class: 'card' }, feedbackView(data),
      h('div', { class: 'row wrap' }, saveBtn,
        h('button', { class: 'btn ghost', onclick: txt }, icon('download', 18), 'やり取りを保存（.txt）'),
        h('span', { class: 'spacer' }),
        h('a', { class: 'btn ghost', href: '#/' }, 'ホームへ'),
        h('button', { class: 'btn ghost', onclick: () => window.dispatchEvent(new HashChangeEvent('hashchange')) }, icon('refresh', 18), 'もう一度'))));
}
