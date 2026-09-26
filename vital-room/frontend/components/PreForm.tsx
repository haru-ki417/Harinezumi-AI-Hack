'use client';

import { useState } from 'react';
import styles from './PreForm.module.css';
import { saveQuestions, submitAnswers, type AnswerSet } from '@/lib/preForm';

/* ===== 事前質問フォーム画面(面接官=編集 / 候補者=回答) ===== */
export function PreFormStage({
  mode, roomId, name, questions, onBack, onDone,
}: {
  mode: 'edit' | 'answer';
  roomId: string;
  name: string;
  questions: string[];
  onBack: () => void;
  onDone: () => void;
}) {
  // 編集: 質問リスト。回答: 質問ごとの回答。
  const [qs, setQs] = useState<string[]>(
    mode === 'edit' ? (questions.length ? [...questions] : ['', '', '']) : questions,
  );
  const [answers, setAnswers] = useState<string[]>(
    questions.map(() => ''),
  );
  const [busy, setBusy] = useState(false);

  const updateQ = (i: number, v: string) => setQs((a) => a.map((x, j) => (j === i ? v : x)));
  const addQ = () => setQs((a) => (a.length < 20 ? [...a, ''] : a));
  const removeQ = (i: number) => setQs((a) => a.filter((_, j) => j !== i));
  const updateA = (i: number, v: string) => setAnswers((a) => a.map((x, j) => (j === i ? v : x)));

  const submit = async () => {
    setBusy(true);
    if (mode === 'edit') {
      const clean = qs.map((q) => q.trim()).filter(Boolean);
      await saveQuestions(roomId, clean);
    } else {
      await submitAnswers(roomId, name || '候補者', answers);
    }
    setBusy(false);
    onDone();
  };

  const canSubmit = mode === 'edit'
    ? qs.some((q) => q.trim().length > 0)
    : true;

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <p className={styles.step}>ステップ 2 / 3 · 事前質問{mode === 'edit' ? 'の作成' : 'への回答'}</p>
        <h1 className={styles.title}>
          {mode === 'edit' ? '事前質問フォームを作成' : '事前質問に回答'}
        </h1>
        <p className={styles.lead}>
          {mode === 'edit'
            ? 'エントリーシートを踏まえて、面接で深掘りしたい質問を用意します。ここで設定した質問は、面接中の話題チップとして使われます。'
            : '面接官からの事前質問です。落ち着いて回答してください。面接ではこの内容を踏まえて対話します。'}
        </p>

        {mode === 'edit' ? (
          <div className={styles.list}>
            {qs.map((q, i) => (
              <div key={i} className={styles.qRow}>
                <span className={styles.qNum}>Q{i + 1}</span>
                <input className={styles.input} value={q}
                  onChange={(e) => updateQ(i, e.target.value)}
                  placeholder="例: ガクチカで最も苦労した点と、その乗り越え方は？" />
                <button type="button" className={styles.removeBtn}
                  onClick={() => removeQ(i)} aria-label="この質問を削除">×</button>
              </div>
            ))}
            <button type="button" className={styles.addBtn} onClick={addQ}>＋ 質問を追加</button>
          </div>
        ) : (
          <div className={styles.list}>
            {questions.length === 0 ? (
              <p className={styles.empty}>事前質問は設定されていません。そのまま進めます。</p>
            ) : questions.map((q, i) => (
              <div key={i} className={styles.aBlock}>
                <div className={styles.aQ}><span className={styles.qNum}>Q{i + 1}</span>{q}</div>
                <textarea className={styles.textarea} value={answers[i] ?? ''}
                  onChange={(e) => updateA(i, e.target.value)} rows={3}
                  placeholder="回答を入力…" />
              </div>
            ))}
          </div>
        )}

        <div className={styles.actions}>
          <button type="button" className={styles.ghostBtn} onClick={onBack}>戻る</button>
          <button type="button" className={styles.primaryBtn} onClick={submit} disabled={!canSubmit || busy}>
            {busy ? '送信中…' : mode === 'edit' ? '質問を保存して次へ' : '回答を送信して次へ'}
          </button>
        </div>
        {mode === 'answer' && (
          <button type="button" className={styles.skipBtn} onClick={onDone}>回答せずに進む</button>
        )}
      </div>
    </div>
  );
}

/* ===== 面接中に表示する「事前質問と回答」パネル ===== */
export function AnswersPanel({ questions, answers }: { questions: string[]; answers: AnswerSet[] }) {
  const [open, setOpen] = useState(true);
  if (questions.length === 0) return null;
  return (
    <section className={styles.panel}>
      <button type="button" className={styles.panelHead} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>事前質問と回答（{answers.length}件）</span>
        <span className={styles.caret}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className={styles.panelBody}>
          {questions.map((q, i) => (
            <div key={i} className={styles.paRow}>
              <div className={styles.paQ}><span className={styles.qNum}>Q{i + 1}</span>{q}</div>
              {answers.length === 0 ? (
                <div className={styles.paWait}>回答待ち…</div>
              ) : answers.map((a, j) => (
                <div key={j} className={styles.paA}>
                  <span className={styles.paName}>{a.name}</span>
                  <span className={styles.paText}>{a.answers[i]?.trim() || '（未回答）'}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
