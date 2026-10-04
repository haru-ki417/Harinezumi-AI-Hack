import { h, icon, fmt, store, confirmDialog, toast } from '../ui.js';
import { summaryView } from './measure.js';
import { roomReportView } from './room.js';
import { feedbackView } from './ai.js';

export const name = 'history';

const TYPE = {
  measure: { label: '計測', icon: 'pulse' },
  room: { label: 'ルーム', icon: 'people' },
  ai: { label: 'AI面接', icon: 'bot' },
};

function headline(e) {
  if (e.type === 'measure') return `平均 ${fmt.bpm(e.summary?.bpmAvg)} BPM ・ ${fmt.time(e.summary?.duration || 0)}`;
  if (e.type === 'room') return `${fmt.time(e.report?.duration || 0)} ・ 話題 ${new Set((e.report?.topics || []).map((t) => t.topic)).size} 件`;
  if (e.type === 'ai') return `回答 ${(e.transcript || []).filter((t) => t.role === 'candidate').length} 件 ・ ${fmt.time(e.duration || 0)}`;
  return '';
}

function detail(e) {
  if (e.type === 'measure') {
    const samples = (e.samples || []).map(([t, bpm, stress]) => ({ t, bpm, stress }));
    return summaryView(e.summary, samples);
  }
  if (e.type === 'room') return roomReportView(e.report);
  if (e.type === 'ai') return feedbackView({ feedback: e.feedback, vitalsByQ: e.vitalsByQ, transcript: e.transcript });
  return h('p', null, '表示できない記録です。');
}

export function mount(root) {
  function render() {
    const list = store.history();
    root.replaceChildren(
      h('div', { class: 'page-head row' },
        h('div', null, h('h1', null, '記録'), h('p', null, '保存した結果は、このブラウザーの中にだけ残っています（最大50件）。')),
        list.length ? h('button', { class: 'btn ghost sm', onclick: async () => {
          if (await confirmDialog({ title: 'すべての記録を削除しますか？', body: '元に戻せません。', ok: 'すべて削除', danger: true })) { store.clearHistory(); render(); toast('記録を削除しました。'); }
        } }, icon('trash', 16), 'すべて削除') : null),
      list.length ? h('div', { class: 'history' }, list.map((e) => {
        const t = TYPE[e.type] || { label: '記録', icon: 'info' };
        const body = h('div', { class: 'hist-body' });
        const item = h('details', { class: 'hist-item' },
          h('summary', null,
            h('span', { class: `hist-icon ${e.type}` }, icon(t.icon, 18)),
            h('span', { class: 'hist-main' }, h('b', null, e.title || t.label), h('small', null, headline(e))),
            h('time', null, fmt.date(e.at))),
          body,
          h('div', { class: 'row end' }, h('button', { class: 'btn ghost sm danger-text', onclick: async () => {
            if (await confirmDialog({ title: 'この記録を削除しますか？', ok: '削除', danger: true })) { store.removeHistory(e.id); render(); }
          } }, icon('trash', 16), '削除')));
        item.addEventListener('toggle', () => { if (item.open && !body.firstChild) body.append(detail(e)); });
        return item;
      })) : h('div', { class: 'card empty-state' },
        icon('history', 30),
        h('h2', null, 'まだ記録はありません'),
        h('p', null, '計測・ルーム練習・AI面接のあとに「記録に保存」を押すと、ここで見返せます。'),
        h('div', { class: 'row center wrap' },
          h('a', { class: 'btn primary', href: '#/measure' }, '計測をはじめる'),
          h('a', { class: 'btn ghost', href: '#/ai' }, 'AI面接練習'))));
  }
  render();
}
