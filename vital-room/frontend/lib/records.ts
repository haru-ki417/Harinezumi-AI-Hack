// 面接記録の保存クライアント。
// 1面接分の記録(サマリー＋文字起こし＋事前質問＋フィードバック)を
//   ・サーバへ保存(records/ に JSON を1面接1ファイル。room/時刻/sessionId で識別)
//   ・手元へダウンロード(JSON=全データ / CSV=質問別の指標)
// する。CSVは Excel でそのまま開けるよう BOM 付き・数値は丸めて出力する。
import { formatReportElapsed, type ReportSummary, type MetricStats } from './reportAnalysis';
import type { TranscriptSegment } from '@/types';
import type { PreFormData } from './preForm';
import type { FeedbackData } from './feedback';

const API_BASE = 'http://localhost:8000';
const ROLE_LABEL: Record<string, string> = { interviewer: '面接官', candidate: '就活生' };

export interface InterviewRecord {
  sessionId: string;
  roomId: string;
  savedAt: string;          // ISO文字列(クライアント時刻)
  recordedByRole: string;   // 保存操作をした人の役割
  summary: ReportSummary;   // 心拍・ストレスの質問別集計(基準超過を含む)
  transcript: TranscriptSegment[];
  form: PreFormData;        // 事前質問(ES深掘り)と回答
  feedback: FeedbackData;   // 面接官の評価(共有可否を含む)
}

/** ページの状態から1面接分の記録を組み立てる。 */
export function buildRecord(input: {
  roomId: string;
  role: string;
  summary: ReportSummary;
  transcript: TranscriptSegment[];
  form: PreFormData;
  feedback: FeedbackData;
}): InterviewRecord {
  return {
    sessionId: input.summary.sessionId,
    roomId: input.roomId,
    savedAt: new Date().toISOString(),
    recordedByRole: input.role,
    summary: input.summary,
    transcript: input.transcript ?? [],
    form: input.form ?? { enabled: false, questions: [], answers: [] },
    feedback: input.feedback,
  };
}

/** サーバの records/ に JSON で保存。戻り値は保存されたファイル名など。 */
export async function saveRecordToServer(
  roomId: string, record: InterviewRecord,
): Promise<{ ok: boolean; file?: string }> {
  try {
    const r = await fetch(`${API_BASE}/api/records/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, file: j.file };
  } catch {
    return { ok: false };
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function stamp(record: InterviewRecord): string {
  // ファイル名用の識別子(ルーム＋保存日時)。
  const d = new Date(record.savedAt);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const ds = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safe = record.roomId.replace(/[^0-9A-Za-z_-]+/g, '-').slice(0, 24) || 'room';
  return `${safe}_${ds}`;
}

/** 全データを JSON でダウンロード。 */
export function downloadRecordJSON(record: InterviewRecord) {
  const blob = new Blob([JSON.stringify(record, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  triggerDownload(blob, `interview-${stamp(record)}.json`);
}

function num(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return '';
  return (Math.round(v * 10 ** digits) / 10 ** digits).toString();
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 質問別の指標を CSV でダウンロード(参加者×質問で1行)。 */
export function downloadRecordCSV(record: InterviewRecord) {
  const { summary } = record;
  const start = summary.startedAt;
  const header = [
    'セッションID', 'ルーム', '参加者', '役割', '質問', '話題', '回答時間(秒)',
    '心拍_平均', '心拍_最大', '心拍_基準', '心拍_基準超過数', '心拍_初回超過(経過)',
    'ストレス_平均', 'ストレス_最大', 'ストレス_基準', 'ストレス_基準超過数', 'ストレス_初回超過(経過)',
    '有効サンプル数',
  ];
  const rows: string[] = [header.map(csvCell).join(',')];
  const qById = new Map(summary.questions.map((q) => [q.id, q]));

  for (const p of summary.participants) {
    for (const qr of p.questions) {
      const q = qById.get(qr.questionId);
      if (!q) continue;
      const answerSec = Math.max(0, Math.round((q.endedAt - q.startedAt) / 1000));
      const st: MetricStats = qr.stress;
      const bp: MetricStats = qr.bpm;
      rows.push([
        summary.sessionId,
        record.roomId,
        p.name,
        ROLE_LABEL[p.role] ?? p.role,
        q.label,
        q.topic,
        answerSec,
        num(bp.avg), num(bp.peak), summary.thresholds.bpm, bp.exceededCount,
        formatReportElapsed(bp.firstExceededAt, start),
        num(st.avg), num(st.peak), summary.thresholds.stress, st.exceededCount,
        formatReportElapsed(st.firstExceededAt, start),
        st.count,
      ].map(csvCell).join(','));
    }
  }
  // Excel(日本語)向けに BOM を付ける。
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, `interview-metrics-${stamp(record)}.csv`);
}
