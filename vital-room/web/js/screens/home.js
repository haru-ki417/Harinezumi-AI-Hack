import { h, icon } from '../ui.js';

export const name = 'home';

const MODES = [
  { href: '#/measure', icon: 'pulse', step: '01', title: 'ひとりで計測',
    body: 'カメラに顔を向けるだけで、心拍・心拍変動・平常時と比べたストレスの変化を表示します。',
    meta: ['カメラ', '約1分〜'] },
  { href: '#/room', icon: 'people', step: '02', title: 'ルームで練習',
    body: '友人やキャリア担当と2人で模擬面接。映像通話をしながら、話題ごとの心拍の変化を共有できます。',
    meta: ['カメラ・マイク', 'リンクで招待'] },
  { href: '#/ai', icon: 'bot', step: '03', title: 'AI面接練習',
    body: 'AI面接官が質問し、回答に合わせて深掘りします。終了後、発言の引用付きで振り返りを作成します。',
    meta: ['マイク任意', '文字でも回答可'] },
];

export function mount(root) {
  root.append(
    h('section', { class: 'hero' },
      h('div', { class: 'hero-text' },
        h('p', { class: 'eyebrow' }, 'CONVERSATION FIRST · WEB'),
        h('h1', { class: 'headline' }, '伝わる対話を。', h('br'), h('span', null, '次の一歩へ。')),
        h('p', { class: 'lead' }, 'インストールも登録も不要。スマホ・タブレット・パソコンのブラウザーで、心拍の変化を見ながら面接の練習ができます。'),
        h('div', { class: 'hero-cta' },
          h('a', { class: 'btn primary lg', href: '#/measure' }, '計測をはじめる', icon('arrow', 18)),
          h('a', { class: 'btn ghost lg', href: '#/ai' }, 'AI面接を試す'))),
      h('div', { class: 'hero-visual', 'aria-hidden': 'true' },
        h('div', { class: 'hv-top' }, h('span', null, 'LIVE · ON DEVICE'), h('span', null, 'VITAL ROOM')),
        h('div', { class: 'hv-bpm' }, icon('heart', 26), h('b', null, '72'), h('small', null, 'BPM')),
        h('svg:svg', { viewBox: '0 0 320 70', class: 'hv-wave', preserveAspectRatio: 'none' },
          h('svg:path', { d: 'M0 40 H60 L72 40 L80 18 L90 60 L98 32 L106 40 H150 L162 40 L170 14 L180 62 L188 30 L196 40 H240 L252 40 L260 20 L270 58 L278 34 L286 40 H320' })),
        h('div', { class: 'hv-bottom' },
          h('div', null, h('span', null, 'RMSSD'), h('b', null, '41 ms')),
          h('div', null, h('span', null, 'ストレス指標'), h('b', null, '18')),
          h('div', null, h('span', null, '話題'), h('b', null, '志望動機'))))),
    h('section', { class: 'modes-grid', 'aria-label': '使い方を選ぶ' },
      MODES.map((m) => h('a', { class: 'mode-card', href: m.href },
        h('div', { class: 'mc-top' }, h('span', { class: 'mc-icon' }, icon(m.icon, 22)), h('span', { class: 'mc-step' }, m.step)),
        h('h2', null, m.title),
        h('p', null, m.body),
        h('div', { class: 'mc-meta' }, m.meta.map((t) => h('span', null, t)), h('span', { class: 'mc-go' }, icon('arrow', 18)))))),
    h('section', { class: 'trust' },
      h('div', null, icon('shield', 20), h('div', null, h('b', null, '映像は端末の外に出しません'), h('p', null, '脈拍の推定はブラウザー内で計算します。サーバーへの送信や録画はありません。'))),
      h('div', null, icon('spark', 20), h('div', null, h('b', null, 'すべて無料・登録不要'), h('p', null, 'ページを開くだけで使えます。記録はこの端末のブラウザーにだけ保存されます。'))),
      h('div', null, icon('info', 20), h('div', null, h('b', null, '医療機器ではありません'), h('p', null, '値は照明や動きの影響を受ける参考値です。体調の判断には使わないでください。')))),
    h('section', { class: 'how' },
      h('h2', null, 'しくみ'),
      h('ol', { class: 'how-steps' },
        h('li', null, h('b', null, '顔の位置を見つける'), h('span', null, 'MediaPipe の顔検出で、額と両頬の肌の領域を毎フレーム追跡します。')),
        h('li', null, h('b', null, '色の変化から脈波を取り出す'), h('span', null, '血流でわずかに変わる肌の色を POS 法で脈波に変換し、帯域通過フィルターで整えます。')),
        h('li', null, h('b', null, '心拍と変動を求める'), h('span', null, '周波数解析で心拍数を、拍の間隔から RMSSD・SDNN を計算します。')),
        h('li', null, h('b', null, '平常時と比べる'), h('span', null, '最初の平常値を基準に、心拍の上昇と RMSSD の低下からストレス指標を出します。')))),
    h('footer', { class: 'site-foot' },
      h('p', null, 'Harinezumi AI Hack チームで開発した VITAL ROOM を、サーバーなしでブラウザーだけで動くように移植した Web 版です。企業向けの面接管理や AI 音声などの機能は、リポジトリのフル版（Next.js + FastAPI）で利用できます。'),
      h('p', null, h('a', { href: 'https://github.com/haru-ki417/Harinezumi-AI-Hack', target: '_blank', rel: 'noopener' }, 'GitHub でソースを見る'))));
}
