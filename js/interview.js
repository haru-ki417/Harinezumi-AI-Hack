// AI 面接練習のロジック（端末内で完結）。
//  - nextQuestion: backend/interview_questions.py の local_next_question の移植
//  - localFeedback: backend/interview_feedback.py の local_feedback の移植
// 回答の真偽や能力を判定するものではなく、話した内容の「伝わり方」を整理する。

export const MAX_FOLLOW_UPS = 3;
export const MAX_QUESTIONS = 20;
const MAIN_QUESTION_RESERVE_SECONDS = 45;
const FOLLOW_UP_RESERVE_SECONDS = 35;

// ---------------------------------------------------------------- 質問プラン

const REFUSAL = new RegExp(
  '答えたく(?:ない|ありません)|回答(?:は|を)?(?:控え|辞退|拒否)|'
  + '(?:話|お話|説明)したく(?:ない|ありません)|答え(?:られ|れ)ません|'
  + '(?:次の質問|別の質問)(?:に|へ|を)|(?:この質問|この話題).{0,8}(?:パス|飛ば|やめ)|'
  + '^(?:パス|スキップ)(?:します|でお願いします)?[。.!！\\s]*$|'
  + "\\b(?:prefer not to answer|decline to answer|skip this question)\\b", 'i');
const NO_EXAMPLE = new RegExp(
  '(?:わかり|分かり|判り)ません|(?:思い(?:当たり|つき))ません|'
  + '(?:経験|具体例|例|エピソード).{0,8}(?:ない|ありません|ありませんでした)|'
  + '^(?:ないです|ありません|特にありません|覚えていません)[。.!！\\s]*$|'
  + "\\b(?:do not know|don't know|no experience|cannot recall)\\b", 'i');

const PLAN_FEATURES = {
  context: /授業|学業|研究|ゼミ|サークル|部活|大学|学校|アルバイト|バイト|インターン|チーム|プロジェクト|開発|イベント|仕事|業務|店舗|活動/,
  action: /担当|作成|実装|提案|調整|共有|分析|改善|作った|行った|取り組|話し合|説明|確認|検証|設計|相談|練習|計画|分担|比較/,
  own_action: /私(?:は|が|の)|自分|自身|担当|一人で|個人で/,
  reason: /(?:ため|ので|ことから|からです)|理由|判断|重視|狙い|仮説|選んだ|選び|原因/,
  result: /結果|成果|達成|完成|短縮|向上|好評|成功|提出でき|導入でき|解決し|減(?:り|った|りました)|増(?:え|やせ)|改善(?:し|され|でき)|[0-9０-９]+\s*[%％倍]/,
  measurement: /(?:前後|以前|実施前|導入前|昨年|先月|以前|従来).{0,25}(?:比|から|より)|アンケート|測定|集計|記録|検証|[0-9０-９]+\s*(?:[%％]|倍|件|時間|分|日|人|円|回)/,
  learning: /学(?:び|んだ|べた)|気づ|気付|分かりました|わかりました|大切|重要|得た教訓|振り返/,
  application: /今後|次回|次の機会|別の場面|別の活動|活か|生か|応用|再現|これから|継続/,
  challenge: /課題|困難|苦労|難し|失敗|壁|反対|衝突|意見が|遅れ/,
};

