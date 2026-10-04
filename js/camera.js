// カメラ・マイクの取得、同意画面、プレビュー（顔枠オーバーレイ付き）。

import { h, icon, store } from './ui.js';
import { ROI_REGIONS } from './face.js';

const CONSENT_KEY = 'vitalroom.consent.v1';

export function hasConsent() { return store.get(CONSENT_KEY, false) === true; }

/** カメラ利用前の説明と同意。同意済みなら即 true。 */
export function ensureConsent({ room = false } = {}) {
  if (hasConsent() && !room) return Promise.resolve(true);
  return new Promise((resolve) => {
    const agree = h('input', { type: 'checkbox', id: 'consent-check' });
    const ok = h('button', { class: 'btn primary', disabled: true }, '同意してカメラを使う');
    agree.addEventListener('change', () => { ok.disabled = !agree.checked; });
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    ok.addEventListener('click', () => { store.set(CONSENT_KEY, true); close(true); });
    const dlg = h('dialog', { class: 'dialog consent' },
      h('div', { class: 'dialog-icon' }, icon('shield', 26)),
      h('h2', null, 'カメラを使う前に'),
      h('ul', { class: 'facts' },
        h('li', null, h('b', null, '映像は保存・送信しません。'), '顔の色のわずかな変化から脈拍を推定する計算は、すべてこの端末のブラウザー内で行います。'),
        room ? h('li', null, h('b', null, 'ルームでは相手と直接つながります。'), room === 'media'
          ? '映像・音声と、共有を選んだ数値は、相手の端末へ暗号化された P2P 通信で直接届きます。接続の仲介にだけ PeerJS の公開サーバーを使います。'
          : '映像と音声は相手に送りません。共有を選んだ数値・話題・チャットだけを、暗号化された P2P 通信で相手に届けます。接続の仲介にだけ PeerJS の公開サーバーを使います。') : null,
        h('li', null, h('b', null, '医療機器ではありません。'), '表示する心拍・心拍変動・ストレスの値は、照明や動きの影響を受ける参考値です。診断や健康管理には使わないでください。'),
        h('li', null, h('b', null, '記録は端末内だけ。'), '保存を選んだ結果（数値と話題）だけがこのブラウザーに残り、履歴画面からいつでも削除できます。')),
      h('label', { class: 'check', for: 'consent-check' }, agree, h('span', null, '上記を理解しました')),
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => close(false) }, 'やめる'), ok));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

export function cameraErrorMessage(err) {
  const name = err && err.name;
  if (!window.isSecureContext) return 'カメラは https のページでのみ使えます。';
  if (!navigator.mediaDevices?.getUserMedia) return 'このブラウザーはカメラに対応していません。最新の Chrome / Safari / Edge をお使いください。';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'カメラの使用が許可されていません。アドレスバーの設定からカメラを許可して、もう一度お試しください。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'カメラが見つかりません。接続を確認してください。';
  if (name === 'NotReadableError' || name === 'AbortError') return 'カメラを開けませんでした。ほかのアプリがカメラを使っていないか確認してください。';
  return 'カメラを開始できませんでした。ページを再読み込みしてお試しください。';
}

/** 脈拍推定向けのカメラ（＋任意でマイク）を開く。 */
export async function openMedia({ audio = false, deviceId } = {}) {
  const video = {
    width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, min: 15 },
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
  };
  const audioC = audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false;
  try {
    return await navigator.mediaDevices.getUserMedia({ video, audio: audioC });
  } catch (err) {
    if (err && err.name === 'OverconstrainedError') {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: audioC });
    }
    throw err;
  }
}

export function stopMedia(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function listCameras() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch { return []; }
}

/**
 * カメラ映像＋顔枠を表示する部品。
 * 返り値の el を DOM に置き、setStream / setBox / setMessage で更新する。
 */
export function cameraStage({ mirrored = true, label } = {}) {
  const video = h('video', { autoplay: true, playsinline: true, muted: true, class: mirrored ? 'mirror' : '' });
  video.muted = true;
  const overlay = h('canvas', { class: `overlay ${mirrored ? 'mirror' : ''}`, 'aria-hidden': 'true' });
  const msg = h('div', { class: 'stage-msg', hidden: true });
  const tag = label ? h('div', { class: 'stage-tag' }, label) : null;
  const el = h('div', { class: 'stage' }, video, overlay, tag, msg);

  function drawBox(box) {
    const w = overlay.clientWidth, hgt = overlay.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(w * dpr)) { overlay.width = Math.round(w * dpr); overlay.height = Math.round(hgt * dpr); }
    const ctx = overlay.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    if (!box || !video.videoWidth) return;
    // object-fit: cover の切り抜きに合わせて座標を変換
    const vr = video.videoWidth / video.videoHeight, er = w / hgt;
    const sw = er > vr ? w : hgt * vr, sh = er > vr ? w / vr : hgt;
    const ox = (w - sw) / 2, oy = (hgt - sh) / 2;
    const [bx, by, bw, bh] = [box[0] * sw + ox, box[1] * sh + oy, box[2] * sw, box[3] * sh];
    ctx.strokeStyle = 'rgba(148,228,187,.85)'; ctx.lineWidth = 2;
    const c = Math.min(bw, bh) * 0.18;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx, by + bh, 1, -1], [bx + bw, by + bh, -1, -1]]) {
      ctx.moveTo(x + dx * c, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * c);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,92,122,.16)'; ctx.strokeStyle = 'rgba(255,92,122,.55)'; ctx.lineWidth = 1;
    for (const [fx, fy, fw, fh] of ROI_REGIONS) {
      ctx.beginPath(); ctx.rect(bx + bw * fx, by + bh * fy, bw * fw, bh * fh); ctx.fill(); ctx.stroke();
    }
  }

  return {
    el, video,
    async setStream(stream) {
      video.srcObject = stream;
      if (stream) { try { await video.play(); } catch { /* 自動再生不可でも続行 */ } }
    },
    setBox: drawBox,
    setMessage(text) { msg.hidden = !text; msg.textContent = text || ''; },
  };
}
