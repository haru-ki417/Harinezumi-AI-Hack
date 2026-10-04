import { h, icon, fmt, toast, store, lineChart, average, confirmDialog, download } from '../ui.js';
import { ensureConsent, openMedia, stopMedia, cameraStage, cameraErrorMessage } from '../camera.js';
import { VitalMonitor, displayValues } from '../vitals.js';
import { vitalPanel, vitalBadge } from '../widgets.js';
import { RoomLink, randomCode, normalizeCode, p2pErrorMessage } from '../p2p.js';
import { setLeaveGuard } from '../nav.js';

export const name = 'room';

export const TOPICS = ['自己紹介', '志望動機', 'ガクチカ', '強み・弱み', 'キャリアパス', '働き方・残業', '給与・待遇', '逆質問'];
const ROLE_LABEL = { candidate: '就活生', interviewer: '面接官' };
const PROFILE_KEY = 'vitalroom.profile.v1';

export function mount(root, [codeParam]) {
  const profile = store.get(PROFILE_KEY, { name: '', role: 'candidate' });
  let cleanupRoom = null;

  const nameInput = h('input', { class: 'input', maxlength: 20, placeholder: '例: 山田', autocomplete: 'nickname', value: profile.name || '' });
  let role = profile.role === 'interviewer' ? 'interviewer' : 'candidate';
  const roleBtns = ['candidate', 'interviewer'].map((r) => h('button', { type: 'button', class: 'choice', 'aria-pressed': String(role === r), onclick: () => {
    role = r; roleBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(['candidate', 'interviewer'][i] === r)));
  } }, icon(r === 'candidate' ? 'person' : 'people', 17), ROLE_LABEL[r]));
  const codeInput = h('input', { class: 'input code', maxlength: 7, placeholder: 'ABC123', autocomplete: 'off', autocapitalize: 'characters', inputmode: 'text', value: codeParam || '' });
  codeInput.addEventListener('input', () => { codeInput.value = normalizeCode(codeInput.value); });
  const shareCheck = h('input', { type: 'checkbox', checked: true, id: 'share-check' });
  const mediaCheck = h('input', { type: 'checkbox', checked: profile.media !== false, id: 'media-check' });
  const errorBox = h('p', { class: 'form-error', role: 'alert', hidden: true });

  const createBtn = h('button', { class: 'btn primary lg' }, icon('people', 18), '新しいルームを作る');
  const joinBtn = h('button', { class: `btn ${codeParam ? 'primary' : 'ghost'} lg` }, icon('arrow', 18), 'コードで参加する');

  function showError(text) { errorBox.textContent = text; errorBox.hidden = !text; }

  async function go(host) {
    showError('');
    const nm = nameInput.value.trim().slice(0, 20);
    if (!nm) { showError('表示名を入力してください。'); nameInput.focus(); return; }
    const code = host ? randomCode() : normalizeCode(codeInput.value);
    if (!host && code.length !== 6) { showError('6文字のルームコードを入力してください。'); codeInput.focus(); return; }
    const media = mediaCheck.checked;
    store.set(PROFILE_KEY, { name: nm, role, media });
    if (!(await ensureConsent({ room: media ? 'media' : 'data' }))) return;
    createBtn.disabled = joinBtn.disabled = true;
    let stream;
    try {
      stream = await openMedia({ audio: media });
    } catch (err) {
      try {
        if (!media) throw err;
        stream = await openMedia({ audio: false }); toast('マイクを使えないため、音声なしで参加します。', 'warn');
      }
      catch { showError(cameraErrorMessage(err)); createBtn.disabled = joinBtn.disabled = false; return; }
    }
    root.replaceChildren();
    cleanupRoom = enterRoom(root, { code, host, stream, me: { name: nm, role, share: shareCheck.checked, media } });
  }
  createBtn.addEventListener('click', () => go(true));
  joinBtn.addEventListener('click', () => go(false));
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(false); });

  root.append(
    h('div', { class: 'page-head' },
      h('h1', null, codeParam ? 'ルームに参加' : 'ルームで練習'),
      h('p', null, '2人で模擬面接をしながら、話題ごとにそれぞれの心拍とストレス指標の変化を記録します。映像通話つきでも、数値の共有だけでも使えます。')),
    h('div', { class: 'lobby' },
      h('section', { class: 'card form' },
        h('label', { class: 'field' }, h('span', null, '表示名'), nameInput),
        h('div', { class: 'field' }, h('span', null, 'あなたの役割'), h('div', { class: 'seg' }, roleBtns)),
        h('label', { class: 'check', for: 'media-check' }, mediaCheck, h('span', null, '映像と音声で通話する', h('small', null, 'オフにすると、数値・話題・チャットだけを共有します（対面や別の通話アプリと併用する場合）。双方がオンのときだけ通話がつながります。'))),
        h('label', { class: 'check', for: 'share-check' }, shareCheck, h('span', null, '自分の心拍・ストレス指標を相手に表示する（あとから切り替えできます）')),
        errorBox,
        codeParam ? null : h('div', { class: 'stack' }, createBtn, h('p', { class: 'note' }, '作成後に表示されるリンクやコードを相手に送ってください。')),
        h('div', { class: 'divider' }, h('span', null, codeParam ? 'ルームコード' : 'または')),
        h('div', { class: 'join-row' }, codeInput, joinBtn)),
      h('aside', { class: 'card tips' },
        h('h2', null, '快適に使うために'),
        h('ul', { class: 'facts' },
          h('li', null, '明るい場所で、顔がカメラの正面に来るように座ってください。'),
          h('li', null, 'イヤホンを使うと、相手の声の回り込み（エコー）を防げます。'),
          h('li', null, '相手との通信は P2P です。社内ネットワークなどで接続できない場合は、モバイル回線でお試しください。'),
          h('li', null, '心拍などの値は参考値です。相手の評価には使わず、話し方の振り返りに役立ててください。')))));

  return () => { cleanupRoom?.(); };
}