const ASKED_FOCUS = {
  example: /具体例|場面を一つ|どのような状況|思い当たる/,
  own_action: /(?:自身|自分|あなた|担当).{0,25}(?:担当|行っ|行動|作業|役割)|担当した作業/,
  reason: /理由|なぜ|何を重視|選んだ|判断の根拠/,
  result: /何が変わ|どのような結果|どんな結果|取り組みの結果|成果は|結果を教え/,
  measurement: /どのように確かめ|どう(?:測|確かめ)|測定|比較した時期|結果.{0,12}(?:確かめ|測っ|検証|確認した方法)|指標/,
  contribution: /寄与|貢献|結果につながった|ほかの要因|チーム全体の取り組み/,
  learning: /何を学|どんな学び|学んだこと|経験を振り返|変えたい点|得た教訓/,
  application: /別の場面|条件が違う|次回.{0,12}(?:生か|活か|行動)|学び.{0,12}(?:生か|活か|応用)/,
  challenge: /難しかった|困難|苦労|乗り越え|うまくいかな/,
  motivation: /理由|きっかけ|関心を持|重視して/,
  role_connection: /希望する仕事|仕事との接点|職務との接点|どのような点がつなが/,
  first_step: /まずどのような|最初の一歩|始める予定|第一歩/,
  approach: /どのような順序|必要な準備|進める方法|進め方を考え/,
  verification: /今後どのように確かめ|目安にしたい|進捗をどう確認/,
  future_example: /今後の学業|試してみたいこと/,
};

export function cleanQuestions(list) {
  return (Array.isArray(list) ? list : [])
    .filter((q) => typeof q === 'string' && q.trim())
    .map((q) => q.trim())
    .slice(0, MAX_QUESTIONS);
}

function canonical(text) {
  return Array.from(text.normalize('NFKC').toLowerCase()).filter((c) => /[\p{L}\p{N}]/u.test(c)).join('');
}

/** difflib.SequenceMatcher(None, a, b).ratio() と同じ計算。 */
export function sequenceRatio(aStr, bStr) {
  const a = Array.from(aStr), b = Array.from(bStr);
  if (!a.length && !b.length) return 1;
  const b2j = new Map();
  b.forEach((ch, i) => { if (!b2j.has(ch)) b2j.set(ch, []); b2j.get(ch).push(i); });
  if (b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [ch, idx] of [...b2j]) if (idx.length > ntest) b2j.delete(ch);
  }
  const longest = (alo, ahi, blo, bhi) => {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  };
  let matches = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2 * matches) / (a.length + b.length);
}

function repeated(text, previous) {
  const key = canonical(text);
  if (!key) return true;
  for (const old of previous) {
    const other = canonical(old);
    if (key === other) return true;
    if (Math.min(key.length, other.length) >= 16 && sequenceRatio(key, other) >= 0.88) return true;
  }
  return false;
}

const planFeatures = (text) => new Set(Object.keys(PLAN_FEATURES).filter((k) => PLAN_FEATURES[k].test(text)));

function remainingSeconds(template) {
  const v = template._remaining_seconds;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, v);
}

function planQuestionKind(question, latest) {
  if (/志望|応募.*理由|希望する.*仕事|働きたい|入社.*理由/.test(question)) return 'motivation';
  if (/(?:過去|これまで|以前).{0,30}(?:経験|活動|取り組|出来事)|(?:達成した|取り組んだ|挑戦した|実現した|学んだ).{0,25}(?:経験|出来事|こと)|(?:経験|出来事)(?:について|を)(?:教え|話|聞かせ|説明)/.test(question)) return 'experience';
  if (/今後|将来|目指|目標|学びたい|挑戦したい|やりたい|取り組みたい|興味|関心/.test(question)) return 'future';
  if (/将来|今後|したい|学びたい|目指したい|取り組む予定/.test(latest)
      && !/しました|できました|なりました|だった|した経験/.test(latest)) return 'future';
  return 'experience';
}

function plannedFocusOrder(kind, combined, asked) {
  const order = [];
  if (!planFeatures(combined).has('reason')) order.push('motivation');
  if (kind === 'motivation') order.push('role_connection');
  order.push('first_step');
  if (kind === 'future') order.push('approach');
  order.push('verification');
  return order.filter((f) => !asked.has(f));
}

