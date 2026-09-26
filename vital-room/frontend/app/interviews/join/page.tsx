'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { HiringDeviceControls, useHiringDevices } from '@/components/HiringDevices';
import { InterviewSession, InvitationLookup, candidateKey, dateLabel, errorText, hiringApi, modeLabel } from '@/lib/hiring';
import styles from '@/components/Hiring.module.css';
import entry from '@/app/entry.module.css';
import joinStyles from './page.module.css';

function invitationCode(value: string) {
  let text = value.normalize('NFKC').trim();
  if (/^https?:\/\//i.test(text)) {
    try { text = new URL(text).searchParams.get('code') || ''; } catch { return ''; }
  }
  const normalized = text.normalize('NFKC').replace(/[\s\u00ad\u200b-\u200d\u2060\ufeff\p{Pd}\u2212]/gu, '');
  return /^[A-Za-z0-9]+$/.test(normalized) ? normalized.toUpperCase() : '';
}

function savedToken(id: string) {
  try { return sessionStorage.getItem(candidateKey(id)) || ''; } catch { return ''; }
}

export default function InterviewJoinPage() {
  const router = useRouter();
  const device = useHiringDevices();
  const [code, setCode] = useState('');
  const [confirmedCode, setConfirmedCode] = useState('');
  const [lookup, setLookup] = useState<InvitationLookup | null>(null);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [checking, setChecking] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [resume, setResume] = useState(false);
  const [now, setNow] = useState(Date.now);
  const request = useRef(0);
  const joiningRef = useRef(false);
  const invalidateLookup = useCallback(() => { request.current++; }, []);

  const check = useCallback(async (value: string) => {
    const id = ++request.current;
    const normalized = invitationCode(value);
    setCode(normalized); setLookup(null); setConfirmedCode(''); setConsent(false); setResume(false); setError('');
    if (!/^[A-Z0-9]{12,64}$/.test(normalized)) {
      setChecking(false);
      setError('招待コードを確認してください。企業から届いたコード、または招待URL全体を貼り付けてください。');
      return;
    }
    setChecking(true);
    try {
      const result = await hiringApi<InvitationLookup>('/join/lookup', undefined, { code: normalized });
      if (id !== request.current) return;
      setLookup(result); setConfirmedCode(normalized); setResume(Boolean(savedToken(result.id)));
    } catch (err) {
      if (id === request.current) setError(errorText(err));
    } finally {
      if (id === request.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('code');
    if (initial) void check(initial);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { invalidateLookup(); window.clearInterval(timer); };
  }, [check, invalidateLookup]);

  function editCode(value: string) {
    request.current++;
    setCode(value); setLookup(null); setConfirmedCode(''); setConsent(false); setResume(false); setChecking(false); setError('');
  }

  const usedElsewhere = Boolean(lookup && ['waiting', 'in_progress'].includes(lookup.status) && !resume);
  const notOpen = Boolean(lookup?.opens_at && Date.parse(lookup.opens_at) > now);
  const expired = Boolean(lookup && Date.parse(lookup.expires_at) < now);
  const unavailable = Boolean(lookup && (['completed', 'revoked', 'expired'].includes(lookup.status) || usedElsewhere || (!resume && (expired || notOpen))));

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookup || !confirmedCode || !consent || unavailable || !device.checked || device.loading || (!resume && !name.trim()) || joiningRef.current) return;
    setError('');
    try {
      // Check storage before claiming a single-use invitation.
      const key = 'hiring_join_storage_check';
      sessionStorage.setItem(key, 'ok');
      if (sessionStorage.getItem(key) !== 'ok') throw new Error('Storage unavailable');
      sessionStorage.removeItem(key);
    } catch {
      setError('参加情報を保存できません。ブラウザーでサイトデータの保存を許可するか、Chrome・Edge・Safariなどのブラウザーで招待URLを開いてください。');
      return;
    }
    joiningRef.current = true;
    setJoining(true);
    try {
      const token = savedToken(lookup.id);
      const result = await hiringApi<{ token: string; session: InterviewSession }>('/join/start', undefined, {
        code: confirmedCode, name: name.trim(), consent, ...(token ? { resume_token: token } : {}),
      });
      const id = result.session.invitation.id;
      sessionStorage.setItem(candidateKey(id), result.token);
      sessionStorage.setItem('hiring_last_session', id);
      router.push('/interviews/session?id=' + encodeURIComponent(id));
    } catch (err) {
      setError(errorText(err)); setJoining(false); joiningRef.current = false;
    }
  }

  return <main className={entry.page}><div className={entry.content}>
    <header className={entry.header}>
      <Link href="/" className={entry.brand + ' ' + joinStyles.brand}>VITAL ROOM</Link>
      <Link className={entry.secondary} href="/company">企業の方はこちら</Link>
    </header>
    <p className={entry.step}>就活生の方 · 面接への参加</p>
    <h1 className={entry.title}>招待コードを入力</h1>
    <p className={entry.description}>企業から届いた招待コードを入力してください。招待URLから開いた場合は、面接内容が自動で表示されます。</p>
    <ol className={joinStyles.steps} aria-label="参加までの流れ">
      <li aria-current={!lookup ? 'step' : undefined} data-done={Boolean(lookup)}><span>1</span>招待確認</li>
      <li aria-current={lookup ? 'step' : undefined}><span>2</span>参加準備</li>
      <li><span>3</span>面接に入室</li>
    </ol>
    <noscript><p className={styles.error}>面接に参加するには、ブラウザーでJavaScriptを有効にしてください。</p></noscript>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <section className={entry.card + ' ' + joinStyles.card} aria-label="招待コードの確認">
      <form className={styles.form} onSubmit={event => { event.preventDefault(); void check(code); }}>
        <label className={styles.field}>招待コード
          <input className={styles.input + ' ' + joinStyles.code} value={code} onChange={event => editCode(event.target.value)} required maxLength={2048} disabled={joining} autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} placeholder="届いた招待コードを入力" />
        </label>
        <p className={joinStyles.hint}>招待URLをそのまま貼り付けても確認できます。</p>
        <button className={styles.primary} disabled={checking || joining || !code.trim()}>{checking ? '確認中…' : '面接を確認'}</button>
      </form>
      {lookup && <p className={joinStyles.confirmed} role="status">招待を確認しました。下の面接内容を確認して、参加の準備を進めてください。</p>}
    </section>
    {lookup && <section className={entry.card + ' ' + joinStyles.card} aria-label="面接内容と参加準備">
      <div className={styles.row}><span className={styles.badge}>{modeLabel(lookup.mode)}</span><span className={styles.muted}>約 {lookup.duration_minutes} 分</span></div>
      <h2 className={joinStyles.interviewTitle}>{lookup.title}</h2>
      <p>{lookup.company_name} · {lookup.job_title}</p>
      <dl className={joinStyles.dates}>
        <div><dt>参加可能</dt><dd>{dateLabel(lookup.opens_at)}</dd></div>
        <div><dt>有効期限</dt><dd>{dateLabel(lookup.expires_at)}</dd></div>
      </dl>
      {lookup.mode === 'ai'
        ? <p className={styles.notice}>{lookup.ai_available ? 'AIが質問を担当します。接続状況により設定済みの質問で進行することがあります。' : 'この面接は現在、設定済みの質問に沿った自動進行です。生成AIによる追加質問は行いません。'}面接画面で「面接を開始」を押すと、質問の読み上げ後にマイクで回答を受け付けます。話し終えたら「回答を完了」を押してください。以後は次の質問と音声入力へ自動で進みます。文字での回答も利用できます。</p>
        : <p className={styles.notice}>参加後は待機画面に入ります。企業の担当者が入室を許可すると面接が始まります。面接中は、自分の心拍・ストレスの計測と共有をオンにして、相手とリアルタイムのグラフを確認できます。</p>}
      <p className={entry.description}>送信した発言・回答は保存され、企業の担当者が面接内容の集計と判断に利用します。AIによる合否の自動判定は行いません。カメラ映像・通話音声は録画・録音しません。音声入力を使う場合は、ブラウザーの音声認識サービスに音声が送られることがあります。</p>
      {unavailable ? <p role="status" className={styles.error}>{
        lookup.status === 'completed' ? 'この面接は実施済みです。'
          : lookup.status === 'revoked' ? 'この招待は取り消されています。企業の担当者に新しい招待をご確認ください。'
          : usedElsewhere ? 'この招待は既に参加手続きが行われています。参加したブラウザーで再開してください。別の端末で参加する場合は、企業の担当者に新しい招待をご確認ください。'
          : notOpen ? '参加可能日時になるまでお待ちください。'
          : '招待の有効期限を過ぎています。企業の担当者にお問い合わせください。'
      }</p> : <>
        <h3 className={joinStyles.sectionHeading}>カメラ・マイクを確認</h3>
        <HiringDeviceControls device={device} />
        <p className={joinStyles.hint}>{lookup.mode === 'ai' ? 'AI面接でカメラ映像は送信されません。音声入力を使わずに文字だけでも回答できます。' : 'カメラ・マイクをオフにして、文字で参加することもできます。'}</p>
        <hr className={styles.divider} />
        <form className={styles.form} onSubmit={join}>
          <label className={styles.field}>お名前<input className={styles.input} value={name} onChange={event => setName(event.target.value)} required={!resume} maxLength={100} disabled={joining} autoComplete="name" placeholder={resume ? '再開する場合は省略できます' : '面接で表示するお名前'} /></label>
          <label className={styles.check}><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} required disabled={joining} />面接方式と記録の利用目的を確認し、発言・回答の保存と企業による閲覧に同意します。</label>
          {!device.checked && <p className={joinStyles.hint}>上の「機器を接続・確認」を押してから入室してください。</p>}
          <button className={styles.primary} disabled={joining || !consent || (!resume && !name.trim()) || device.loading || !device.checked}>{joining ? '接続中…' : resume ? '面接を再開' : lookup.mode === 'ai' ? '準備完了・面接を開始' : '準備完了・待機室へ'}</button>
          <p className={joinStyles.hint}>開始後はこのブラウザーの同じタブで再開できます。別の端末・ブラウザーでは参加権限を引き継げません。</p>
        </form>
      </>}
    </section>}
    <footer className={entry.footer}><Link className={entry.secondary} href="/">参加方法の選択に戻る</Link></footer>
  </div></main>;
}
