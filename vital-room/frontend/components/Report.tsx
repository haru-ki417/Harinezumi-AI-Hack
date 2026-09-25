'use client';

import { useMemo } from 'react';
import styles from './Report.module.css';
import { BarChart, type Bar } from './BarChart';
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

interface QSeg { label: string; topic: string; avg: number; peak: number; count: number }

/** 話題の連続した区間を1つの質問(Q1,Q2…)として時間順に集計。 */
function segmentByQuestion(samples: Sample[]): QSeg[] {
  const valid = samples.filter((s) => s.bpm > 0);
  const src = valid.length > 0 ? valid : samples;
  const runs: { topic: string; sum: number; peak: number; count: number }[] = [];
  let cur: { topic: string; sum: number; peak: number; count: number } | null = null;
  for (const s of src) {
    const topic = s.topic || '全体';
    if (!cur || cur.topic !== topic) {
      cur = { topic, sum: 0, peak: 0, count: 0 };
      runs.push(cur);
    }
    cur.sum += s.stress;
    cur.peak = Math.max(cur.peak, s.stress);
    cur.count += 1;
  }
  return runs
    .filter((r) => r.count >= 2) // 一瞬だけの区間は除外
    .map((r, i) => ({
      label: `Q${i + 1}`, topic: r.topic,
      avg: r.sum / r.count, peak: r.peak, count: r.count,
    }));
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** その人の平常値(中央値)+余裕を基準値に。過度に赤くならないよう50〜75に収める。 */
function thresholdFor(samples: Sample[]): number {
  const vals = samples.filter((s) => s.bpm > 0).map((s) => s.stress);
  const base = median(vals);
  return Math.min(75, Math.max(50, Math.round(base + 15)));
}

interface Props {
  participants: Participant[];
  history: Record<string, Sample[]>;
  onClose: () => void;
}

export function Report({ participants, history, onClose }: Props) {
  const perParticipant = useMemo(
    () =>
      participants.map((p) => {
        const samples = history[p.client_id] ?? [];
        const segs = segmentByQuestion(samples);
        const threshold = thresholdFor(samples);
        return {
          p,
          byTopic: aggregateByTopic(samples),
          segs,
          threshold,
          exceeded: segs.filter((s) => s.peak >= threshold),
        };
      }),
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

        {/* 質問別ストレス分析(面接終了サマリー) */}
        <section className={styles.section}>
          <h3 className={styles.h3}>質問別ストレス分析</h3>
          <p className={styles.subNote}>
            横軸=質問(Q1,Q2…)／縦軸=ストレス(0〜100)。棒=ピーク、白線=平均、
            破線=基準値(その人の平常値+余裕)。基準を超えた質問は<b>赤</b>で表示します。
          </p>
          <div className={styles.chartCol}>
            {perParticipant.map(({ p, segs, threshold, exceeded }) => (
              <div key={p.client_id} className={styles.pcard}>
                <div className={styles.phead}>
                  <span className={styles.badge}>{ROLE_LABEL[p.role] ?? p.role}</span>
                  <span className={styles.pname}>{p.name}</span>
                </div>
                {segs.length === 0 ? (
                  <p className={styles.empty}>十分なデータがありませんでした。</p>
                ) : (
                  <>
                    <BarChart
                      bars={segs.map((s): Bar => ({
                        label: s.label, sub: s.topic, peak: s.peak, avg: s.avg,
                      }))}
                      threshold={threshold}
                    />
                    <div className={styles.exceed}>
                      {exceeded.length === 0 ? (
                        <span className={styles.exceedOk}>基準値を超えた質問はありませんでした。落ち着いて話せていたようです。</span>
                      ) : (
                        <>
                          <span className={styles.exceedLabel}>基準値を超えた質問:</span>
                          {exceeded.map((s) => (
                            <span key={s.label} className={styles.exceedChip}>
                              {s.label} {s.topic}（ピーク{Math.round(s.peak)}）
                            </span>
                          ))}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
