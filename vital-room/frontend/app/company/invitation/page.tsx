'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useRef } from 'react';
import { EmployerInterviewAccess, useEmployerInterview } from '@/components/EmployerInterviewAccess';
import { dateLabel, modeLabel, statusLabel } from '@/lib/hiring';
import styles from '@/components/Hiring.module.css';
import detail from '@/components/CompanyDetails.module.css';
import { useInvitationSharing } from '@/hooks/useInvitationSharing';

function InvitationDetails({ id, created }: { id: string; created: boolean }) {
  const { session, loaded, busy, error, notice, setNotice, authRequired, action } = useEmployerInterview(id);
  const sharing = useInvitationSharing(Boolean(session));
  const origin = sharing.origin;
  const urlInput = useRef<HTMLInputElement>(null);
  const joinInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const invitation = session?.invitation;
  const invitationUrl = invitation && origin ? `${origin}/interviews/join?code=${encodeURIComponent(invitation.code)}` : '';
  const joinUrl = origin ? `${origin}/interviews/join` : '';
  async function copy(value: string, input: HTMLInputElement | null, label: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value); setNotice(`${label}をコピーしました。`);
    } catch {
      input?.focus(); input?.select();
      setNotice('自動コピーが利用できません。選択された内容を手動でコピーしてください。');
    }
  }
  return <main className={styles.shell}><div className={styles.container}>
    <header className={styles.header}><Link href="/" className={styles.brand}>VITAL ROOM / 採用面接</Link><Link href="/company" className={styles.button}>面接設定に戻る</Link></header>
    <p className={styles.eyebrow}>INVITATION</p><h1 className={styles.title}>招待URL・コードを確認</h1>
    {error && <div className={styles.error} role="alert">{error}</div>}
    <EmployerInterviewAccess loaded={loaded} authRequired={authRequired} returnTo={`/company/invitation?id=${encodeURIComponent(id)}`} />
    {invitation && <>
      {(notice || created) && <div className={styles.notice} role="status">{notice || '招待を発行しました。URLまたはコードを応募者に送付してください。'}</div>}
      <section className={`${styles.card} ${styles.narrow}`} aria-label="応募者の招待情報">
        <div className={styles.header}><h2>{invitation.candidate_name} さんの招待</h2><span className={styles.badge}>{statusLabel(invitation)}</span></div>
        <dl className={detail.summary}><div><dt>面接名</dt><dd>{invitation.title}</dd></div><div><dt>面接方式</dt><dd>{modeLabel(invitation.mode)} · {invitation.duration_minutes}分</dd></div><div><dt>参加可能日時</dt><dd>{dateLabel(invitation.opens_at)}</dd></div><div><dt>有効期限</dt><dd>{dateLabel(invitation.expires_at)}</dd></div></dl>
        {['revoked', 'expired', 'completed'].includes(invitation.status) && <p className={styles.notice}>{invitation.status === 'completed' ? 'この招待の面接は終了しています。結果は集計・判断の画面から確認できます。' : 'この招待では現在面接に参加できません。必要に応じて面接設定に戻り、新しい招待を発行してください。'}</p>}
        <div className={styles.form}>
          <div aria-live="polite" data-testid="invitation-sharing-status">
            {origin ? <><span className={styles.badge}>別端末から参加できます</span><p className={styles.muted}>この招待URLを相手に送ると、相手のPC・スマートフォンから面接に参加できます。</p>{sharing.temporary && <p className={styles.muted}>面接が終わるまで、このPCと面接アプリを起動したままにしてください。</p>}</> : <p className={styles.notice}>{sharing.checking ? '別端末で使える招待URLを確認しています…' : sharing.reason === 'not_configured' ? '別端末への接続がまだ有効になっていません。面接アプリを共有モードで起動すると、ここに招待URLが表示されます。' : '別端末からの接続を確認できませんでした。面接アプリとインターネット接続を確認して、再確認してください。'}</p>}
            <button className={styles.button} disabled={sharing.checking} onClick={() => void sharing.refresh()}>{sharing.checking ? '接続を確認中…' : '接続を再確認'}</button>
          </div>
          <div className={styles.field}><label htmlFor="invitation-url">招待URL</label><div className={detail.copyField}><input id="invitation-url" ref={urlInput} className={styles.input} readOnly value={invitationUrl} placeholder="別端末への接続を確認すると表示されます" onFocus={e => e.target.select()} /><button className={styles.primary} disabled={!invitationUrl || sharing.checking} onClick={() => void copy(invitationUrl, urlInput.current, '招待URL')}>招待URLをコピー</button></div></div>
          <div className={styles.field}><label htmlFor="invitation-code">招待コード</label><div className={detail.copyField}><input id="invitation-code" ref={codeInput} className={`${styles.input} ${detail.codeInput}`} readOnly value={invitation.code} onFocus={e => e.target.select()} /><button className={styles.button} onClick={() => void copy(invitation.code, codeInput.current, 'コード')}>コードをコピー</button></div></div>
          <div className={styles.field}><label htmlFor="join-url">コード入力用URL</label><div className={detail.copyField}><input id="join-url" ref={joinInput} className={styles.input} readOnly value={joinUrl} placeholder="別端末への接続を確認すると表示されます" onFocus={e => e.target.select()} /><button className={styles.button} disabled={!joinUrl || sharing.checking} onClick={() => void copy(joinUrl, joinInput.current, 'コード入力用URL')}>コード入力用URLをコピー</button></div></div>
          <p className={styles.muted}>この招待は応募者1人用です。URLを開くか、参加画面でコードを入力すると、面接内容を確認できます。</p>
          <p className={styles.muted}>コードで案内する場合は、「コード入力用URL」も一緒に送ってください。企業側はこの画面のまま面接の設定・入室許可ができます。</p>
        </div>
        <div className={`${styles.row} ${detail.separated}`}><Link className={styles.button} href={`/company/report?id=${encodeURIComponent(id)}`}>集計・判断を開く</Link>{invitation.mode === 'human' && !['completed', 'revoked', 'expired'].includes(invitation.status) && <Link className={styles.primary} href={`/interviews/session?id=${encodeURIComponent(id)}&host=1`}>面接ルームへ</Link>}<button className={styles.button} disabled={busy} onClick={() => void action()}>状態を更新</button></div>
      </section>
    </>}
  </div></main>;
}

function InvitationRoute() { const query = useSearchParams(); const id = query.get('id') || ''; return <InvitationDetails key={id} id={id} created={query.get('created') === '1'} />; }
export default function CompanyInvitationPage() { return <Suspense fallback={<main className={styles.shell}><p className={styles.empty}>読み込み中…</p></main>}><InvitationRoute /></Suspense>; }