function localWording(focus, latest) {
  switch (focus) {
    case 'future_example': return '今後の学業・活動・仕事で、まず試してみたいことはありますか。思い当たらない場合は、その旨を教えてください。';
    case 'motivation': return 'その目標や仕事に関心を持った理由や、きっかけを教えてください。特にどのような点を重視していますか。';
    case 'role_connection': return 'これまでの学びや興味と、希望する仕事のどのような点がつながると考えていますか。今分かる範囲で教えてください。';
    case 'first_step': return 'その目標に向けて、まずどのようなことから始める予定ですか。まだ決まっていない点があれば、それも教えてください。';
    case 'approach': return 'その取り組みを進めるとき、どのような順序や方法を考えていますか。必要な準備も含めて教えてください。';
    case 'verification': return '取り組みを進められたかどうか、今後どのように確かめたいですか。目安にしたいことを教えてください。';
    case 'example':
      if (NO_EXAMPLE.test(latest)) return '学業・活動・日常の中で思い当たる具体例はありますか。思い当たらない場合は、その旨を教えてください。';
      return 'いまのお話について、実際に取り組んだ場面を一つ選び、どのような状況だったか教えてください。';
    case 'own_action': return 'その場面で、周囲の方と分担したことのうち、ご自身が担当して実際に行ったことを教えてください。';
    case 'reason':
      if (/共有|報告|連絡|進捗/.test(latest)) return 'その情報共有の進め方を選んだ理由と、特に工夫した点を教えてください。';
      if (/提案|改善策|解決策/.test(latest)) return 'その提案・改善策を選んだのはなぜですか。ほかの選択肢と比べたときの判断の根拠を教えてください。';
      if (/分析|調査|確認|検証/.test(latest)) return 'その分析・確認の進め方を選んだ理由と、判断の根拠にした情報を教えてください。';
      return 'いまお話しいただいた行動を選んだ理由を教えてください。ほかの方法も考えたうえで、何を重視して判断しましたか。';
    case 'result': return 'その取り組みによって、実施前と比べて何が変わりましたか。分かる範囲で、結果を確認できた事実を教えてください。';
    case 'measurement': return 'いまお話しいただいた結果は、どのように確かめましたか。比較した時期や記録など、判断の根拠を教えてください。';
    case 'contribution': {
      const other = /チーム|メンバー|みんな|全員|分担/.test(latest) ? 'チーム全体の取り組み' : 'ほかの要因';
      return `その結果につながった、ご自身の働きかけは何だと考えていますか。${other}との関係も含めて教えてください。`;
    }
    case 'learning': return 'その経験から何を学びましたか。振り返って、次も続けたい工夫や変えたい点を教えてください。';
    case 'application': return 'その学びを、条件が違う別の場面で生かすとしたら、まずどのように行動しますか。';
    default: return 'その進め方で難しかった点と、乗り越えるために変えたことを具体的に教えてください。';
  }
}

function focusOrder(latest, combined, asked) {
  const current = planFeatures(latest);
  const covered = planFeatures(combined);
  const has = (set, ...keys) => keys.some((k) => set.has(k));
  const preferred = [];
  if (NO_EXAMPLE.test(latest) || (latest.trim().length < 20 && !has(current, 'action', 'result', 'learning'))) preferred.push('example');
  if (current.has('learning') && !covered.has('application')) preferred.push('application');
  if (current.has('result')) preferred.push(...(!covered.has('measurement') ? ['measurement', 'contribution'] : ['contribution', 'learning']));
  if (current.has('action')) {
    if (!covered.has('own_action') && /チーム|みんな|全員|メンバー|分担/.test(combined)) preferred.push('own_action');
    preferred.push(!covered.has('reason') ? 'reason' : 'result');
  }
  if (current.has('challenge') && !current.has('action')) preferred.push('challenge');
  if (!has(covered, 'context', 'action', 'result', 'learning')) preferred.push('example');
  for (const [feature, focus] of [['action', 'own_action'], ['reason', 'reason'], ['result', 'result'], ['learning', 'learning'], ['application', 'application']]) {
    if (!covered.has(feature)) {
      if (focus === 'application' && !covered.has('learning')) continue;
      preferred.push(focus);
    }
  }
  preferred.push('challenge', 'learning', 'contribution', 'result');
  return [...new Set(preferred)].filter((f) => !asked.has(f));
}

