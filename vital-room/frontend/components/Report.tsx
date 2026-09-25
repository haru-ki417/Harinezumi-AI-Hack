'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BarChart } from './BarChart';
import { formatReportElapsed, numericalReportComment, type MetricStats, type ReportSummary } from '@/lib/reportAnalysis';
import styles from './Report.module.css';

const ROLE_LABEL: Record<string, string> = { interviewer: '面接官', candidate: '就活生' };
const HTTP_BASE = (process.env.NEXT_PUBLIC_WS_BASE_URL || 'ws://localhost:8000').replace(/\/+$/, '').replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
const MAX_AI_PARTICIPANTS = 20;

interface AnalysisResponse {
  source: 'ai' | 'local';
  reason?: 'not_configured' | 'provider_error' | 'insufficient_data';
  summary: string;
  observations: { participantId: string; questionId: number; comment: string }[];
}

interface AnalysisEntry { promise: Promise<AnalysisResponse>; controller: AbortController }
// Reopening a completed report reuses its analysis. Entries remain only in this browser tab.
const analysisCache = new Map<string, AnalysisEntry>();

function parseAnalysis(value: unknown, report: ReportSummary): AnalysisResponse {
  if (!value || typeof value !== 'object') throw new Error('Invalid analysis');
  const data = value as Partial<AnalysisResponse>;
  if ((data.source !== 'ai' && data.source !== 'local') || typeof data.summary !== 'string'
    || !data.summary.trim() || data.summary.length > 12000 || !Array.isArray(data.observations)
    || data.observations.length > report.participants.length * report.questions.length) throw new Error('Invalid analysis');
  const participants = new Set(report.participants.map((participant) => participant.id));
  const questions = new Set(report.questions.map((question) => question.id));
  if (data.observations.some((observation) => !observation || !participants.has(observation.participantId)
    || !questions.has(observation.questionId) || typeof observation.comment !== 'string'
    || !observation.comment.trim() || observation.comment.length > 4000)) throw new Error('Invalid observations');
  return data as AnalysisResponse;
}

