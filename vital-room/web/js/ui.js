// DOM・表示まわりの小さなヘルパー。フレームワークは使わない。

/** 要素を作る。props: class / style(object) / on* / その他は属性。 */
export function h(tag, props, ...children) {
  const el = tag.includes(':') ? document.createElementNS('http://www.w3.org/2000/svg', tag.split(':')[1]) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && !(el instanceof SVGElement) && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

// ---------------------------------------------------------------- アイコン（線画 24px）
const PATHS = {
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  pulse: 'M3 12h4l2-5 4 10 2-5h6',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14a6.5 6.5 0 0 1 3.5 6',
  chat: 'M4 5h16v11H9l-5 4z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 4.6 2.5M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18',
  cam: 'M3 7h12v10H3zM15 10l6-3v10l-6-3',
  camOff: 'M3 7h9M15 10l6-3v10l-6-3M15 14v3H3V7M3 3l18 18',
  share: 'M12 3v12M7 8l5-5 5 5M5 14v6h14v-6',
  end: 'M5 15c4-4 10-4 14 0l-2 3-3-1v-2.5a8 8 0 0 0-4 0V17l-3 1z',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  play: 'M7 5v14l11-7z',
  stop: 'M7 7h10v10H7z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
  history: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5M12 8v4l3 2',
  speaker: 'M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6',
  send: 'M4 12l16-8-6 16-2-6z',
  skip: 'M6 5l8 7-8 7zM17 5v14',
  check: 'M5 12l5 5 9-10',
  close: 'M6 6l12 12M18 6 6 18',
  info: 'M12 8v.5M12 11v6M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
  bot: 'M5 9h14v10H5zM12 5v4M9 13v1M15 13v1M9 17h6M12 3.5v.5',
};

export function icon(name, size = 20) {
  return h('svg:svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ico' },
  h('svg:path', { d: PATHS[name] || PATHS.info }));
}

// ---------------------------------------------------------------- 通知
export function toast(message, kind = 'info') {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(host); }
  const el = h('div', { class: `toast ${kind}` }, message);
  host.append(el);
  setTimeout(() => el.classList.add('out'), 3600);
  setTimeout(() => el.remove(), 4000);
}

/** 確認ダイアログ（ブラウザ標準の confirm を使わない）。 */
export function confirmDialog({ title, body, ok = 'OK', cancel = 'キャンセル', danger = false }) {
  return new Promise((resolve) => {
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const dlg = h('dialog', { class: 'dialog' },
      h('h2', null, title),
      body ? h('p', null, body) : null,
      h('div', { class: 'row end' },
        h('button', { class: 'btn ghost', onclick: () => close(false) }, cancel),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, ok)));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- 書式
export const fmt = {
  bpm: (v) => (v == null || !(v > 0) ? '--' : Math.round(v).toString()),
  num: (v, d = 0) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(d)),
  time: (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },
  date: (ms) => new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
};

export function stressLabel(v) {
  if (v == null) return '—';
  if (v < 25) return '落ち着いている';
  if (v < 55) return 'やや高め';
  return '高め';
}

// ---------------------------------------------------------------- 保存（端末内のみ）
const KEY = 'vitalroom.history.v1';

export const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  history() { return store.get(KEY, []); },
  addHistory(entry) {
    const list = store.history();
    list.unshift({ id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), at: Date.now(), ...entry });
    return store.set(KEY, list.slice(0, 50));
  },
  removeHistory(id) { store.set(KEY, store.history().filter((e) => e.id !== id)); },
  clearHistory() { store.set(KEY, []); },
};

export function download(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- 折れ線グラフ（canvas）

/**
 * series: [{ points: [[t, v]...], color, label }]
 * opts: { min, max, unit, markers: [[t, label]], tMin, tMax, height }
 */
export function lineChart(canvas, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300, cssH = canvas.clientHeight || opts.height || 140;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue('--line').trim() || '#293a32';
  const mute = css.getPropertyValue('--text-mute').trim() || '#97aa9f';
  const pad = { l: 34, r: 10, t: 10, b: 20 };
  const all = series.flatMap((s) => s.points);
  const ts = all.map((p) => p[0]);
  const tMin = opts.tMin ?? (ts.length ? Math.min(...ts) : 0);
  const tMax = Math.max(opts.tMax ?? (ts.length ? Math.max(...ts) : 1), tMin + 1);
  let vMin = opts.min, vMax = opts.max;
  let step = null;
  if (vMin == null || vMax == null) {
    const vs = all.map((p) => p[1]);
    const lo = vs.length ? Math.min(...vs) : 0, hi = vs.length ? Math.max(...vs) : 1;
    const span = Math.max(10, hi - lo + 10);
    step = [5, 10, 20, 25, 50, 100].find((s) => span / s <= 4) || 100;
    vMin = vMin ?? Math.floor((lo - 4) / step) * step;
    vMax = vMax ?? Math.ceil((hi + 4) / step) * step;
  }
  if (vMax <= vMin) vMax = vMin + 1;
  step = step || (vMax - vMin) / 4;
  const X = (t) => pad.l + ((t - tMin) / (tMax - tMin)) * (cssW - pad.l - pad.r);
  const Y = (v) => pad.t + (1 - (v - vMin) / (vMax - vMin)) * (cssH - pad.t - pad.b);

  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.fillStyle = mute; ctx.strokeStyle = line; ctx.lineWidth = 1;
  for (let v = vMin; v <= vMax + 1e-9; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(cssW - pad.r, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(v)), pad.l - 6, y);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('0:00', pad.l, cssH - 5);
  ctx.textAlign = 'right';
  ctx.fillText(fmt.time(tMax - tMin), cssW - pad.r, cssH - 5);

  for (const [t, label] of opts.markers || []) {
    const x = Math.round(X(t)) + 0.5;
    ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = mute;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, cssH - pad.b); ctx.stroke(); ctx.restore();
    if (label) { ctx.textAlign = 'left'; ctx.fillStyle = mute; ctx.fillText(label.slice(0, 10), x + 3, pad.t + 9); }
  }

  for (const s of series) {
    if (!s.points.length) continue;
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    let prev = null;
    for (const [t, v] of s.points) {
      const x = X(t), y = Y(Math.min(vMax, Math.max(vMin, v)));
      if (prev == null || t - prev > (opts.gap ?? 5)) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prev = t;
    }
    ctx.stroke();
  }
}

export function average(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