// ---------------------------------------------------------------- ルーム内

function enterRoom(root, { code, host, stream, me }) {
  const joinedAt = performance.now();
  const now = () => (performance.now() - joinedAt) / 1000;
  const url = `${location.origin}${location.pathname}#/room/${code}`;
  if (host) window.history.replaceState(null, '', `#/room/${code}`);

  // 記録
  const mine = [];        // [t, bpm, stress, valid, calibrated, topic]
  const theirs = [];      // [t, bpm, stress, topic]
  const topics = [];      // { t, topic }
  let topic = null;
  let partner = null;
  let lastPartner = null;   // 退出後もレポートに名前を残す
  let share = me.share;
  let lastVitals = null;

  // 映像
  const self = cameraStage({ label: `${me.name}（あなた）` });
  self.el.classList.add('self');
  const remoteVideo = h('video', { autoplay: true, playsinline: true, class: 'remote' });
  const remoteName = h('span', null, '相手');
  const waitTitle = h('b', null, '相手の参加を待っています');
  const waitText = h('p', null, 'リンクまたはコードを相手に送ってください。');
  const waitCode = h('div', { class: 'code-big' }, code);
  const remoteWait = h('div', { class: 'remote-wait' },
    h('div', { class: 'pulse-ring' }, icon('people', 28)), waitTitle, waitText, waitCode);
  function renderWait() {
    remoteTile.classList.toggle('has-partner', !!partner);
    if (!partner) {
      waitTitle.textContent = '相手の参加を待っています';
      waitText.textContent = 'リンクまたはコードを相手に送ってください。';
      waitCode.hidden = false;
      return;
    }
    waitCode.hidden = true;
    waitTitle.textContent = `${partner.name}さん（${ROLE_LABEL[partner.role]}）と接続中`;
    waitText.textContent = me.media && partner.media ? '映像を接続しています…'
      : '映像と音声は共有していません。数値・話題・チャットを共有しています。';
  }
  const myBadge = vitalBadge();
  const theirBadge = vitalBadge();
  theirBadge.update(null);
  const unmuteBtn = h('button', { class: 'btn primary sm unmute', hidden: true, onclick: () => { remoteVideo.play().then(() => { unmuteBtn.hidden = true; }).catch(() => {}); } }, icon('speaker', 16), '音声を再生');
  const remoteTile = h('div', { class: 'tile remote-tile' }, remoteVideo, remoteWait,
    h('div', { class: 'tile-label' }, remoteName, theirBadge.el), unmuteBtn);
  self.el.append(h('div', { class: 'tile-badge' }, myBadge.el));

  // パネル
  const panel = vitalPanel({ compact: true });
  const statusLine = h('span', { class: 'conn wait' }, '接続準備中');
  const timer = h('span', { class: 'timer' }, '0:00');
  const topicNow = h('b', null, '話題を選んでください');
  const chips = TOPICS.map((t) => h('button', { class: 'chip', onclick: () => setTopic(t, true) }, t));
  const customTopic = h('input', { class: 'input sm', maxlength: 20, placeholder: 'その他の話題', 'aria-label': 'その他の話題' });
  customTopic.addEventListener('keydown', (e) => { if (e.key === 'Enter' && customTopic.value.trim()) { setTopic(customTopic.value.trim(), true); customTopic.value = ''; } });
  const chatLog = h('div', { class: 'chat-log', 'aria-live': 'polite' });
  const chatInput = h('input', { class: 'input', maxlength: 300, placeholder: 'メッセージ', 'aria-label': 'メッセージ' });
  const chatForm = h('form', { class: 'chat-form', onsubmit: (e) => { e.preventDefault(); sendChat(); } }, chatInput,
    h('button', { class: 'btn primary icon-only', 'aria-label': '送信' }, icon('send', 18)));
  const topicLog = h('ol', { class: 'topic-log' });
  const tabChat = h('button', { class: 'tab', 'aria-selected': 'true' }, 'チャット');
  const tabTopics = h('button', { class: 'tab', 'aria-selected': 'false' }, '話題の記録');
  const chatPane = h('div', { class: 'pane' }, chatLog, chatForm);
  const topicPane = h('div', { class: 'pane', hidden: true }, topicLog);
  tabChat.onclick = () => { tabChat.setAttribute('aria-selected', 'true'); tabTopics.setAttribute('aria-selected', 'false'); chatPane.hidden = false; topicPane.hidden = true; };
  tabTopics.onclick = () => { tabTopics.setAttribute('aria-selected', 'true'); tabChat.setAttribute('aria-selected', 'false'); chatPane.hidden = true; topicPane.hidden = false; renderTopicLog(); };

  // 操作
  const audioTrack = stream.getAudioTracks()[0];
  const videoTrack = stream.getVideoTracks()[0];
  const micBtn = h('button', { class: 'ctl', 'aria-pressed': 'true', disabled: !audioTrack, hidden: !me.media, title: 'マイク' }, icon(audioTrack ? 'mic' : 'micOff', 20), h('span', null, 'マイク'));
  const camBtn = h('button', { class: 'ctl', 'aria-pressed': 'true', title: 'カメラ' }, icon('cam', 20), h('span', null, 'カメラ'));
  const shareBtn = h('button', { class: 'ctl', 'aria-pressed': String(share), title: '心拍の共有' }, icon('heart', 20), h('span', null, '心拍を共有'));
  const copyBtn = h('button', { class: 'btn ghost sm' }, icon('link', 16), '招待リンクをコピー');
  const endBtn = h('button', { class: 'ctl end' }, icon('end', 20), h('span', null, '終了'));

  micBtn.onclick = () => { audioTrack.enabled = !audioTrack.enabled; micBtn.setAttribute('aria-pressed', String(audioTrack.enabled)); micBtn.firstChild.replaceWith(icon(audioTrack.enabled ? 'mic' : 'micOff', 20)); };
  camBtn.onclick = () => {
    videoTrack.enabled = !videoTrack.enabled;
    camBtn.setAttribute('aria-pressed', String(videoTrack.enabled));
    camBtn.firstChild.replaceWith(icon(videoTrack.enabled ? 'cam' : 'camOff', 20));
    if (!videoTrack.enabled) monitor.reset();
  };
  shareBtn.onclick = () => {
    share = !share;
    shareBtn.setAttribute('aria-pressed', String(share));
    link.send({ type: 'share', on: share });
    toast(share ? '心拍とストレス指標を相手に表示します。' : '心拍の共有を止めました。');
  };
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(url); toast('招待リンクをコピーしました。'); }
    catch { toast(`コピーできませんでした。コード ${code} を伝えてください。`, 'warn'); }
  };
  endBtn.onclick = async () => {
    if (await confirmDialog({ title: '練習を終了しますか？', body: '通話を切断して、結果を表示します。', ok: '終了する', danger: true })) finish(true);
  };

  root.append(h('div', { class: 'room' },
    h('div', { class: 'room-bar' },
      h('div', { class: 'room-id' }, h('span', null, 'ROOM'), h('b', null, code)), copyBtn, statusLine, h('span', { class: 'spacer' }), timer),
    h('div', { class: 'topic-bar' },
      h('div', { class: 'topic-now' }, h('span', null, 'いまの話題'), topicNow),
      h('div', { class: 'chips' }, chips, customTopic)),
    h('div', { class: 'room-main' },
      h('div', { class: 'videos' }, remoteTile, self.el),
      h('aside', { class: 'room-side' }, panel.el,
        h('div', { class: 'card side-tabs' }, h('div', { class: 'tabs', role: 'tablist' }, tabChat, tabTopics), chatPane, topicPane))),
    h('div', { class: 'controls' }, micBtn, camBtn, shareBtn, endBtn)));

  self.setStream(stream);

  // 計測
  let lastUi = 0;
  const monitor = new VitalMonitor({
    onState: (state, info) => {
      const t = performance.now();
      if (t - lastUi < 150) return;
      lastUi = t;
      panel.update(state);
      self.setBox(info.box);
      const d = displayValues(state);
      lastVitals = { bpm: d.bpm, stress: d.stress, alert: state.isAnomalous, reliable: d.reliable };
      myBadge.update(lastVitals);
    },
  });
  monitor.start(self.video).catch(() => toast('顔検出モデルを読み込めませんでした。心拍の計測は行えません。', 'error'));

  const tick = setInterval(() => {
    const t = now();
    timer.textContent = fmt.time(t);
    const s = monitor.state, d = displayValues(s);
    mine.push([t, d.bpm, d.stress, s.measurementValid, s.stressValid, topic]);
    if (share && videoTrack.enabled) link.send({ type: 'vitals', bpm: d.bpm, stress: d.stress, alert: s.isAnomalous, reliable: d.reliable });
    else if (!share) link.send({ type: 'vitals', off: true });
  }, 1000);

  // 通信
  const link = new RoomLink({
    code, host, stream,
    hello: { name: me.name, role: me.role, share, media: me.media },
    events: {
      onStatus: (text, kind) => { statusLine.textContent = text; statusLine.className = `conn ${kind}`; },
      onPartner: (info) => {
        const was = partner;
        partner = info;
        if (info) lastPartner = info;
        renderWait();
        if (info) {
          remoteName.textContent = `${info.name}（${ROLE_LABEL[info.role]}）`;
          if (!was) system(`${info.name}さんが参加しました`);
          // 後から参加した相手に、いまの話題を伝える
          if (topic && host) link.send({ type: 'topic', topic });
        } else if (was) {
          system(`${was.name}さんが退出しました`);
          theirBadge.update(null);
        }
      },
      onRemoteStream: (remote) => {
        remoteVideo.srcObject = remote;
        remoteWait.hidden = !!remote;
        remoteTile.classList.toggle('live', !!remote);
        if (remote) remoteVideo.play().catch(() => { unmuteBtn.hidden = false; });
      },
      onMessage: (msg) => {
        if (msg.type === 'vitals') {
          if (msg.off) { theirBadge.update(null); return; }
          const v = { bpm: num(msg.bpm, 30, 240), stress: num(msg.stress, 0, 100), alert: !!msg.alert };
          theirBadge.update(v);
          theirs.push([now(), v.bpm, v.stress, topic]);
        } else if (msg.type === 'share') {
          if (partner) partner.share = !!msg.on;
          if (!msg.on) theirBadge.update(null);
        } else if (msg.type === 'topic') {
          setTopic(String(msg.topic || '').slice(0, 20), false);
        } else if (msg.type === 'chat') {
          addChat(partner?.name || '相手', String(msg.text || '').slice(0, 300), false);
        } else if (msg.type === 'bye') {
          system('相手が練習を終了しました');
        }
      },
      onError: (message, fatal) => {
        if (fatal) { finish(false, message); } else toast(message, 'warn');
      },
    },
  });
  link.open().catch((err) => finish(false, p2pErrorMessage(err)));

  function num(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null; }

  function setTopic(t, broadcast) {
    if (!t || t === topic) return;
    topic = t;
    topics.push({ t: now(), topic: t });
    topicNow.textContent = t;
    chips.forEach((c) => c.classList.toggle('on', c.textContent === t));
    if (broadcast) link.send({ type: 'topic', topic: t });
    system(`話題：${t}`);
    if (!topicPane.hidden) renderTopicLog();
  }

  function system(text) {
    chatLog.append(h('div', { class: 'msg system' }, text));
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function addChat(who, text, mine_) {
    if (!text.trim()) return;
    chatLog.append(h('div', { class: `msg ${mine_ ? 'mine' : ''}` }, h('b', null, who), h('span', null, text)));
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    if (!link.send({ type: 'chat', text })) { toast('相手が接続していないため送信できません。', 'warn'); return; }
    addChat(me.name, text, true);
    chatInput.value = '';
  }

  function renderTopicLog() {
    const rows = topicStats(mine, theirs, topics);
    topicLog.replaceChildren(...(rows.length ? rows.map((r) => h('li', null,
      h('b', null, r.topic), h('span', null, fmt.time(r.duration)),
      h('span', null, `あなた ${fmt.bpm(r.mineBpm)} BPM`),
      partner ? h('span', null, `相手 ${fmt.bpm(r.theirBpm)} BPM`) : null))
      : [h('li', { class: 'empty' }, '話題を選ぶと、話題ごとの平均値がここに並びます。')]));
  }

  let ended = false;
  function finish(userEnded, errorMessage) {
    if (ended) return;
    ended = true;
    const duration = now();
    clearInterval(tick);
    monitor.stop();
    link.close();
    stopMedia(stream);
    setLeaveGuard(null);
    if (!userEnded && mine.length < 5) {
      root.replaceChildren(h('div', { class: 'card narrow center' },
        h('div', { class: 'dialog-icon' }, icon('info', 26)),
        h('h2', null, '接続できませんでした'),
        h('p', null, errorMessage || '接続が切れました。'),
        h('div', { class: 'row center' },
          h('a', { class: 'btn ghost', href: '#/' }, 'ホームへ'),
          h('button', { class: 'btn primary', onclick: () => window.dispatchEvent(new HashChangeEvent('hashchange')) }, 'やり直す'))));
      return;
    }
    if (errorMessage) toast(errorMessage, 'warn');
    showReport(root, { code, me, partner: lastPartner, mine, theirs, topics, duration });
  }

  setLeaveGuard(() => confirmDialog({ title: 'ルームから退出しますか？', body: '通話が切断されます。', ok: '退出する', danger: true }));
  return () => { if (!ended) { ended = true; clearInterval(tick); monitor.stop(); link.close(); stopMedia(stream); } };
}

