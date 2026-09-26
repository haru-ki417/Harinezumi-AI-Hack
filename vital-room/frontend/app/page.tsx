'use client';

import Link from 'next/link';
import { useState } from 'react';
import styles from './entry.module.css';
import home from './home.module.css';
import { UiIcon } from '@/components/UiIcon';

export default function Home() {
  const [role, setRole] = useState<'candidate' | 'interviewer'>('candidate');
  const [mode, setMode] = useState<'human' | 'ai'>('human');

  return <main className={styles.page}>
    <div className={`${styles.content} ${home.content}`}>
      <header className={styles.header}>
        <span className={styles.brand}>VITAL ROOM</span>
        <Link href="/company" className={styles.secondary}>企業の面接管理</Link>
      </header>
      <div className={home.layout}>
      <section className={home.intro}>
        <p className={home.eyebrow}>CONVERSATION FIRST</p>
        <h1 className={home.headline}>伝わる対話を。<br /><span>次の一歩へ。</span></h1>
        <p className={home.copy}>招待から、対話、その先の振り返りまで。<br />一人ひとりの言葉に向き合うための、<br />新しい面接の場所。</p>
        <div className={home.visual} aria-hidden="true">
          <div className={home.visualTop}><span>INTERVIEW SPACE</span><span>VITAL ROOM</span></div>
          <div className={home.conversation}><span className={home.avatar}><UiIcon name="person" size={23} /></span><div className={home.wave}>{[5, 8, 13, 8, 19, 28, 16, 35, 24, 14, 21, 10, 17, 31, 38, 24, 13, 18, 9, 6].map((height, index) => <i key={index} style={{ height }} />)}</div><span className={home.avatar}><UiIcon name="person" size={23} /></span></div>
          <div className={home.visualBottom}><span>TALK · LISTEN · CONNECT</span><span>対話に、集中。</span></div>
        </div>
      </section>
      <section className={`${styles.card} ${home.portal}`} aria-label="面接の参加・作成">
        <div className={home.portalHeader}><span>GET STARTED</span><span aria-hidden="true">↗</span></div>
        <h2>面接をはじめる</h2><p>あなたの役割を選んで、次のステップへ。</p>
        <div className={styles.roles} role="group" aria-label="役割">
          <button type="button" aria-pressed={role === 'candidate'}
            className={styles.choice} onClick={() => setRole('candidate')}><UiIcon name="person" size={17} />就活生</button>
          <button type="button" aria-pressed={role === 'interviewer'}
            className={styles.choice} onClick={() => setRole('interviewer')}><UiIcon name="briefcase" size={17} />面接官</button>
        </div>

        {role === 'candidate' ? <div className={styles.panel}>
          <h2>企業からの招待で参加</h2>
          <p className={styles.description}>次の画面で、企業から届いた招待コードを入力してください。面接内容を確認してから、カメラ・マイクを設定できます。</p>
          <Link href="/interviews/join" className={styles.primary}>就活生として面接に参加<UiIcon name="arrow" size={18} /></Link>
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
          <Link href={`/company?mode=${mode}`} className={styles.primary}>この方式で面接を設定<UiIcon name="arrow" size={18} /></Link>
          <p className={styles.note}>企業アカウントでログイン、または新規登録して進みます。</p>
        </div>}
        <div className={home.path}><span><b>01</b>{role === 'candidate' ? '招待確認' : '面接設定'}</span><i aria-hidden="true" /><span><b>02</b>{role === 'candidate' ? '参加準備' : '応募者を招待'}</span><i aria-hidden="true" /><span><b>03</b>面接へ</span></div>
      </section>
      </div>
      <div className={home.features}>
        <div className={home.feature}><UiIcon name="link" /><strong>招待URLで、スムーズに</strong><p>リンクから参加準備へ。コードでも参加できます。</p></div>
        <div className={home.feature}><UiIcon name="conversation" /><strong>面接に合わせた、ふたつの方式</strong><p>担当者と話す対人面接、質問に答えるAI面接。</p></div>
        <div className={home.feature}><UiIcon name="chart" /><strong>対話を、振り返りにつなぐ</strong><p>保存した回答と面接記録を、あとから確認。</p></div>
      </div>
      <footer className={home.footer}>
        <span>VITAL ROOM · A SPACE FOR CONVERSATION</span>
        <Link href="/vital" className={styles.secondary}>バイタル共有ルームを開く</Link>
      </footer>
    </div>
  </main>;
}