/**
 * 次の質問を決める。
 * @param {{questions: string[], _remaining_seconds?: number}} template
 * @param {{role: string, text: string, question_index: number}[]} transcript
 * @returns {{text: string, question_index: number, is_follow_up: boolean, focus?: string}}
 */
export function nextQuestion(template, transcript) {
  const questions = cleanQuestions(template.questions);
  const complete = { text: '', question_index: questions.length, is_follow_up: false };
  const remaining = remainingSeconds(template);
  if (!questions.length || remaining === 0) return complete;
  const turns = transcript.filter((t) => ['ai', 'interviewer', 'candidate'].includes(t.role));
  if (!turns.length) return { text: questions[0], question_index: 0, is_follow_up: false };
  const latestTurn = turns[turns.length - 1];
  if (latestTurn.role !== 'candidate') return { ...complete, question_index: latestTurn.question_index ?? 0 };
  const index = latestTurn.question_index ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= questions.length) return complete;
  const branch = turns.filter((t) => t.question_index === index);
  const answers = branch.filter((t) => t.role === 'candidate');
  const branchQuestions = branch.filter((t) => t.role !== 'candidate').map((t) => String(t.text ?? ''));
  const depth = Math.max(0, branchQuestions.length - 1, answers.length - 1);
  const latest = String(latestTurn.text ?? '').trim();
  const kind = planQuestionKind(questions[index], latest);
  const combined = answers.map((t) => String(t.text ?? '')).join('\n');
  const covered = planFeatures(combined);
  const nextIndex = index + 1;
  const advance = nextIndex < questions.length
    ? { text: questions[nextIndex], question_index: nextIndex, is_follow_up: false } : complete;
  if (depth >= MAX_FOLLOW_UPS || REFUSAL.test(latest)) return advance;
  if (NO_EXAMPLE.test(latest) && (depth >= 1 || answers.filter((t) => NO_EXAMPLE.test(String(t.text ?? ''))).length >= 2)) return advance;
  if (remaining !== null && remaining < (questions.length - nextIndex) * MAIN_QUESTION_RESERVE_SECONDS + FOLLOW_UP_RESERVE_SECONDS) return advance;
  if (kind === 'experience' && combined.length >= 130
      && ['action', 'own_action', 'reason', 'result'].every((k) => covered.has(k))
      && (covered.has('measurement') || covered.has('learning'))) return advance;
  const asked = new Set(Object.keys(ASKED_FOCUS).filter((f) => branchQuestions.slice(1).some((q) => ASKED_FOCUS[f].test(q))));
  const focuses = kind === 'experience' ? focusOrder(latest, combined, asked) : plannedFocusOrder(kind, combined, asked);
  if (kind !== 'experience' && NO_EXAMPLE.test(latest) && !asked.has('future_example')) focuses.unshift('future_example');
  for (const focus of focuses) {
    const text = localWording(focus, latest);
    if (repeated(text, branchQuestions)) continue;
    return { text, question_index: index, is_follow_up: true, focus };
  }
  return advance;
}

// ---------------------------------------------------------------- フィードバック

const MAX_LOCAL_TURNS = 400;
const MAX_TEXT = 6000;

const UNSAFE = new RegExp(
  '採用|不採用|合否|合格|不合格|適性|向いて|性格|人格|人柄|誠実|不誠実|嘘|'
  + '正直|診断|心拍|ストレス|緊張|不安|容姿|外見|人種|民族|国籍|宗教|'
  + '妊娠|結婚|婚姻|家族構成|性的指向|性自認|障害|年齢|性別|支持政党|'
  + '[0-9０-９]+\\s*(?:点|点満点)|[A-EＳＡＢＣＤＥ]\\s*評価|総合評価|スコア|'
  + '(?:ignore|disregard|override).{0,60}(?:instruction|prompt|system)|'
  + 'system\\s*(?:prompt|message)|developer\\s*message|'
  + '(?:指示|命令|プロンプト).{0,30}(?:無視|上書き)|'
  + '(?:無視|上書き).{0,30}(?:指示|命令|プロンプト)|'
  + 'システムプロンプト|API[ _-]?キー|api[ _-]?key|秘密鍵|https?://|<[^>]+>|'
  + '\\b(?:hire|hiring|reject|score|ranking|personality|honest|dishonest|nervous|'
  + 'anxiety|diagnos\\w*|ethnic\\w*|religio\\w*|pregnan\\w*|marital|gender|race|nationality)\\b', 'i');