/** 話題ごとの平均値。 */
export function topicStats(mine, theirs, topics) {
  const names = [...new Set(topics.map((x) => x.topic))];
  const end = Math.max(mine.length ? mine[mine.length - 1][0] : 0, topics.length ? topics[topics.length - 1].t : 0);
  return names.map((name) => {
    let duration = 0;
    topics.forEach((x, i) => { if (x.topic === name) duration += (topics[i + 1]?.t ?? end) - x.t; });
    const m = mine.filter((r) => r[5] === name);
    const o = theirs.filter((r) => r[3] === name);
    return {
      topic: name, duration,
      mineBpm: average(m.map((r) => r[1])), mineStress: average(m.map((r) => r[2])),
      theirBpm: average(o.map((r) => r[1])), theirStress: average(o.map((r) => r[2])),
    };
  });
}

export function roomReportView(rep) {
  const rows = topicStats(rep.mine, rep.theirs, rep.topics);
  const chart = h('canvas', { class: 'chart', height: 180 });
  const sChart = h('canvas', { class: 'chart', height: 130 });
  const partnerName = rep.partner ? rep.partner.name : '相手';
  const el = h('div', { class: 'summary' },
    h('div', { class: 'legend' },
      h('span', null, h('i', { style: { background: '#ff5c7a' } }), `${rep.me.name}（あなた）`),
      rep.theirs.length ? h('span', null, h('i', { style: { background: '#7cc4ff' } }), partnerName) : null),
    h('h3', { class: 'chart-title' }, '心拍の推移 ', h('small', null, '点線は話題の切り替え')), chart,
    h('h3', { class: 'chart-title' }, 'ストレス指標の推移'), sChart,
    h('h3', { class: 'chart-title' }, '話題ごとの平均'),
    rows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, '話題'), h('th', null, '時間'), h('th', null, 'あなた BPM'), h('th', null, 'あなた ストレス'),
        rep.theirs.length ? [h('th', null, `${partnerName} BPM`), h('th', null, `${partnerName} ストレス`)] : null)),
      h('tbody', null, rows.map((r) => h('tr', null, h('td', null, r.topic), h('td', null, fmt.time(r.duration)),
        h('td', null, fmt.bpm(r.mineBpm)), h('td', null, fmt.num(r.mineStress)),
        rep.theirs.length ? [h('td', null, fmt.bpm(r.theirBpm)), h('td', null, fmt.num(r.theirStress))] : null)))))
      : h('p', { class: 'note' }, '話題を選んでいなかったため、話題ごとの集計はありません。'));
  requestAnimationFrame(() => {
    const markers = rep.topics.map((x) => [x.t, x.topic]);
    lineChart(chart, [
      { points: rep.mine.filter((r) => r[1]).map((r) => [r[0], r[1]]), color: '#ff5c7a' },
      { points: rep.theirs.filter((r) => r[1]).map((r) => [r[0], r[1]]), color: '#7cc4ff' },
    ], { markers, tMin: 0, tMax: rep.duration });
    lineChart(sChart, [
      { points: rep.mine.filter((r) => r[2] != null).map((r) => [r[0], r[2]]), color: '#ff5c7a' },
      { points: rep.theirs.filter((r) => r[2] != null).map((r) => [r[0], r[2]]), color: '#7cc4ff' },
    ], { min: 0, max: 100, markers, tMin: 0, tMax: rep.duration });
  });
  return el;
}

