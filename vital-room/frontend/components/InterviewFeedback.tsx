'use client';

import type { FeedbackEvidence, FeedbackPoint, InterviewFeedback as Feedback } from '@/lib/hiring';
import { dateLabel } from '@/lib/hiring';
import styles from './Hiring.module.css';
import feedbackStyles from './InterviewFeedback.module.css';

function Evidence({ items }: { items: FeedbackEvidence[] }) {
  if (!items.length) return null;
  return <div className={feedbackStyles.evidence} aria-label="振り返りの根拠">
    {items.map((item, index) => <a key={`${item.turn_id}-${index}`} className={styles.evidence} href={`#turn-${item.turn_id}`}>
      <q>{item.quote}</q><small>この発言を会話で確認する →</small>
    </a>)}
  </div>;
}

function Points({ title, items, improvement }: { title: string; items: FeedbackPoint[]; improvement?: boolean }) {
  return <section className={feedbackStyles.points} aria-label={title}>
    <h3><span className={improvement ? feedbackStyles.improvementLabel : feedbackStyles.strengthLabel}>{improvement ? 'NEXT' : 'GOOD'}</span>{title}</h3>
    {items.length ? items.map((point, index) => <article key={index} className={feedbackStyles.point}>
      <h4>{point.title}</h4><p>{point.observation}</p><Evidence items={point.evidence} />
      {point.suggestion && <p className={feedbackStyles.suggestion}><strong>{improvement ? '次の回答で試すこと' : 'さらに伝わる工夫'}</strong>{point.suggestion}</p>}
    </article>) : <p className={styles.muted}>保存された回答から確認できる情報がまだ十分にありません。</p>}
  </section>;
}

export function InterviewFeedback({ feedback, audience = 'candidate', processing = false, busy = false, onRefresh }: {
  feedback?: Feedback | null;
  audience?: 'candidate' | 'employer';
  processing?: boolean;
  busy?: boolean;
  onRefresh?: () => void;
}) {
  const employer = audience === 'employer';
  const title = employer ? '回答の振り返り' : '面接のフィードバック';
  return <section className={`${styles.card} ${feedbackStyles.panel}`} aria-label={title} aria-busy={processing || busy}>
    <div className={feedbackStyles.header}><div><p className={styles.eyebrow}>INTERVIEW FEEDBACK</p><h2>{title}</h2></div>
      {onRefresh && <button className={styles.button} disabled={busy || processing} onClick={onRefresh}>{busy ? 'フィードバックを作成中…' : feedback ? 'フィードバックを更新' : 'フィードバックを作成'}</button>}
    </div>
    <p className={styles.subtitle}>{employer ? '応募者にも共有する振り返りです。回答の具体性や伝え方を、実際の発言に沿って確認できます。' : '今回の回答を振り返り、良かった点と次の面接で試せる工夫をまとめました。引用から、元の発言も確認できます。'}</p>
    {processing && <p className={styles.notice} role="status">保存された回答を確認して、フィードバックを作成しています。完了すると自動で表示します。</p>}
    {!feedback ? <p className={styles.empty}>{processing ? '面接の記録は保存されています。この画面でそのままお待ちください。' : 'フィードバックはまだ作成されていません。保存された会話から振り返りを作成できます。'}</p> : <>
      <div className={styles.row}><span className={styles.badge}>{feedback.source === 'ai' ? 'AIによる回答の振り返り' : '回答内容の整理（AI未使用）'}</span><span className={styles.muted}>更新：{dateLabel(feedback.generated_at)}</span></div>
      <p className={feedbackStyles.summary}>{feedback.summary}</p>
      <div className={feedbackStyles.columns}><Points title="回答から伝わった良い点" items={feedback.strengths} /><Points title="次に改善できる点" items={feedback.improvements} improvement /></div>
      {feedback.question_reviews.length > 0 && <section className={feedbackStyles.questions} aria-label="質問ごとの振り返り"><h3>質問ごとの振り返り</h3><p className={styles.muted}>質問を開くと、回答の要点と組み立て方を確認できます。</p>
        {feedback.question_reviews.map((review, index) => <details key={`${review.question_index}-${index}`} className={feedbackStyles.question}>
          <summary><span>質問 {index + 1}</span>{review.question}</summary><div className={feedbackStyles.questionContent}>
            <h4>回答の要点</h4><p>{review.summary}</p><Evidence items={review.evidence} />
            {review.strengths.length > 0 && <><h4>伝わったこと</h4><ul>{review.strengths.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
            {review.improvements.length > 0 && <><h4>具体的にすると伝わりやすいこと</h4><ul>{review.improvements.map((item, i) => <li key={i}>{item}</li>)}</ul></>}
            {review.answer_outline.length > 0 && <div className={feedbackStyles.outline}><h4>次に話すときの組み立て方</h4><ol>{review.answer_outline.map((item, i) => <li key={i}>{item}</li>)}</ol><p className={styles.muted}>ご自身の経験や考えに置き換えて練習してください。</p></div>}
          </div>
        </details>)}
      </section>}
      {feedback.practice_plan.length > 0 && <section className={feedbackStyles.practice} aria-label="次の面接に向けた練習"><h3>次の面接に向けた練習</h3><ol>{feedback.practice_plan.map((item, index) => <li key={index}><span aria-hidden="true">{index + 1}</span><p>{item}</p></li>)}</ol></section>}
      <p className={styles.muted}>保存された発言に基づく回答の振り返りです。選考結果は企業の担当者が判断します。</p>
    </>}
  </section>;
}
