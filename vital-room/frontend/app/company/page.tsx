'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Company, EMPLOYER_TOKEN, HiringError, InterviewTemplate, Invitation, dateLabel, decisionLabel, errorText, hiringApi, modeLabel, statusLabel } from '@/lib/hiring';
import styles from '@/components/Hiring.module.css';

type Settings = { title: string; job_title: string; mode: 'human' | 'ai'; duration: string; questions: string; criteria: string };
type WorkspaceDraft = { settings: Settings; templateId: string; candidateName: string; opensAt: string; expiresAt: string };
const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);
const futureDate = () => { const d = new Date(Date.now() + 7 * 86400000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const draftKey = (companyId: string) => `hiring_company_draft_${companyId}`;
const emptyDraft = (mode: Settings['mode'] = 'ai'): WorkspaceDraft => ({ settings: { title: '', job_title: '', mode, duration: '20', questions: '', criteria: '' }, templateId: '', candidateName: '', opensAt: '', expiresAt: futureDate() });
const templateSettings = (t: InterviewTemplate): Settings => ({ title: t.title, job_title: t.job_title, mode: t.mode, duration: String(t.duration_minutes), questions: t.questions.join('\n'), criteria: t.criteria.join('\n') });
const payload = (s: Settings) => ({ title: s.title.trim(), job_title: s.job_title.trim(), mode: s.mode, duration_minutes: Number(s.duration), questions: lines(s.questions), criteria: lines(s.criteria) });
function readDraft(id: string): WorkspaceDraft | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(draftKey(id)) || 'null') as WorkspaceDraft | null;
    if (!value?.settings || !['ai', 'human'].includes(value.settings.mode)) return null;
    if (!['title', 'job_title', 'duration', 'questions', 'criteria'].every(k => typeof value.settings[k as keyof Settings] === 'string')) return null;
    if (!['templateId', 'candidateName', 'opensAt', 'expiresAt'].every(k => typeof value[k as keyof WorkspaceDraft] === 'string')) return null;
    return value;
  } catch { return null; }
}
function writeDraft(id: string, draft: WorkspaceDraft) {
  try { sessionStorage.setItem(draftKey(id), JSON.stringify(draft)); } catch { /* The current form remains usable when browser storage is unavailable. */ }
}
function nextCompanyPage(): string | null {
  const next = new URLSearchParams(window.location.search).get('next');
  if (!next || !next.startsWith('/company/')) return null;
  try {
    const url = new URL(next, window.location.origin);
    if (url.origin !== window.location.origin || !['/company/invitation', '/company/report'].includes(url.pathname)) return null;
    const id = url.searchParams.get('id');
    return id ? `${url.pathname}?id=${encodeURIComponent(id)}` : null;
  } catch { return null; }
}