const EMPTY_ANSWER = /^(?:はい|いいえ|わかりません|分かりません|思いつきません|ありません|特にありません|パス)[。.!！\s]*$/;
const NEGATION = /(?:していません|しません|しなかった|していない|できません|できなかった|ではありません|していませんでした)/;

// [pattern, 見出し, 観察, 要素名, 次の一歩]
const FB = {
  role: [/(?:私[はが]|自分[はがの]|自身[はがの]).{0,35}(?:担当|役割|受け持)|を担当|担当(?:した|しました|して|は)|役割は/,
    '自分の担当を説明', '担当や役割を述べた箇所があります。', '自分が担った範囲', '[自分の担当範囲]と[チーム全体の役割]を分けて説明する'],
  action: [/(?:実施|提案|作成|共有|調査|相談|練習|設計|検証|改善|分担|整理|開発|分析|確認|工夫|話し合|取り組|働きかけ)(?:し|を|ん|い|ま|た)/,
    '行動を言葉にしている', '取り組みや行動に関する表現があります。', '行動についての説明', '[自分が実際に行ったこと]を実行した順に二つ挙げる。予定の行動とは区別する'],
  reason: [/なぜなら|理由|ため|ので|判断した|考えたのは/,
    '理由・背景に触れている', '理由や背景を説明する表現があります。', 'その行動を選んだ理由', '[当時の課題]と[その方法を選んだ理由]を一文ずつ補う'],
  result: [/結果|達成|増え|減り|減ら|向上|改善され|成功|完成|つなが|繋が|上が|下が|完了|できるよう/,
    '結果に触れている', '結果や変化について述べた箇所があります。', '行動の後に起きた変化', '[行動の前後の変化]を、実際に確認できた範囲で説明する'],
  detail: [/[0-9０-９]+\s*(?:人|件|回|日|週|月|年|時間|分|割|倍|%|％)|[一二三四五六七八九十百]+(?:人|件|回|日|週間|時間|割|倍)/,
    '規模・期間などを具体化', '人数・回数・期間などを示す表現があります。', '取り組みの規模や期間', '[人数・期間・回数など分かる事実]を一つ添える。分からない数字は補わない'],
  learning: [/学(?:び|ん)|気づ|気付|次(?:は|回)|今後|活か|生か|振り返/,
    '学び・次の行動に触れている', '学びや今後の行動を述べた箇所があります。', '経験から得た学び', '[この経験で分かったこと]と[次に試すこと]を結び付ける'],
  motive: [/志望|興味|魅力|関心|惹か|ひか|希望|携わ|働きたい/,
    '関心・志望を言葉にしている', '関心や志望について述べる表現があります。', '関心を持った点', '[仕事のどの点に関心があるか]を最初の一文で伝える'],
  work_link: [/職種|仕事|業務|事業|サービス|製品|開発|エンジニア|営業|企画|研究|御社|貴社/,
    '仕事との接点に触れている', '仕事や事業に関する具体的な言葉があります。', '志望する仕事との接点', '[実際に調べた職種や事業の特徴]と[自分の関心]のつながりを説明する'],
  experience_link: [/経験|大学|ゼミ|研究|授業|アルバイト|活動|取り組|制作|開発した|作成した/,
    '経験・活動に触れている', '経験や活動について述べる表現があります。', '関心につながった経験やきっかけ', '[関心を持つきっかけになった出来事]を、実際に経験した範囲で一つ添える'],
  goal: [/たい|目指|目標|将来|挑戦|身につけ|身に付け/,
    '今後の希望を言葉にしている', '希望や目標を表す言葉があります。', '今後の目標', '[何を学びたいか・できるようになりたいか]を一文で示す'],
  goal_reason: [/なぜなら|理由|ため|ので|きっかけ|関心|興味/,
    '目標の理由に触れている', '理由や関心を説明する表現があります。', 'その目標を選んだ理由', '[その目標に関心を持った理由]を、自分の考えや経験と結び付けて説明する'],
  next_step: [/まず|次に|毎[日週月]|予定|計画|始め|取り組|練習|受講|参加|実装|作成|試す|勉強/,
    '進め方に触れている', '取り組み方や次の行動について述べる表現があります。', '次に取る具体的な行動', '[最初に取り組むこと]と[いつ・どのくらい行うか]を、今の計画として説明する'],
  progress: [/確かめ|振り返|検証|比較|目安|目標値|達成|測|記録|フィードバック|進捗|できたか|理解でき/,
    '進み具合の確認に触れている', '進み具合の確認や振り返りに関する言葉があります。', '進み具合の確かめ方', '[どんな状態になれば前進したと分かるか]と[確認する時期]を考える'],
};
const CONTEXT_FEATURES = {
  past: ['role', 'action', 'reason', 'result', 'detail', 'learning'],
  motivation: ['motive', 'work_link', 'experience_link'],
  future: ['goal', 'goal_reason', 'next_step', 'progress', 'detail'],
};

