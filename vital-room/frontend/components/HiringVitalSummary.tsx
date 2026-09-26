import type { InterviewSession } from '@/lib/hiring';
import styles from './Hiring.module.css';

type Stats = { mean: number; min: number; max: number; count: number } | null;
export type VitalSummary = { participants: {
  role: string; name: string; sample_seconds: number; first_second: number; last_second: number;
  bpm: Stats; stress: Stats; trend: { second: number; bpm: number | null; stress: number | null }[];
}[] };

const elapsed = (second: number) => `${Math.floor(second / 60)}:${String(second % 60).padStart(2, '0')}`;
function cells(value: Stats) {
  return <><td>{value?.mean ?? '—'}</td><td>{value?.min ?? '—'}</td><td>{value?.max ?? '—'}</td><td>{value?.count ?? 0}秒</td></>;
}
export function HiringVitalSummary({ session }: { session: InterviewSession }) {
  if (session.invitation.status !== 'completed' || session.template.mode !== 'human') return null;
  const participants = session.vital_summary?.participants || [];
  return <section className={styles.card} aria-label="心拍・ストレスの振り返り">
    <h2>心拍・ストレスの振り返り</h2>
    <p className={styles.muted}>カメラからの推定値です。ストレスは本人の計測中の基準値に対する変化の目安で、心理状態・能力・採用適性を示すものではありません。根拠付きの面接集計には使用しません。</p>
    {!participants.length && <p>保存された計測値はありません。同意がない場合や、顔・光・通信の状態から十分な計測ができなかった場合は数値を表示しません。</p>}
    {participants.map(participant => <article key={participant.role} className={styles.item}>
      <h3>{participant.name}（{participant.role === 'candidate' ? '応募者' : '面接官'}）</h3>
      <p className={styles.muted}>有効な心拍データ：{participant.sample_seconds}秒分。面接開始から {elapsed(participant.first_second)}〜{elapsed(participant.last_second)} の間に取得。</p>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left', borderSpacing: '8px 12px' }}><caption>有効な計測値のまとめ</caption><thead><tr><th>項目</th><th>平均</th><th>最小</th><th>最大</th><th>計測時間</th></tr></thead><tbody><tr><th>心拍数（bpm）</th>{cells(participant.bpm)}</tr><tr><th>ストレス（0〜100）</th>{cells(participant.stress)}</tr></tbody></table></div>
      {!participant.stress && <p className={styles.muted}>ストレスの推定に必要な安定した脈波・基準値が不足したため、ストレス値は表示していません。</p>}
      <details><summary>時間ごとの推移を見る</summary><table style={{ width: '100%', textAlign: 'left', borderSpacing: '8px 12px' }}><caption>30秒区間ごとの有効値の平均。「—」は未計測です。</caption><thead><tr><th>開始から</th><th>心拍（bpm）</th><th>ストレス</th></tr></thead><tbody>{participant.trend.map(point => <tr key={point.second}><td>{elapsed(point.second)}</td><td>{point.bpm ?? '—'}</td><td>{point.stress ?? '—'}</td></tr>)}</tbody></table></details>
    </article>)}
  </section>;
}