function requestAnalysis(summary: ReportSummary): Promise<AnalysisResponse> {
  const existing = analysisCache.get(summary.sessionId);
  if (existing) return existing.promise;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  const promise = fetch(`${HTTP_BASE}/api/reports/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary), signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error('Analysis unavailable');
    return parseAnalysis(await response.json(), summary);
  }).catch((error: unknown) => {
    if (analysisCache.get(summary.sessionId)?.controller === controller) analysisCache.delete(summary.sessionId);
    throw error;
  }).finally(() => clearTimeout(timeout));
  analysisCache.set(summary.sessionId, { promise, controller });
  while (analysisCache.size > 8) {
    const oldest = analysisCache.keys().next().value as string;
    analysisCache.get(oldest)?.controller.abort();
    analysisCache.delete(oldest);
  }
  return promise;
}

function valueLabel(value: number | null) {
  return value === null ? '欠測' : `${Number(value.toFixed(1))}`;
}

function MetricCells({ stats, startedAt }: { stats: MetricStats; startedAt: number }) {
  return <>
    <td>{valueLabel(stats.avg)}</td>
    <td>{valueLabel(stats.peak)}</td>
    <td>{formatReportElapsed(stats.peakAt, startedAt)}</td>
    <td className={stats.exceededCount > 0 ? styles.over : undefined}>{stats.count === 0 ? '欠測' : stats.firstExceededAt === null ? '超過なし' : `${formatReportElapsed(stats.firstExceededAt, startedAt)}（基準超過）`}</td>
    <td>{stats.count} 件</td>
  </>;
}

interface Props { summary: ReportSummary; completed?: boolean; onClose: () => void }

export function Report({ summary, completed = true, onClose }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState(summary.participants[0]?.id ?? '');
  const participant = summary.participants.find((item) => item.id === selectedId) ?? summary.participants[0];
  const exceedsAiParticipantLimit = summary.participants.length > MAX_AI_PARTICIPANTS;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { previous?.focus(); };
  }, []);

  useEffect(() => {
    let current = true;
    setAnalysis(null);
    setFailed(false);
    if (completed && !exceedsAiParticipantLimit) {
      void requestAnalysis(summary).then((result) => {
        if (current) setAnalysis(result);
      }).catch(() => { if (current) setFailed(true); });
    }
    // Completed snapshots may finish in the background and be reused on reopening.
    // Stale views never update; timeout and cache eviction cancel pending requests.
    return () => { current = false; };
  }, [summary, completed, attempt, exceedsAiParticipantLimit]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button, select, [tabindex="0"]') ?? []);
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  const retry = () => {
    analysisCache.get(summary.sessionId)?.controller.abort();
    analysisCache.delete(summary.sessionId);
    setAttempt((value) => value + 1);
  };
  const loading = completed && !exceedsAiParticipantLimit && !analysis && !failed;
  const comment = analysis?.summary ?? numericalReportComment(summary);
  const exceeded = participant?.questions.filter((question) => question.stress.exceededCount > 0 || question.bpm.exceededCount > 0) ?? [];
  const hasMeasurements = participant?.questions.some((question) => question.bpm.count > 0 || question.stress.count > 0);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div ref={modalRef} className={styles.modal} onClick={(event) => event.stopPropagation()} onKeyDown={handleKeyDown} role="dialog" aria-modal="true" aria-label="面接レポート">
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>{completed ? '面接終了・自動分析' : '面接中・途中経過'}</p>
            <h2 className={styles.title}>面接レポート</h2>
          </div>
          <button ref={closeRef} type="button" className={styles.close} aria-label="レポートを閉じる" onClick={onClose}>閉じる</button>
        </div>
        <p className={styles.meta}>記録時間 {formatReportElapsed(summary.endedAt, summary.startedAt)} · {summary.questions.length} 質問 · {summary.participants.length} 人</p>
        <p className={styles.note}>ストレス指標と心拍数の計測値を質問ごとに振り返れます。基準値は面接中の通知設定と共通です。ストレス指標は推定値で、表示する基準値は医学的な診断基準ではありません。</p>

        <section className={styles.analysis} aria-label="分析コメント">
          <div className={styles.analysisHead}>
            <h3 className={styles.h3}>{analysis?.source === 'ai' ? 'AIコメント' : '自動集計コメント'}</h3>
            <span className={styles.badge}>{analysis?.source === 'ai' ? 'AIによる分析' : '計測値の集計'}</span>
          </div>
          {loading && <p className={styles.status} role="status">AIコメントを作成しています… グラフは先に確認できます。</p>}
          {exceedsAiParticipantLimit && <p className={styles.status}>AI分析は参加者{MAX_AI_PARTICIPANTS}人まで対応しています。この面接は{summary.participants.length}人のため、全員分の自動集計結果とグラフを表示しています。</p>}
          {!completed && !exceedsAiParticipantLimit && <p className={styles.status}>面接が終了すると、AIが自動でコメントを作成します。</p>}
          {failed && <p className={styles.status} role="status">AIコメントを取得できませんでした。自動集計結果を表示しています。</p>}
          {analysis?.source === 'local' && analysis.reason === 'not_configured' && <p className={styles.status}>AIコメントは未接続のため、自動集計結果を表示しています。</p>}
          {analysis?.source === 'local' && analysis.reason === 'provider_error' && <p className={styles.status}>AIコメントを取得できなかったため、自動集計結果を表示しています。</p>}
          <p className={styles.comment}>{comment}</p>
          {completed && (failed || analysis?.reason === 'provider_error') && <button type="button" className={styles.retry} onClick={retry}>AIコメントを再取得</button>}
        </section>

        {summary.participants.length > 1 && <label className={styles.selector}>
          表示する参加者
          <select value={participant?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
            {summary.participants.map((item) => <option key={item.id} value={item.id}>{item.name}（{ROLE_LABEL[item.role] ?? item.role}）</option>)}
          </select>
        </label>}

        {!participant ? <p className={styles.empty}>参加者の記録がありません。</p> : <section className={styles.section} aria-label={`${participant.name}の計測結果`}>
          <div className={styles.phead}><span className={styles.badge}>{ROLE_LABEL[participant.role] ?? participant.role}</span><h3 className={styles.pname}>{participant.name}</h3></div>
          <div className={styles.exceed}>
            {!hasMeasurements ? <p className={styles.empty}>十分なデータがありません。欠測を 0 として扱わず表示しています。</p>
              : exceeded.length === 0 ? <p className={styles.empty}>記録された計測値に基準超過はありませんでした。</p>
                : <><span className={styles.exceedLabel}>基準値を超えた質問</span>{exceeded.map((question) => {
                  const info = summary.questions.find((item) => item.id === question.questionId);
                  return <span key={question.questionId} className={styles.exceedChip}>{info?.label ?? `Q${question.questionId}`} · {[question.stress.exceededCount > 0 ? 'ストレス' : '', question.bpm.exceededCount > 0 ? '心拍数' : ''].filter(Boolean).join('・')}</span>;
                })}</>}
          </div>
          <div className={styles.charts}>
            {(['stress', 'bpm'] as const).map((metric) => <div key={metric} className={styles.chartCard}>
              <h4 className={styles.chartTitle}>{metric === 'stress' ? 'ストレス指標' : '心拍数'}</h4>
              <p className={styles.subNote}>横軸：質問 · 縦軸：{metric === 'stress' ? '指標値（0〜100）' : 'BPM'}</p>
              <BarChart title={`${participant.name}の質問別${metric === 'stress' ? 'ストレス指標' : '心拍数'}`} unit={metric === 'stress' ? '指標値' : 'BPM'}
                threshold={summary.thresholds[metric]} yMax={metric === 'stress' ? 100 : 140}
                bars={summary.questions.map((question) => {
                  const stats = participant.questions.find((result) => result.questionId === question.id)?.[metric];
                  return { label: question.label, sub: question.topic, peak: stats?.peak ?? null, avg: stats?.avg ?? null };
                })} />
            </div>)}
          </div>

          <div className={styles.tableWrap} tabIndex={0}>
            <table className={styles.table}>
              <caption>質問ごとの数値とタイミング（時刻は面接開始からの経過時間）</caption>
              <thead><tr><th scope="col">質問 / 区間</th><th scope="col">指標</th><th scope="col">平均</th><th scope="col">最大</th><th scope="col">最大時刻</th><th scope="col">最初の基準超過</th><th scope="col">計測数</th></tr></thead>
              <tbody>{summary.questions.map((question) => {
                const result = participant.questions.find((item) => item.questionId === question.id);
                const blank: MetricStats = { count: 0, avg: null, peak: null, firstExceededAt: null, peakAt: null, exceededCount: 0 };
                return <QuestionRows key={question.id} label={question.label} topic={question.topic} interval={`${formatReportElapsed(question.startedAt, summary.startedAt)}–${formatReportElapsed(question.endedAt, summary.startedAt)}`} stress={result?.stress ?? blank} bpm={result?.bpm ?? blank} startedAt={summary.startedAt} />;
              })}</tbody>
            </table>
          </div>
          <p className={styles.subNote}>基準値：ストレス指標 &gt; {summary.thresholds.stress} ／ 心拍数 &gt; {summary.thresholds.bpm} BPM。基準値と同じ値は超過に含みません。欠測は比較できません。</p>
          {participant.excludedSamples > 0 && <p className={styles.subNote}>計測不足・品質不足などにより、{participant.excludedSamples} 件を全部または一部の集計から除外しました。</p>}
          {analysis && analysis.observations.some((observation) => observation.participantId === participant.id) && <div className={styles.observations}>
            <h4 className={styles.chartTitle}>質問別コメント</h4>
            <ul>{analysis.observations.filter((observation) => observation.participantId === participant.id).map((observation, index) => <li key={`${observation.questionId}-${index}`}>
              <span className={styles.questionTag}>{summary.questions.find((question) => question.id === observation.questionId)?.label}</span>{observation.comment}
            </li>)}</ul>
          </div>}
        </section>}
      </div>
    </div>
  );
}

function QuestionRows({ label, topic, interval, stress, bpm, startedAt }: { label: string; topic: string; interval: string; stress: MetricStats; bpm: MetricStats; startedAt: number }) {
  return <>
    <tr><th scope="rowgroup" rowSpan={2}><span className={styles.questionTag}>{label}</span><span className={styles.topic}>{topic || '未設定'}</span><small>{interval}</small></th><th scope="row">ストレス指標</th><MetricCells stats={stress} startedAt={startedAt} /></tr>
    <tr><th scope="row">心拍数（BPM）</th><MetricCells stats={bpm} startedAt={startedAt} /></tr>
  </>;
}