function feedbackKind(question) {
  if (/志望|応募.{0,8}理由|(?:当社|弊社|この会社|この職種).{0,12}(?:選|興味|関心|魅力)/.test(question)) return 'motivation';
  if (/(?:過去|これまで|以前).{0,30}(?:経験|活動|取り組|出来事)|(?:達成した|取り組んだ|挑戦した|実現した|学んだ).{0,25}(?:経験|出来事|こと)|(?:経験|出来事)(?:について|を)(?:教え|話|聞かせ|説明)/.test(question)) return 'past';
  if (/今後|将来|これから|キャリア|目標|学びたい|身につけたい|身に付けたい|挑戦したい|やりたい|入社後/.test(question)) return 'future';
  return 'past';
}

const safe = (text) => !UNSAFE.test(text);
const refKey = (r) => `${r.turn_id}\u0000${r.quote}`;

function groupsOf(template, transcript) {
  const questions = cleanQuestions(template.questions);
  const groups = new Map();
  for (const turn of transcript.slice(0, MAX_LOCAL_TURNS)) {
    if (!turn || !['candidate', 'ai', 'interviewer'].includes(turn.role)) continue;
    const index = turn.question_index ?? -1;
    if (!Number.isInteger(index) || index < -1 || index >= MAX_QUESTIONS) continue;
    if (!groups.has(index)) {
      const q = index >= 0 && index < questions.length ? questions[index] : index === -1 ? '対人面接でのやり取り' : '面接中の質問';
      groups.set(index, { question_index: index, question: safe(q) ? q : '面接中の質問', turns: [] });
    }
    const { text, id } = turn;
    if (turn.role === 'candidate' && typeof text === 'string' && text.trim() && typeof id === 'string' && id.length > 0 && id.length <= 200) {
      groups.get(index).turns.push({ id, text: Array.from(text).slice(0, MAX_TEXT).join('') });
    }
  }
  return [...groups.values()].slice(0, MAX_QUESTIONS);
}

function segmentsOf(turns) {
  const out = [];
  for (const turn of turns) {
    for (const m of turn.text.matchAll(/[^。！？!?\n]+[。！？!?]?/g)) {
      const raw = m[0].trim();
      if (!raw || !safe(raw)) continue;
      const chars = Array.from(raw);
      for (let off = 0; off < Math.min(chars.length, MAX_TEXT); off += 350) {
        const quote = chars.slice(off, off + 350).join('');
        if (quote.trim()) out.push({ turn_id: turn.id, quote });
      }
    }
  }
  return out;
}

