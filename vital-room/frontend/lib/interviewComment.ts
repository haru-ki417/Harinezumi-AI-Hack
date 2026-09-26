// 面接内容に関するコメント(ルールベース・AIなし)。
// 心拍・ストレスの数値コメントとは別に、「回答時間・発言量・項目カバー率・
// 未回答項目」など既に集めているデータから、面接の進行に関する所見を機械的に
// 生成する。役割(面接官/候補者)で観点と語り口を出し分ける。
import type { ReportSummary } from './reportAnalysis';
import type { OrganizeRow } from '@/components/Organize';

export interface InterviewComment {
  heading: string;   // セクション見出し
  note?: string;     // 補足(注意書き)
  lines: string[];   // 箇条書きの所見
}

interface Input {
  summary: ReportSummary;
  organizeRows: OrganizeRow[];
  role: 'interviewer' | 'candidate';
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function fmtMinSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `約${s}秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `約${m}分${r}秒` : `約${m}分`;
}

function candidateChars(row: OrganizeRow): number {
  return row.segments
    .filter((s) => s.role === 'candidate')
    .reduce((sum, s) => sum + (s.text?.length ?? 0), 0);
}

/** 役割に応じた面接内容コメントを組み立てる。 */
export function buildInterviewComment({ summary, organizeRows, role }: Input): InterviewComment {
  const isInterviewer = role === 'interviewer';
  const heading = isInterviewer
    ? '面接内容に関するコメント（面接官向け・着眼点）'
    : '面接内容に関するコメント（振り返り）';

  const lines: string[] = [];

  // --- 全体サマリー ---
  const totalSec = Math.max(0, (summary.endedAt - summary.startedAt) / 1000);
  const qCount = summary.questions.length;
  lines.push(`全体で${fmtMinSec(totalSec)}、${qCount}件の質問・話題を扱いました。`);

  // 発言(文字起こし)が全く無い場合は、時間ベースのみに絞る。
  const hasSpeech = organizeRows.some((r) => r.segments.length > 0);

  // --- 費やした時間が短い話題 ---
  const durable = summary.questions
    .map((q) => ({ q, sec: (q.endedAt - q.startedAt) / 1000 }))
    .filter((x) => x.sec >= 3 && x.q.topic && x.q.topic !== '導入');
  if (durable.length >= 3) {
    const med = median(durable.map((x) => x.sec));
    const shortest = durable.reduce((a, b) => (b.sec < a.sec ? b : a));
    if (med > 0 && shortest.sec < med * 0.6) {
      lines.push(isInterviewer
        ? `${shortest.q.label}「${shortest.q.topic}」は他より短時間（${fmtMinSec(shortest.sec)}）で進みました。深掘りの余地があるかもしれません。`
        : `「${shortest.q.topic}」は短めでした（${fmtMinSec(shortest.sec)}）。具体例を一つ添えると、より伝わりやすくなります。`);
    }
  }

  // --- 項目のカバー状況(未回答/よく話せた項目) ---
  if (hasSpeech) {
    const notYet = organizeRows.filter((r) => r.planned && !r.covered).map((r) => r.item);
    if (notYet.length > 0) {
      const shown = notYet.slice(0, 4).join('、');
      const more = notYet.length > 4 ? ` ほか${notYet.length - 4}件` : '';
      lines.push(isInterviewer
        ? `候補者の発言が記録されていない項目：${shown}${more}（時間があれば触れる余地があります）。`
        : `まだ話せていない項目：${shown}${more}（話す機会に備えて準備しておくと安心です）。`);
    }
    const spoken = organizeRows
      .map((r) => ({ item: r.item, chars: candidateChars(r) }))
      .filter((x) => x.chars > 0)
      .sort((a, b) => b.chars - a.chars);
    if (spoken.length > 0) {
      lines.push(isInterviewer
        ? `候補者の発言量が最も多かった項目は「${spoken[0].item}」でした。`
        : `よく話せた話題は「${spoken[0].item}」でした。`);
    }
  } else {
    lines.push('文字起こしがオフだったため、発言量・項目カバーに基づくコメントは省略しています（時間ベースの所見のみ表示）。');
  }

  // --- 締めの注記(役割別) ---
  const note = isInterviewer
    ? '※これは進行の目安です。合否・評価はご自身の観察を優先してください。'
    : '※上記は振り返りのヒントです。良し悪しの判定ではありません。お疲れさまでした。';

  return { heading, note, lines };
}
