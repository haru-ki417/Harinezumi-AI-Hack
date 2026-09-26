'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPLOYER_TOKEN, HiringError, InterviewSession, errorText, hiringApi } from '@/lib/hiring';
import styles from './Hiring.module.css';

/** Read private interview records exclusively through the employer endpoint. */
export function useEmployerInterview(id: string) {
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const tokenRef = useRef('');
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const handleError = useCallback((err: unknown) => {
    setError(errorText(err));
    if (err instanceof HiringError && [401, 403, 404].includes(err.status)) setSession(null);
    if (err instanceof HiringError && err.status === 401) {
      if (sessionStorage.getItem(EMPLOYER_TOKEN) === tokenRef.current) sessionStorage.removeItem(EMPLOYER_TOKEN);
      tokenRef.current = ''; setAuthRequired(true);
    }
  }, []);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    const auth = sessionStorage.getItem(EMPLOYER_TOKEN) || '';
    tokenRef.current = auth;
    if (!id) { setError('面接が指定されていません。面接設定の一覧から開いてください。'); setLoaded(true); }
    else if (!auth) { setAuthRequired(true); setLoaded(true); }
    else {
      void hiringApi<InterviewSession>(`/invitations/${encodeURIComponent(id)}`, auth)
        .then(result => { if (active) setSession(result); })
        .catch(err => { if (active) handleError(err); })
        .finally(() => { if (active) setLoaded(true); });
    }
    return () => { active = false; mounted.current = false; };
  }, [id, handleError]);
  const action = useCallback(async (operation?: 'report' | 'finish' | 'review', body: unknown = {}): Promise<InterviewSession | null> => {
    if (busyRef.current || !id || !tokenRef.current) return null;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await hiringApi<InterviewSession>(`/invitations/${encodeURIComponent(id)}${operation ? `/${operation}` : ''}`, tokenRef.current, operation ? body : undefined);
      if (!mounted.current) return null;
      setSession(result); return result;
    } catch (err) { if (mounted.current) handleError(err); return null; }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }, [id, handleError]);
  return { session, loaded, busy, error, notice, setNotice, authRequired, action };
}

export function EmployerInterviewAccess({ loaded, authRequired, returnTo }: { loaded: boolean; authRequired: boolean; returnTo: string }) {
  if (!loaded) return <p className={styles.empty}>読み込み中…</p>;
  if (!authRequired) return null;
  return <section className={`${styles.card} ${styles.narrow}`}><h2>企業アカウントでログインしてください</h2><p className={styles.subtitle}>この画面は面接を作成した企業の担当者のみ閲覧できます。</p><Link className={styles.primary} href={`/company?next=${encodeURIComponent(returnTo)}`}>企業ログインへ</Link></section>;
}