function showReport(root, rep) {
  const compact = {
    code: rep.code, me: rep.me, partner: rep.partner, duration: Math.round(rep.duration), topics: rep.topics.map((x) => ({ t: Math.round(x.t), topic: x.topic })),
    mine: rep.mine.map((r) => [Math.round(r[0]), r[1] && Math.round(r[1] * 10) / 10, r[2] == null ? null : Math.round(r[2]), r[3], r[4], r[5]]),
    theirs: rep.theirs.map((r) => [Math.round(r[0]), r[1] && Math.round(r[1] * 10) / 10, r[2] == null ? null : Math.round(r[2]), r[3]]),
  };
  const saveBtn = h('button', { class: 'btn primary' }, icon('check', 18), h('span', null, '記録に保存'));
  saveBtn.onclick = () => {
    if (store.addHistory({ type: 'room', title: `ルーム練習${rep.partner ? `（${rep.partner.name}さんと）` : ''}`, report: compact })) {
      saveBtn.disabled = true; saveBtn.lastChild.textContent = '保存しました';
    } else toast('保存できませんでした。', 'error');
  };
  const csv = () => download(`vitalroom-room-${rep.code}.csv`, 'seconds,who,bpm,stress,topic\n'
    + compact.mine.map((r) => [r[0], 'me', r[1] ?? '', r[2] ?? '', csvCell(r[5])].join(',')).join('\n') + '\n'
    + compact.theirs.map((r) => [r[0], 'partner', r[1] ?? '', r[2] ?? '', csvCell(r[3])].join(',')).join('\n'), 'text/csv');
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', null, '練習の結果'),
      h('p', null, `${fmt.time(rep.duration)} の練習でした。心拍などの値は参考値です。相手の評価ではなく、話し方の振り返りにお使いください。`)),
    h('div', { class: 'card' }, roomReportView(compact),
      h('div', { class: 'row wrap' }, saveBtn,
        h('button', { class: 'btn ghost', onclick: csv }, icon('download', 18), 'CSV'),
        h('span', { class: 'spacer' }),
        h('a', { class: 'btn ghost', href: '#/' }, 'ホームへ'))));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
