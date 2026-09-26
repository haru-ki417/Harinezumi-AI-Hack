'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from './entry.module.css';

export default function Home() {
  const [role, setRole] = useState<'candidate' | 'interviewer'>('candidate');
  const [mode, setMode] = useState<'human' | 'ai'>('human');

  return <main className={styles.page}>
    <div className={styles.content}>
      <header className={styles.header}>
        <span className={styles.brand}>VITAL ROOM</span>
        <Link href="/company" className={styles.secondary}>企業の面接管理</Link>
      </header>
      <p className={styles.step}>ステップ 1 · 参加する役割を選択</p>
      <h1 className={styles.title}>面接をはじめる</h1>
      <p className={styles.description}>就活生は招待された面接へ。面接官は面接方式を選んで準備を進めます。</p>

      <section className={styles.card} aria-label="面接の参加・作成">
        <div className={styles.roles} role="group" aria-label="役割">
          <button type="button" aria-pressed={role === 'candidate'}
            className={styles.choice} onClick={() => setRole('candidate')}>就活生</button>
          <button type="button" aria-pressed={role === 'interviewer'}
            className={styles.choice} onClick={() => setRole('interviewer')}>面接官</button>
        </div>

        {role === 'candidate' ? <div className={styles.panel}>
          <h2>企業からの招待で参加</h2>
          <p className={styles.description}>次の画面で、企業から届いた招待コードを入力してください。面接内容を確認してから、カメラ・マイクを設定できます。</p>
          <Link href="/interviews/join" className={styles.primary}>就活生として面接に参加</Link>
        </div> : <div className={styles.panel}>
          <h2>面接方式を選択</h2>
          <div className={styles.modes} role="group" aria-label="面接方式">
            <button type="button" className={styles.choice} aria-pressed={mode === 'human'} onClick={() => setMode('human')}>
              <strong>対人面接</strong><span>担当者が応募者と通話して面接します。</span>
            </button>
            <button type="button" className={styles.choice} aria-pressed={mode === 'ai'} onClick={() => setMode('ai')}>
              <strong>AI面接</strong><span>AIが質問し、担当者が根拠付きの集計を確認します。</span>
            </button>
          </div>
          <p className={styles.description}>{mode === 'human'
            ? '面接設定と招待の作成後、面接ルームでカメラ・マイクを設定します。'
            : '質問や確認項目を設定して応募者を招待します。面接官のカメラ・マイク設定は不要です。'}</p>
          <Link href={`/company?mode=${mode}`} className={styles.primary}>この方式で面接を設定</Link>
          <p className={styles.note}>企業アカウントでログイン、または新規登録して進みます。</p>
        </div>}
      </section>

      <footer className={styles.footer}>
        <Link href="/vital" className={styles.secondary}>バイタル共有ルームを開く</Link>
      </footer>
    </div>
  </main>;
}