export default function CompanyPage() {
  const router = useRouter();
  const [token, setToken] = useState('');
  const [company, setCompany] = useState<Company | null>(null);
  const [ready, setReady] = useState(false);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [templates, setTemplates] = useState<InterviewTemplate[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [draft, setDraft] = useState<WorkspaceDraft>(() => emptyDraft());
  const [draftCompany, setDraftCompany] = useState('');
  const authRef = useRef('');
  const { settings, templateId } = draft;
  const { mode } = settings;
  const selectedTemplate = templates.find(t => t.id === templateId);
  const settingsSaved = Boolean(selectedTemplate && JSON.stringify(payload(settings)) === JSON.stringify(payload(templateSettings(selectedTemplate))));

  const clearAccount = useCallback(() => {
    sessionStorage.removeItem(EMPLOYER_TOKEN); authRef.current = ''; setToken(''); setCompany(null); setDraftCompany(''); setDraft(emptyDraft()); setInvitations([]); setTemplates([]); setNotice('');
  }, []);
  const handleError = useCallback((err: unknown) => {
    setError(errorText(err));
    if (err instanceof HiringError && err.status === 401) clearAccount();
  }, [clearAccount]);
  const refresh = useCallback(async (auth: string) => {
    try {
      const [t, i] = await Promise.all([hiringApi<{ templates: InterviewTemplate[] }>('/templates', auth), hiringApi<{ invitations: Invitation[] }>('/invitations', auth)]);
      if (authRef.current !== auth) return;
      setTemplates(t.templates); setInvitations(i.invitations);
    } catch (err) { if (authRef.current === auth) throw err; }
  }, []);
  const loadWorkspace = useCallback(async (c: Company, auth: string) => {
    const [t, i] = await Promise.all([hiringApi<{ templates: InterviewTemplate[] }>('/templates', auth), hiringApi<{ invitations: Invitation[] }>('/invitations', auth)]);
    if (authRef.current !== auth) return;
    const requestedMode = new URLSearchParams(window.location.search).get('mode');
    let restored = readDraft(c.id);
    if (!restored) {
      restored = emptyDraft(requestedMode === 'human' ? 'human' : 'ai');
      if (!requestedMode && t.templates[0]) restored = { ...restored, settings: templateSettings(t.templates[0]), templateId: t.templates[0].id };
    }
    if (requestedMode === 'human' || requestedMode === 'ai') {
      restored = { ...restored, settings: { ...restored.settings, mode: requestedMode } };
      const url = new URL(window.location.href); url.searchParams.delete('mode');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    }
    setDraft(restored); setDraftCompany(c.id); setTemplates(t.templates); setInvitations(i.invitations); setCompany(c); setToken(auth);
    const next = nextCompanyPage();
    if (next) router.replace(next);
  }, [router]);
  useEffect(() => {
    const initialMode = new URLSearchParams(window.location.search).get('mode');
    if (initialMode === 'human' || initialMode === 'ai') setDraft(d => ({ ...d, settings: { ...d.settings, mode: initialMode } }));
    const saved = sessionStorage.getItem(EMPLOYER_TOKEN);
    if (!saved) { setReady(true); return; }
    authRef.current = saved;
    let active = true;
    void hiringApi<Company>('/auth/me', saved).then(c => active ? loadWorkspace(c, saved) : undefined).catch(err => { if (active) handleError(err); }).finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, [loadWorkspace, handleError]);
  useEffect(() => {
    if (company && draftCompany === company.id) writeDraft(company.id, draft);
  }, [company, draftCompany, draft]);
  useEffect(() => {
    if (!token || !company) return;
    const timer = window.setInterval(() => { void refresh(token).catch(handleError); }, 10000);
    return () => window.clearInterval(timer);
  }, [token, company, refresh, handleError]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (err) { handleError(err); } finally { setBusy(false); }
  }
  function updateSettings(next: Partial<Settings>) {
    setDraft(d => ({ ...d, settings: { ...d.settings, ...next } })); setNotice('');
  }
  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await run(async () => {
      const result = await hiringApi<{ token: string; company: Company }>(register ? '/auth/register' : '/auth/login', undefined, { email: data.get('email'), password: data.get('password'), ...(register ? { company_name: data.get('company_name') } : {}) });
      sessionStorage.setItem(EMPLOYER_TOKEN, result.token); authRef.current = result.token; await loadWorkspace(result.company, result.token);
    });
  }
  async function createTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(async () => {
      const result = await hiringApi<InterviewTemplate>('/templates', token, payload(settings));
      setTemplates(current => [result, ...current]); setDraft(d => ({ ...d, templateId: result.id }));
      setNotice('面接設定を保存しました。応募者ごとの招待を発行できます。');
    });
  }
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settingsSaved) { setError('変更した面接設定を保存してから、招待を発行してください。'); return; }
    await run(async () => {
      const result = await hiringApi<Invitation>(`/templates/${templateId}/invitations`, token, { candidate_name: draft.candidateName, opens_at: draft.opensAt ? new Date(draft.opensAt).toISOString() : null, expires_at: new Date(draft.expiresAt).toISOString() });
      if (company) writeDraft(company.id, draft);
      router.push(`/company/invitation?id=${encodeURIComponent(result.id)}&created=1`);
    });
  }

  return <main className={styles.shell}><div className={styles.container}>
    <header className={styles.header}><Link href="/" className={styles.brand}>VITAL ROOM / 採用面接</Link><div className={styles.row}>{company && <><span className={styles.muted}>{company.name}</span><button className={styles.button} disabled={busy} onClick={() => void run(async () => { await hiringApi('/auth/logout', token, {}); clearAccount(); })}>ログアウト</button></>}<Link href="/interviews/join" className={styles.button}>応募者の参加画面</Link></div></header>
    <p className={styles.eyebrow}>COMPANY WORKSPACE</p><h1 className={styles.title}>面接から、次の対話へ。</h1><p className={styles.subtitle}>対人・AIの面接を設定し、応募者ごとに招待。回答の根拠を確認して、担当者が判断します。</p>
    {error && <div role="alert" className={styles.error}>{error}</div>}{notice && <div role="status" className={styles.notice}>{notice}</div>}
    {!ready ? <p className={styles.empty}>読み込み中…</p> : !company ? <section className={`${styles.card} ${styles.authCard}`}>
      <p className={styles.eyebrow}>YOUR WORKSPACE</p><h2>対話の準備を、ここから。</h2>
      <p className={styles.muted}>選択中の面接方式：{modeLabel(mode)}。ログイン後に面接内容を設定できます。</p>
      <div className={styles.tabs}><button aria-pressed={!register} className={!register ? styles.primary : styles.button} onClick={() => setRegister(false)}>ログイン</button><button aria-pressed={register} className={register ? styles.primary : styles.button} onClick={() => setRegister(true)}>企業アカウントを作成</button></div>
      <form className={styles.form} onSubmit={authenticate}>{register && <label className={styles.field}>企業名<input name="company_name" className={styles.input} required maxLength={120} autoComplete="organization" /></label>}<label className={styles.field}>メールアドレス<input name="email" className={styles.input} type="email" required autoComplete="username" /></label><label className={styles.field}>パスワード<input name="password" className={styles.input} type="password" minLength={register ? 10 : undefined} maxLength={128} required autoComplete={register ? 'new-password' : 'current-password'} /></label>{register && <p className={styles.muted}>パスワードは10文字以上で設定してください。</p>}<button className={styles.primary} disabled={busy}>{busy ? '処理中…' : register ? 'アカウントを作成' : 'ログイン'}</button></form>
    </section> : <>
      <dl className={styles.overview} aria-label="面接の実施状況">
        <div><dt>保存した面接設定</dt><dd>{templates.length}<small>件</small></dd></div>
        <div><dt>招待・待機中</dt><dd>{invitations.filter(i => ['invited', 'waiting'].includes(i.status)).length}<small>人</small></dd></div>
        <div><dt>面接中</dt><dd>{invitations.filter(i => i.status === 'in_progress').length}<small>人</small></dd></div>
        <div><dt>面接完了</dt><dd>{invitations.filter(i => i.status === 'completed').length}<small>人</small></dd></div>
      </dl>
      <div className={styles.workspaceGrid}>
        <section className={styles.card}><h2>1. 面接を設定する</h2><form onSubmit={createTemplate} className={styles.form}>
          <fieldset className={styles.modeFieldset} role="radiogroup" aria-label="面接方式" aria-describedby="interview-mode-help" disabled={busy}>
            <legend>面接方式</legend>
            <div className={styles.modeOptions}>
              <label className={`${styles.modeOption} ${mode === 'human' ? styles.modeSelected : ''}`}>
                <input type="radio" name="mode" value="human" aria-label="対人面接" checked={mode === 'human'} onChange={() => updateSettings({ mode: 'human' })} />
                <span><strong>対人面接</strong><small>面接官が応募者と会話します</small></span>
              </label>
              <label className={`${styles.modeOption} ${mode === 'ai' ? styles.modeSelected : ''}`}>
                <input type="radio" name="mode" value="ai" aria-label="AI面接" checked={mode === 'ai'} onChange={() => updateSettings({ mode: 'ai' })} />
                <span><strong>AI面接</strong><small>AIが質問し、回答を記録します</small></span>
              </label>
            </div>
            <p className={styles.muted} id="interview-mode-help">対人面接のカメラ・マイクは、招待を発行して面接ルームに入る際に設定します。</p>
          </fieldset>
          <label className={styles.field}>面接名<input className={styles.input} name="title" value={settings.title} onChange={e => updateSettings({ title: e.target.value })} disabled={busy} required maxLength={120} placeholder="例：2027年度 エンジニア一次面接" /></label>
          <label className={styles.field}>募集職種<input className={styles.input} name="job_title" value={settings.job_title} onChange={e => updateSettings({ job_title: e.target.value })} disabled={busy} required maxLength={120} placeholder="例：ソフトウェアエンジニア" /></label>
          <label className={styles.field}>所要時間（分）<input className={styles.input} name="duration" type="number" min={5} max={120} value={settings.duration} onChange={e => updateSettings({ duration: e.target.value })} disabled={busy} required /></label>
          <label className={styles.field}>質問（1行に1問）<textarea className={styles.textarea} name="questions" value={settings.questions} onChange={e => updateSettings({ questions: e.target.value })} disabled={busy} required maxLength={10000} placeholder={'これまで力を入れた取り組みを教えてください。\n難しい課題にどのように取り組みましたか？'} /></label>
          <label className={styles.field}>確認したい項目（1行に1項目・企業側のみ表示）<textarea className={styles.textarea} name="criteria" value={settings.criteria} onChange={e => updateSettings({ criteria: e.target.value })} disabled={busy} required maxLength={4000} placeholder={'課題への取り組み方\nチームでの役割\n志望理由'} /></label>
          <p className={styles.muted}>AI面接は設定した質問と回答に沿って進みます。集計は回答の整理を支援し、合否の自動判定は行いません。</p><button className={styles.primary} disabled={busy}>面接設定を保存</button>
          <p className={styles.muted}>{settingsSaved ? 'この内容で保存済みです。招待を発行しても入力内容は保持されます。' : '入力内容はこのブラウザーのタブに保持されます。招待の発行前に面接設定を保存してください。'}</p>
        </form></section>
        <section className={styles.card}><h2>2. 応募者を招待する</h2>{!templates.length ? <p className={styles.empty}>面接設定を保存すると、応募者ごとの招待を発行できます。</p> : <form className={styles.form} onSubmit={invite}>
          <label className={styles.field}>面接設定<select className={styles.select} value={templateId} disabled={busy} onChange={e => { const template = templates.find(t => t.id === e.target.value); if (template) { setDraft(d => ({ ...d, templateId: template.id, settings: templateSettings(template) })); setNotice('選択した面接設定の内容を左側に表示しました。'); } }}><option value="" disabled>保存済みの面接設定を選択</option>{templates.map(t => <option value={t.id} key={t.id}>{t.title} / {modeLabel(t.mode)}</option>)}</select></label>
          {!settingsSaved && <p className={styles.notice}>面接設定に未保存の変更があります。左側の「面接設定を保存」を押してから招待を発行してください。</p>}
          <label className={styles.field}>応募者名<input className={styles.input} name="candidate_name" value={draft.candidateName} onChange={e => setDraft(d => ({ ...d, candidateName: e.target.value }))} disabled={busy} required maxLength={100} placeholder="応募者ごとに個別の招待を発行します" /></label>
          <label className={styles.field}>参加可能日時（任意・現地時刻）<input className={styles.input} name="opens_at" type="datetime-local" value={draft.opensAt} onChange={e => setDraft(d => ({ ...d, opensAt: e.target.value }))} disabled={busy} /></label>
          <label className={styles.field}>招待の有効期限（現地時刻）<input className={styles.input} name="expires_at" type="datetime-local" value={draft.expiresAt} onChange={e => setDraft(d => ({ ...d, expiresAt: e.target.value }))} disabled={busy} required /></label>
          <button className={styles.primary} disabled={busy || !settingsSaved}>招待URL・コードを発行</button><p className={styles.muted}>発行後、専用の確認画面でURL・コードをコピーできます。招待は1人用です。結果の閲覧には企業アカウントのログインが必要です。</p>
        </form>}</section>
      </div>
      <section className={styles.card}><div className={styles.header}><h2>応募者と実施状況</h2><button className={styles.button} disabled={busy} onClick={() => void run(() => refresh(token))}>更新</button></div>{!invitations.length ? <p className={styles.empty}>招待した応募者がここに表示されます。</p> : <div className={styles.list}>{invitations.map(i => <article className={styles.item} key={i.id}>
        <div className={styles.header} style={{ marginBottom: 12 }}><div><p className={styles.itemTitle}>{i.candidate_name} <span className={styles.badge}>{statusLabel(i)}</span></p><span className={styles.muted}>{i.title} · {modeLabel(i.mode)} · {decisionLabel[i.decision] || '未判断'}</span></div></div><p className={styles.muted}>参加可能：{dateLabel(i.opens_at)} ／ 有効期限：{dateLabel(i.expires_at)}</p>
        <div className={styles.row}><Link className={styles.button} href={`/company/invitation?id=${encodeURIComponent(i.id)}`}>招待を確認</Link><Link className={styles.button} href={`/company/report?id=${encodeURIComponent(i.id)}`}>集計・判断を開く</Link>{i.mode === 'human' && !['completed', 'revoked', 'expired'].includes(i.status) && <Link className={styles.primary} href={`/interviews/session?id=${encodeURIComponent(i.id)}&host=1`}>面接ルームへ</Link>}{!['completed', 'revoked', 'expired'].includes(i.status) && <button className={styles.danger} disabled={busy} onClick={() => { if (window.confirm(`${i.candidate_name} さんの招待を取り消しますか？進行中の面接も終了します。`)) void run(async () => { await hiringApi(`/invitations/${i.id}/revoke`, token, {}); await refresh(token); }); }}>招待を取り消す</button>}</div>
      </article>)}</div>}</section>
    </>}
  </div></main>;
}
