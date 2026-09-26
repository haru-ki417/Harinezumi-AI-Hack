'use client';

import Link from 'next/link';
import { HiringVitalSummary } from '@/components/HiringVitalSummary';
import { InterviewFeedback } from '@/components/InterviewFeedback';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useEffect, useRef, useState } from 'react';
import { EmployerInterviewAccess, useEmployerInterview } from '@/components/EmployerInterviewAccess';
import { Decision, dateLabel, decisionLabel, modeLabel, statusLabel } from '@/lib/hiring';
import styles from '@/components/Hiring.module.css';
import detail from '@/components/CompanyDetails.module.css';

function InterviewReport({ id }: { id: string }) {
  const { session, loaded, busy, error, notice, setNotice, authRequired, action } = useEmployerInterview(id);
  const [decision, setDecision] = useState<Decision>('pending');
  const [notes, setNotes] = useState('');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [operation, setOperation] = useState('');
  useEffect(() => {
    if (!session || dirtyRef.current) return;
    setDecision(session.review.decision); setNotes(session.review.notes);
  }, [session]);
  useEffect(() => {
    if (!session?.feedback_processing) return;
    const timer = window.setInterval(() => { void action(); }, 5000);
    return () => window.clearInterval(timer);
  }, [session?.feedback_processing, action]);
  function markDirty() { dirtyRef.current = true; setDirty(true); setNotice(''); }
  async function saveReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session?.invitation.status !== 'completed') return;
    const result = await action('review', { decision, notes });
    if (result) {
      dirtyRef.current = false; setDirty(false); setDecision(result.review.decision); setNotes(result.review.notes); setNotice('担当者の判断を保存しました。');
    }
  }
  async function generateReport() {
    setOperation('report');
    const result = await action('report');
    if (result) setNotice('面接集計と回答の振り返りを更新しました。');
    setOperation('');
  }
  return <main className={styles.shell}><div className={styles.container}>
    <header className={styles.header}><Link href="/" className={styles.brand}>VITAL ROOM / 採用面接</Link><Link href="/company" className={styles.button}>面接設定に戻る</Link></header>
    <p className={styles.eyebrow}>INTERVIEW REPORT</p><h1 className={styles.title}>{session ? `${session.invitation.candidate_name} さんの面接集計` : '面接集計・担当者の判断'}</h1>
    {error && <div className={styles.error} role="alert">{error}</div>}{notice && <div className={styles.notice} role="status">{notice}</div>}
    <EmployerInterviewAccess loaded={loaded} authRequired={authRequired} returnTo={`/company/report?id=${encodeURIComponent(id)}`} />
    {session && <section className={styles.card} aria-label="面接記録と判断">
      <div className={styles.header}><div><h2>{session.template.title}</h2><p className={styles.muted}>{session.template.job_title} · {modeLabel(session.template.mode)} · {statusLabel(session.invitation)}</p></div><Link className={styles.button} href={`/company/invitation?id=${encodeURIComponent(id)}`}>招待を確認</Link></div>
      <p className={styles.subtitle}>回答の根拠と会話を確認し、担当者が選考判断を記録します。</p>
      <div className={styles.row}><button className={styles.button} disabled={busy} onClick={() => void action()}>記録を更新</button>{session.invitation.status === 'completed' && <button className={styles.primary} disabled={busy} onClick={() => void generateReport()}>{operation === 'report' ? '集計を作成中…' : session.report ? '集計を再作成' : '根拠付き集計を作成'}</button>}{session.invitation.status === 'in_progress' && <button className={styles.danger} disabled={busy} onClick={() => { if (window.confirm('この面接を終了しますか？')) void action('finish'); }}>面接を終了</button>}</div>
      {session.processing && <p className={styles.notice}>回答を処理しています。しばらくしてから「記録を更新」を押してください。</p>}
      <div className={detail.reportLayout}><div>
        <h3 className={detail.reportHeading}>根拠付きの面接集計</h3>
        {session.report ? <>
          <span className={styles.badge}>{session.report.source === 'ai' ? 'AIによる整理' : '回答の定型整理（AI未使用）'}</span><p className={styles.report}>{session.report.summary}</p>
          {session.report.items.map((item, index) => <article className={`${styles.item} ${detail.evidenceItem}`} key={index}><h3>{item.criterion}</h3><p className={styles.report}>{item.summary}</p>{item.evidence.map((e, n) => <a className={styles.evidence} key={n} href={`#turn-${e.turn_id}`}>「{e.quote}」<br /><small>根拠の発言を確認 ↗</small></a>)}{item.follow_up && <p className={styles.report}><strong>次に確認したい点</strong><br />{item.follow_up}</p>}</article>)}
          <p className={styles.muted}>作成：{dateLabel(session.report.generated_at)}。発言の根拠を確認したうえで担当者が判断してください。</p>
        </> : <p className={styles.empty}>{session.invitation.status === 'completed' ? '集計がまだありません。「根拠付き集計を作成」から作成できます。' : ['revoked', 'expired'].includes(session.invitation.status) ? 'この面接は終了・取消となっています。保存された会話と担当者の判断を確認できます。' : '面接終了後に集計を作成できます。「記録を更新」で最新の実施状況を確認できます。'}</p>}
        <div className={detail.review}><h3>担当者の判断</h3><form className={styles.form} onSubmit={saveReview}><label className={styles.field}>選考判断<select className={styles.select} value={decision} disabled={busy} onChange={e => { setDecision(e.target.value as Decision); markDirty(); }}>{Object.entries(decisionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.field}>担当者メモ<textarea className={styles.textarea} value={notes} disabled={busy} maxLength={10000} onChange={e => { setNotes(e.target.value); markDirty(); }} /></label><button className={styles.primary} disabled={busy || session.invitation.status !== 'completed'}>判断を保存</button>{session.invitation.status !== 'completed' && <p className={styles.muted}>判断・メモは面接が実施済みになってから保存できます。</p>}{dirty && <p className={styles.muted}>判断・メモに未保存の変更があります。</p>}<p className={styles.muted}>判断・メモ・集計は企業側のみ閲覧できます。応募者には通知されません。</p></form></div>
      </div><div><h3 className={detail.reportHeading}>保存された会話</h3><div className={styles.transcript}>{session.transcript.map(t => <article id={`turn-${t.id}`} key={t.id} tabIndex={-1} className={`${styles.turn} ${t.role === 'candidate' ? styles.candidate : ''}`}><span className={styles.muted}>{t.role === 'candidate' ? '応募者' : t.role === 'ai' ? 'AI面接官' : '面接官'} · {dateLabel(t.created_at)}</span><p>{t.text}</p></article>)}{!session.transcript.length && <p className={styles.empty}>会話はまだありません。</p>}</div></div></div>
    </section>}
    {session?.invitation.status === 'completed' && <InterviewFeedback feedback={session.feedback} audience="employer" processing={session.feedback_processing} busy={operation === 'report'} />}
    {session && <HiringVitalSummary session={session} />}
  </div></main>;
}

function ReportRoute() { const query = useSearchParams(); const id = query.get('id') || ''; return <InterviewReport key={id} id={id} />; }
export default function CompanyReportPage() { return <Suspense fallback={<main className={styles.shell}><p className={styles.empty}>読み込み中…</p></main>}><ReportRoute /></Suspense>; }
