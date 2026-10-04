// ルーター（#/ 形式）と共通ヘッダー。各画面は mount(root, params) → cleanup を返す。

import { h, icon, clear } from './ui.js';
import * as home from './screens/home.js';
import * as measure from './screens/measure.js';
import * as room from './screens/room.js';
import * as ai from './screens/ai.js';
import * as history from './screens/history.js';
import { setLeaveGuard, leaveGuard } from './nav.js';

const ROUTES = [
  [/^\/?$/, home, ''],
  [/^\/measure$/, measure, 'ひとりで計測'],
  [/^\/room(?:\/([A-Z0-9]{6}))?$/, room, 'ルームで練習'],
  [/^\/ai$/, ai, 'AI面接練習'],
  [/^\/history$/, history, '記録'],
];

const app = document.getElementById('app');
let cleanup = null;

function header(title) {
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '#/' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), 'VITAL ROOM'),
    title ? h('span', { class: 'crumb' }, title) : null,
    h('nav', { class: 'topnav' },
      h('a', { href: '#/history', class: 'navlink' }, icon('history', 18), h('span', null, '記録'))));
}

let current = location.hash;
async function route() {
  const path = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
  const guard = leaveGuard();
  if (guard && location.hash !== current) {
    const ok = await guard();
    if (!ok) { history_replace(current); return; }
  }
  setLeaveGuard(null);
  current = location.hash;
  const hit = ROUTES.find(([re]) => re.test(path)) || ROUTES[0];
  const params = path.match(hit[0]) || [];
  if (cleanup) { try { cleanup(); } catch (e) { console.warn(e); } cleanup = null; }
  clear(app);
  app.className = `screen-${hit[1].name}`;
  const main = h('main', { class: 'main', id: 'main' });
  app.append(header(hit[2]), main);
  document.title = hit[2] ? `${hit[2]} | VITAL ROOM` : 'VITAL ROOM | ブラウザーで面接練習とバイタル計測';
  window.scrollTo(0, 0);
  cleanup = (await hit[1].mount(main, params.slice(1))) || null;
}

function history_replace(hash) {
  window.history.replaceState(null, '', hash || '#/');
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