function outline(features, kind) {
  if (kind === 'motivation') return [
    '結論：[志望する理由・関心を持った点]を一文で伝える',
    '仕事との接点：[調べた職種や事業の特徴]と[自分の関心]を結び付ける',
    'きっかけ：[関心につながった実際の経験や出来事]を一つ添える',
    '希望：[その仕事で取り組んでみたいこと]を、自分の希望として述べる',
  ];
  if (kind === 'future') return [
    '目標：[今後学びたいこと・目指す状態]を一文で伝える',
    '理由：[その目標を選んだ理由やきっかけ]を説明する',
    '行動：[まず取り組むこと]と[開始時期・頻度]を、これからの計画として述べる',
    '確認：[進み具合を確かめる方法]と[振り返る時期]を考える',
  ];
  return [
    '結論：[質問への答え]を最初の一文で伝える',
    '背景・役割：[取り組んだ状況]と[自分の担当範囲]を説明する',
    'action' in features ? '行動・理由：話した行動から[自分がしたこと]と[その理由]を整理する' : '行動・理由：[実際に自分がしたこと]と[その方法を選んだ理由]を補う',
    '結果・学び：[確認できた変化]と[分かったこと]を述べる。未確認の結果は未確認と伝える',
  ];
}

/** 発言の表現だけから、引用付きの振り返りを作る。 */
export function localFeedback(template, transcript) {
  const groups = groupsOf(template, transcript);
  const reviews = [], strengths = [], improvements = [];
  const missingCounts = new Map();
  const positiveSeen = new Set(), missingSeen = new Set();
  const answerCount = groups.reduce((n, g) => n + g.turns.length, 0);
  for (const group of groups) {
    const kind = feedbackKind(group.question);
    const keys = CONTEXT_FEATURES[kind];
    const segments = segmentsOf(group.turns);
    const substantive = segments.filter((s) => !EMPTY_ANSWER.test(s.quote));
    const features = {};
    for (const key of keys) {
      const ev = substantive.find((s) => FB[key][0].test(s.quote) && !NEGATION.test(s.quote));
      if (ev) features[key] = ev;
    }
    const missing = keys.filter((k) => k !== 'detail' && !(k in features));
    const evidence = [];
    for (const ref of [...Object.values(features), ...segments]) {
      if (!evidence.some((e) => refKey(e) === refKey(ref))) evidence.push(ref);
      if (evidence.length === 3) break;
    }
    const inEvidence = (ref) => evidence.some((e) => refKey(e) === refKey(ref));
    let summary, reviewImprovements;
    if (!segments.length) {
      summary = '確認できる回答の記録がないため、回答内容への助言は作成していません。';
      reviewImprovements = ['記録がないことは、経験や能力がないことを意味しません。次回は回答が文字起こしに残っているか確認してください。'];
    } else if (!substantive.length || substantive.reduce((n, s) => n + Array.from(s.quote).length, 0) < 20) {
      summary = '短い回答が記録されています。引用の範囲では、答えの背景や詳しい説明までは確認できません。';
      reviewImprovements = {
        past: ['回答内では具体的な出来事を確認できません。思い当たる経験を一つ選び、状況と自分がしたことを補ってください。経験がなければその旨を伝えて構いません。'],
        motivation: ['回答内では関心を持った理由を詳しく確認できません。仕事のどの点に関心があり、何がきっかけだったかを補ってください。まだ考えている途中なら、その旨を伝えて構いません。'],
        future: ['回答内では今後の目標や進め方を詳しく確認できません。学びたいこととその理由、まず試す行動を補ってください。未定の点は未定と伝えて構いません。'],
      }[kind];
    } else {
      const labels = Object.entries(features).filter(([, r]) => inEvidence(r)).map(([k]) => FB[k][3]);
      summary = labels.length
        ? `回答では、${labels.slice(0, 4).join('・')}に触れています。詳しさや前後の文脈は引用で確認してください。`
        : '記録された回答を引用しました。質問への答えとその理由を聞き手が追えるように、説明を整理する余地があります。';
      reviewImprovements = missing.slice(0, 3).map((k) => `回答内では${FB[k][3]}を明確に確認できません。${FB[k][4]}。`);
      if (!missing.length) reviewImprovements = ['質問への答えを冒頭に置き、理由と補足が続く順に並べ直して、同じ説明の繰り返しを減らせるか確認してください。'];
    }
    const reviewStrengths = Object.entries(features).filter(([, r]) => inEvidence(r)).map(([k]) => FB[k][2]).slice(0, 4);
    reviews.push({
      question_index: group.question_index, question: group.question, kind, summary, evidence,
      strengths: reviewStrengths, improvements: reviewImprovements,
      answer_outline: segments.length ? outline(features, kind) : [],
    });
    for (const [key, ref] of Object.entries(features)) {
      if (!positiveSeen.has(key) && strengths.length < 4) {
        positiveSeen.add(key);
        strengths.push({ title: FB[key][1], observation: FB[key][2], evidence: [ref],
          suggestion: '引用した箇所を残し、質問への答えとして伝わる順序になっているか読み返してください。' });
      }
    }
    if (segments.length) {
      for (const key of missing) missingCounts.set(key, (missingCounts.get(key) || 0) + 1);
      for (const key of missing.slice(0, 3)) {
        if (!missingSeen.has(key) && improvements.length < 4) {
          missingSeen.add(key);
          improvements.push({ title: `${FB[key][3]}を補う`,
            observation: `この質問への回答内では、${FB[key][3]}を明確に確認できません。経験の有無についての判断ではありません。`,
            evidence: evidence.slice(0, 1), suggestion: `${FB[key][4]}。` });
        }
      }
    }
  }
  // Counter.most_common と同じく、同数なら先に数えたものを優先する。
  const practicePlan = [...missingCounts.entries()]
    .map(([k, n], i) => [k, n, i]).sort((a, b) => b[1] - a[1] || a[2] - b[2])
    .slice(0, 2).map(([k]) => `${FB[k][4]}。`);
  if (answerCount) practicePlan.push('質問別の構成例に沿って、実際の経験と今後の希望・計画を区別して60〜90秒で話し、録音で質問への答えが冒頭にあるか確認する。');
  let summary = answerCount
    ? `回答${answerCount}件を、質問ごとに整理しました。発言の引用から、伝わっている要素と補足できる要素を振り返ります。表現に基づく整理のため、経験の有無や能力を判定するものではありません。`
    : '面接の回答記録がないため、具体的なフィードバックはまだ作成できません。';
  if (transcript.length > MAX_LOCAL_TURNS) summary += `この振り返りは先頭${MAX_LOCAL_TURNS}件の発言を対象にしています。`;
  return { version: 1, source: 'local', generated_at: new Date().toISOString(), summary,
    strengths, improvements, question_reviews: reviews, practice_plan: practicePlan };
}

// ---------------------------------------------------------------- 質問セット

export const QUESTION_SETS = [
  { id: 'standard', title: '新卒・総合', note: '自己紹介から志望動機、将来像まで一通り',
    questions: [
      '自己紹介をお願いします。',
      '学生時代に力を入れて取り組んだ経験について教えてください。',
      'この職種を志望する理由を教えてください。',
      '入社後に挑戦したいことや、将来の目標を教えてください。',
    ] },
  { id: 'gakuchika', title: 'ガクチカ深掘り', note: '経験を、行動・理由・結果・学びの順に掘り下げる',
    questions: [
      '学生時代に力を入れて取り組んだ経験について教えてください。',
      'これまでの活動で、困難を乗り越えた経験について教えてください。',
    ] },
  { id: 'motivation', title: '志望動機・キャリア', note: '関心の理由と、これからの計画を言葉にする',
    questions: [
      'この職種を志望する理由を教えてください。',
      '今後身につけたいスキルと、その理由を教えてください。',
      '5年後にどのような仕事をしていたいですか。将来の目標を教えてください。',
    ] },
];
