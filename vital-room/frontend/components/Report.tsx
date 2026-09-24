'use client';

import { useMemo } from 'react';
import styles from './Report.module.css';
import type { Participant, Sample } from '@/types';

const ROLE_LABEL: Record<string, string> = { interviewer: '面接官', candidate: '就活生' };
const SHARED_THRESHOLD = 45; // 双方がこの平均ストレス以上なら「構えやすい論点」

interface TopicAgg { topic: string; avg: number; peak: number; count: number }

function aggregateByTopic(samples: Sample[]): TopicAgg[] {
  const valid = samples.filter((s) => s.bpm > 0);
  const src = valid.length > 0 ? valid : samples;
  const map = new Map<string, { sum: number; peak: number; count: number }>();
  for (const s of src) {
    const key = s.topic || '全体';
    const cur = map.get(key) ?? { sum: 0, peak: 0, count: 0 };
    cur.sum += s.stress;
    cur.peak = Math.max(cur.peak, s.stress);
    cur.count += 1;
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([topic, v]) => ({ topic, avg: v.sum / Math.max(1, v.count), peak: v.peak, count: v.count }))
    .sort((a, b) => b.avg - a.avg);
}

interface Props {
  participants: Participant[];
  history: Record<string, Sample[]>;
  onClose: () => void;
}

export function Report({ participants, history, onClose }: Props) {
  const perParticipant = useMemo(
    () =>
      participants.map((p) => ({
        p,
        byTopic: aggregateByTopic(history[p.client_id] ?? []),
      })),
    [participants, history],
  );

  // 双方が構えた論点(全員が閾値以上の平均ストレス)
  const shared = useMemo(() => {
    if (perParticipant.length < 2) return [];
    const topicSets = perParticipant.map(
      (pp) => new Map(pp.byTopic.map((t) => [t.topic, t.avg])),
    );
    const common: { topic: string; avgs: number[]; combined: number }[] = [];
    for (const topic of topicSets[0].keys()) {
      const avgs = topicSets.map((m) => m.get(topic));
      if (avgs.every((a) => a !== undefined && a >= SHARED_THRESHOLD)) {
        const nums = avgs as number[];
        common.push({ topic, avgs: nums, combined: nums.reduce((x, y) => x + y, 0) });
      }
    }
    return common.sort((a, b) => b.combined - a.combined);
  }, [perParticipant]);

  const barColor = (v: number) => `hsl(${120 - (Math.min(100, v) / 100) * 120} 60% 45%)`;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.head}>
          <h2 className={styles.title}>セッションレポート</h2>
          <button type="button" className={styles.close} onClick={onClose}>閉じる</button>
        </div>

        <p className={styles.note}>
          これは<b>判定ではなく対話のきっかけ</b>です。緊張の高さは嘘や善悪を意味しません
          （緊張・体調・照明などでも動きます）。相互理解のヒントとしてお使いください。非医療。
        </p>

        {/* 率直に話すと良い論点 */}
        <section className={styles.section}>
          <h3 className={styles.h3}>率直に話すと相互理解が深まる論点</h3>
          {shared.length === 0 ? (
            <p className={styles.empty}>
              双方がそろって構えた論点は目立ちませんでした。落ち着いて話せていたようです。
            </p>
          ) : (
            <ul className={styles.sharedList}>
              {shared.map((s) => (
                <li key={s.topic} className={styles.sharedItem}>
                  <div className={styles.sharedTopic}>{s.topic}</div>
                  <div className={styles.sharedBody}>
                    「{s.topic}」は双方ともやや緊張が高めでした。お互い構えやすい話題かもしれません。
                    背景や率直な考えを一言そえ合うと、認識のズレが減ります。
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 参加者ごとの論点別緊張 */}
        <section className={styles.section}>
          <h3 className={styles.h3}>論点別の緊張(参加者ごと)</h3>
          <div className={styles.grid}>
            {perParticipant.map(({ p, byTopic }) => (
              <div key={p.client_id} className={styles.pcard}>
                <div className={styles.phead}>
                  <span className={styles.badge}>{ROLE_LABEL[p.role] ?? p.role}</span>
                  <span className={styles.pname}>{p.name}</span>
                </div>
                {byTopic.length === 0 ? (
                  <p className={styles.empty}>データがありません。</p>
                ) : (
                  byTopic.map((t) => (
                    <div key={t.topic} className={styles.row}>
                      <div className={styles.rowTop}>
                        <span className={styles.rowTopic}>{t.topic}</span>
                        <span className={styles.rowVal}>{Math.round(t.avg)}</span>
                      </div>
                      <div className={styles.track}>
                        <div className={styles.fill}
                          style={{ width: `${Math.min(100, t.avg)}%`, background: barColor(t.avg) }} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
