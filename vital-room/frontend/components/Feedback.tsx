'use client';

import { useEffect, useMemo, useState } from 'react';
import styles from './Feedback.module.css';
import { fetchFeedback, saveFeedback, type FeedbackData } from '@/lib/feedback';
import type { ReportSummary } from '@/lib/reportAnalysis';

/** バイタル集計から非断定のコーチング(振り返りのヒント)を作る。 */
function buildCoaching(summary: ReportSummary): { highlights: string[]; tips: string[] } {
  const cand = summary.participants.find((p) => p.role === 'candidate') ?? summary.participants[0];
  const highlights: string[] = [];
  if (cand) {
    for (const q of cand.questions) {
      if (q.stress.exceededCount > 0 || q.bpm.exceededCount > 0) {
        const info = summary.questions.find((sq) => sq.id === q.questionId);
        if (info) {
          highlights.push(
            `「${info.label} ${info.topic || ''}」では緊張が高めに出ていました。結論→具体例の順で、一呼吸おいて話すと落ち着いて伝わります。`,
          );
        }
      }
    }
  }
  const tips = highlights.length === 0
    ? ['全体的に落ち着いて話せていました。結論から簡潔に伝える練習を続けると、さらに説得力が増します。']
    : [
      '緊張は自然なこと。話し始める前に一呼吸おくと落ち着きます。',
      '質問には「結論 → 理由 → 具体例」の順で答えると、緊張していても伝わりやすくなります。',
    ];
  return { highlights, tips };
}

const ROLE_LABEL: Record<string, string> = { interviewer: '面接官', candidate: '就活生' };

export function Feedback({
  role, roomId, summary, onClose,
}: {
  role: 'interviewer' | 'candidate';
  roomId: string;
  summary: ReportSummary;
  onClose: () => void;
}) {
  const [data, setData] = useState<FeedbackData | null>(null);
  const [rating, setRating] = useState(0);
  const [strengths, setStrengths] = useState('');
  const [improvements, setImprovements] = useState('');
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchFeedback(roomId).then((f) => {
      if (!alive) return;
      setData(f);
      setRating(f.rating);
      setStrengths(f.strengths);
      setImprovements(f.improvements);
      setShared(f.shared || !f.submitted);
      const map: Record<number, string> = {};
      for (const n of f.notes) map[n.questionId] = n.note;
      setNotes(map);
    });
    return () => { alive = false; };
  }, [roomId]);

  const coaching = useMemo(() => buildCoaching(summary), [summary]);

  const submit = async () => {
    setBusy(true);
    const ok = await saveFeedback(roomId, {
      rating, strengths, improvements, shared,
      notes: summary.questions
        .map((q) => ({ questionId: q.id, note: notes[q.id] ?? '' }))
        .filter((n) => n.note.trim()),
    });
    setBusy(false);
    if (ok) { setSaved(true); setData((d) => ({ ...(d ?? {} as FeedbackData), rating, strengths, improvements, notes: [], shared, submitted: true })); }
  };

  const Stars = ({ value, onPick }: { value: number; onPick?: (v: number) => void }) => (
    <div className={styles.stars}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={!onPick}
          className={`${styles.star} ${n <= value ? styles.starOn : ''}`}
          onClick={() => onPick?.(n)} aria-label={`${n}点`}>★</button>
      ))}
    </div>
  );

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="面接フィードバック">
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>面接後フィードバック</p>
            <h2 className={styles.title}>フィードバック</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>閉じる</button>
        </div>
        <p className={styles.note}>
          評価は面接官の所見です。バイタル（緊張の目安）は能力評価ではなく、振り返りのヒントとして使います。
        </p>

        {role === 'interviewer' ? (
          <section className={styles.section}>
            <h3 className={styles.h3}>評価を入力（候補者へのフィードバック）</h3>
            <label className={styles.field}>
              <span>総合評価</span>
              <Stars value={rating} onPick={setRating} />
            </label>
            <label className={styles.field}>
              <span>強み・良かった点</span>
              <textarea className={styles.textarea} rows={3} value={strengths}
                onChange={(e) => setStrengths(e.target.value)} placeholder="例: 具体例が豊富で説得力があった" />
            </label>
            <label className={styles.field}>
              <span>改善点・次への期待</span>
              <textarea className={styles.textarea} rows={3} value={improvements}
                onChange={(e) => setImprovements(e.target.value)} placeholder="例: 結論を先に述べると更に伝わりやすい" />
            </label>
            {summary.questions.length > 0 && (
              <div className={styles.field}>
                <span>質問ごとの所感（任意）</span>
                {summary.questions.map((q) => (
                  <div key={q.id} className={styles.qNote}>
                    <span className={styles.qTag}>{q.label} {q.topic}</span>
                    <textarea className={styles.textarea} rows={2} value={notes[q.id] ?? ''}
                      onChange={(e) => setNotes((m) => ({ ...m, [q.id]: e.target.value }))}
                      placeholder="この質問の所感…" />
                  </div>
                ))}
              </div>
            )}
            <label className={styles.check}>
              <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
              <span>この評価を候補者に共有する</span>
            </label>
            <button type="button" className={styles.primaryBtn} onClick={submit} disabled={busy}>
              {busy ? '保存中…' : saved ? '保存しました ✓（再保存）' : '評価を保存して共有'}
            </button>
          </section>
        ) : (
          <section className={styles.section}>
            <h3 className={styles.h3}>面接官からのフィードバック</h3>
            {data && data.submitted && data.shared ? (
              <div className={styles.fbView}>
                <div className={styles.fbRating}><Stars value={data.rating} /><span>{data.rating}/5</span></div>
                {data.strengths && <div className={styles.fbBlock}><span className={styles.fbLabel}>強み・良かった点</span><p>{data.strengths}</p></div>}
                {data.improvements && <div className={styles.fbBlock}><span className={styles.fbLabel}>改善点・次への期待</span><p>{data.improvements}</p></div>}
                {data.notes.length > 0 && (
                  <div className={styles.fbBlock}>
                    <span className={styles.fbLabel}>質問ごとの所感</span>
                    {data.notes.map((n, i) => {
                      const info = summary.questions.find((q) => q.id === n.questionId);
                      return <p key={i}><b>{info?.label ?? `Q${n.questionId}`}</b> {info?.topic}：{n.note}</p>;
                    })}
                  </div>
                )}
              </div>
            ) : (
              <p className={styles.empty}>面接官のフィードバックはまだありません（共有されると表示されます）。</p>
            )}
          </section>
        )}

        {/* コーチング(両者に表示) */}
        <section className={styles.section}>
          <h3 className={styles.h3}>振り返りのヒント（自動・非断定）</h3>
          {coaching.highlights.length > 0 && (
            <ul className={styles.tipList}>
              {coaching.highlights.map((h, i) => <li key={i} className={styles.tipHi}>{h}</li>)}
            </ul>
          )}
          <ul className={styles.tipList}>
            {coaching.tips.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
          <p className={styles.disclaimer}>
            ※ 緊張の高さは体調・照明・計測環境でも変わります。優劣の判定ではなく、話し方を整えるきっかけとしてお使いください。
          </p>
        </section>
      </div>
    </div>
  );
}
