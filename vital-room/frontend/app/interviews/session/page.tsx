'use client';

import Link from 'next/link';
import { HiringVitalSummary } from '@/components/HiringVitalSummary';
import { InterviewFeedback } from '@/components/InterviewFeedback';
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { HiringHumanRoom } from '@/components/HiringHumanRoom';
import { AiInterviewer, useAiInterviewVoice } from '@/components/AiInterviewer';
import { useAiInterviewRecognition } from '@/components/useAiInterviewRecognition';
import { EMPLOYER_TOKEN, HiringError, InterviewSession, candidateKey, dateLabel, errorText, hiringApi, modeLabel, newRequestId, statusLabel } from '@/lib/hiring';
import styles from '@/components/Hiring.module.css';

interface PendingAnswer { text: string; request_id: string; expected_turn_id: string }

export default function InterviewSessionPage() {
  const [id, setId] = useState(''); const [token, setToken] = useState(''); const [host, setHost] = useState(false); const [loaded, setLoaded] = useState(false); const [session, setSession] = useState<InterviewSession | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [draft, setDraft] = useState(''); const [pending, setPending] = useState<PendingAnswer | null>(null); const [now, setNow] = useState(Date.now());
  const [finishingAnswer, setFinishingAnswer] = useState(false);
  const [refreshingFeedback, setRefreshingFeedback] = useState(false);
  const busyRef = useRef(false); const voiceReading = useRef(false); const transcriptEnd = useRef<HTMLDivElement>(null);
  const draftRef = useRef(''); const pendingRef = useRef(pending); pendingRef.current = pending;
  const submitting = useRef(false); const automaticInput = useRef(false); const alive = useRef(false); const turnGeneration = useRef(0);
  const microphonePermission = useRef<Promise<boolean>>(Promise.resolve(false));
  const currentQuestion = session?.transcript.filter(t => t.role === 'ai' || t.role === 'interviewer').at(-1);
  const ended = Boolean(session && ['completed', 'revoked', 'expired'].includes(session.invitation.status));
  const processing = Boolean(session?.processing || (session?.invitation.status === 'in_progress' && session?.template.mode === 'ai' && session.transcript.at(-1)?.role === 'candidate'));
  const remaining = session?.deadline_at ? Math.max(0, Math.ceil((Date.parse(session.deadline_at) - now) / 1000)) : null;
  const live = useRef({ questionId: currentQuestion?.id, ended, processing, remaining }); live.current = { questionId: currentQuestion?.id, ended, processing, remaining };
  const updateDraft = useCallback((value: string) => { draftRef.current = value.slice(0, 6000); setDraft(draftRef.current); }, []);
  const speech = useAiInterviewRecognition(text => { if (!pendingRef.current && !voiceReading.current) updateDraft(`${draftRef.current}${draftRef.current ? '\n' : ''}${text}`); });
  const abortSpeech = speech.abort;
  useEffect(() => { alive.current = true; return () => { alive.current = false; automaticInput.current = false; }; }, []);
  const receive = useCallback((next: InterviewSession) => { setSession(current => { if (current && current.invitation.id === next.invitation.id) { if (current.transcript.length > next.transcript.length) return current; if (['completed', 'revoked', 'expired'].includes(current.invitation.status) && !['completed', 'revoked', 'expired'].includes(next.invitation.status)) return current; } return next; }); }, []);
  const fetchSession = useCallback(async (sessionId: string, auth: string) => { const result = await hiringApi<InterviewSession>(`/session/${encodeURIComponent(sessionId)}`, auth); receive(result); return result; }, [receive]);
  useEffect(() => {
    const query = new URLSearchParams(window.location.search); const isHost = query.get('host') === '1'; const sessionId = query.get('id') || (!isHost ? sessionStorage.getItem('hiring_last_session') : '') || ''; const auth = sessionStorage.getItem(isHost ? EMPLOYER_TOKEN : candidateKey(sessionId)) || '';
    setHost(isHost); setId(sessionId); setToken(auth);
    if (!sessionId || !auth) { setError(isHost ? '企業アカウントでログインしてから面接ルームを開いてください。' : 'このブラウザーに参加権限がありません。招待URLまたは参加コードから参加してください。'); setLoaded(true); return; }
    try { const saved = JSON.parse(sessionStorage.getItem(`hiring_pending_${sessionId}`) || 'null') as PendingAnswer | null; if (saved && !isHost) { setPending(saved); updateDraft(saved.text); } } catch { /* no pending request */ }
    void fetchSession(sessionId, auth).catch(err => setError(errorText(err))).finally(() => setLoaded(true));
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [fetchSession, updateDraft]);
  useEffect(() => {
    if (!id || !token || !session || (['completed', 'revoked', 'expired'].includes(session.invitation.status) && !session.feedback_processing)) return;
    const timer = window.setInterval(() => { if (!busyRef.current) void fetchSession(id, token).catch(err => setError(errorText(err))); }, 5000);
    return () => window.clearInterval(timer);
  }, [id, token, session?.invitation.status, session?.feedback_processing, fetchSession]); // eslint-disable-line react-hooks/exhaustive-deps
  // 自動スクロールは行わない(ユーザー要望)。会話ログは手動でスクロールする。
  function beforeQuestion() { abortSpeech(true); turnGeneration.current++; voiceReading.current = true; }
  function questionCompleted() {
    voiceReading.current = false;
    if (!automaticInput.current) return;
    const generation = turnGeneration.current; const questionId = live.current.questionId;
    void microphonePermission.current.then(allowed => {
      if (!allowed || !automaticInput.current || !alive.current || generation !== turnGeneration.current || live.current.questionId !== questionId || live.current.ended || live.current.processing || live.current.remaining === 0 || pendingRef.current || submitting.current || voiceReading.current) return;
      speech.start();
    });
  }
  const voice = useAiInterviewVoice({ sessionId: id, token, question: currentQuestion, providerAvailable: Boolean(session?.ai_available), active: session?.template.mode === 'ai' && !host && !ended && remaining !== 0, processing: busy || processing, onBeforePlayback: beforeQuestion, onPlaybackComplete: questionCompleted });
  voiceReading.current = voice.reading;
  useEffect(() => { abortSpeech(); }, [currentQuestion?.id, abortSpeech]);
  useEffect(() => { if (ended || remaining === 0 || processing) { turnGeneration.current++; abortSpeech(); } }, [ended, remaining, processing, abortSpeech]);
  useEffect(() => { if (speech.error) automaticInput.current = false; }, [speech.error]);
  function startInterview() { automaticInput.current = true; microphonePermission.current = speech.prepare(); voice.start(); }
  function textOnly() { automaticInput.current = false; turnGeneration.current++; abortSpeech(true); voice.textOnly(); }
  function stopQuestion() { automaticInput.current = false; turnGeneration.current++; abortSpeech(true); voice.stop(); voiceReading.current = false; }
  function replayQuestion() { automaticInput.current = true; microphonePermission.current = speech.prepare(); voice.replay(); }
  function toggleVoice() {
    if (voice.enabled) { automaticInput.current = false; turnGeneration.current++; abortSpeech(true); voiceReading.current = false; }
    else { automaticInput.current = true; microphonePermission.current = speech.prepare(); }
    voice.toggle();
  }
  async function retryMicrophone() {
    turnGeneration.current++; const generation = turnGeneration.current;
    voice.stop(); voiceReading.current = false; automaticInput.current = true;
    microphonePermission.current = speech.prepare();
    if (await microphonePermission.current && alive.current && generation === turnGeneration.current && !live.current.ended && !live.current.processing && live.current.remaining !== 0 && !pendingRef.current && !submitting.current) speech.start();
  }
  async function run(action: () => Promise<void>) { busyRef.current = true; setBusy(true); setError(''); try { await action(); } catch (err) { setError(errorText(err)); } finally { busyRef.current = false; setBusy(false); } }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!session || !currentQuestion || submitting.current || busyRef.current || processing || ended || voice.reading || (!pending && remaining === 0)) return;
    submitting.current = true; setFinishingAnswer(true); turnGeneration.current++; voice.stop();
    const expectedQuestion = currentQuestion.id;
    try {
      const finished = await speech.finish();
      if (!finished || !alive.current || live.current.ended || live.current.processing || (!pendingRef.current && (live.current.questionId !== expectedQuestion || live.current.remaining === 0))) return;
      const answer = pendingRef.current || { text: draftRef.current.trim(), request_id: newRequestId(), expected_turn_id: expectedQuestion };
      if (!answer.text) { setError('回答を確認できませんでした。もう一度話すか、文字を入力してください。'); if (automaticInput.current) speech.start(); return; }
      pendingRef.current = answer; setPending(answer); sessionStorage.setItem(`hiring_pending_${id}`, JSON.stringify(answer)); setFinishingAnswer(false);
      await run(async () => {
        try { const result = await hiringApi<InterviewSession>(`/session/${id}/answer`, token, answer); receive(result); pendingRef.current = null; setPending(null); updateDraft(''); sessionStorage.removeItem(`hiring_pending_${id}`); }
        catch (err) {
          if (err instanceof HiringError && (err.status === 409 || err.status === 422)) {
            const latest = await fetchSession(id, token);
            if (!latest.processing) { pendingRef.current = null; setPending(null); sessionStorage.removeItem(`hiring_pending_${id}`); const questionIndex = latest.transcript.findIndex(t => t.id === answer.expected_turn_id); if (questionIndex >= 0 && latest.transcript[questionIndex + 1]?.text === answer.text && latest.transcript[questionIndex + 1]?.role === 'candidate') updateDraft(''); }
          }
          throw err;
        }
      });
    } finally { submitting.current = false; if (alive.current) setFinishingAnswer(false); }
  }
  function finish() { if (submitting.current || !window.confirm('面接を終了しますか？送信していない回答は保存されません。終了後は回答を追加できません。')) return; turnGeneration.current++; abortSpeech(); voice.stop(); void run(async () => receive(await hiringApi<InterviewSession>(host ? `/invitations/${id}/finish` : `/session/${id}/finish`, token, {}))); }
  function refreshFeedback() {
    if (busyRef.current || session?.feedback_processing || session?.invitation.status !== 'completed') return;
    setRefreshingFeedback(true);
    void run(async () => receive(await hiringApi<InterviewSession>(`/session/${id}/feedback`, token, {}))).finally(() => setRefreshingFeedback(false));
  }
  const aiSource = currentQuestion?.source || session?.ai_source;
  return <main className={styles.shell}><div className={styles.container}>
    <header className={styles.header}><Link href="/" className={styles.brand}>VITAL ROOM / 採用面接</Link><div className={styles.row}>{host ? <Link href="/company" className={styles.button}>企業管理に戻る</Link> : <Link href="/interviews/join" className={styles.button}>参加画面に戻る</Link>}{token && id && <button className={styles.button} disabled={busy || finishingAnswer} onClick={() => void run(async () => { await fetchSession(id, token); })}>状態を更新</button>}</div></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!loaded ? <p className={styles.empty}>面接を読み込んでいます…</p> : !session ? <section className={styles.card}><h1 className={styles.title}>面接を開けませんでした</h1><p className={styles.subtitle}>上のメッセージを確認し、参加画面からやり直してください。通信の問題がある場合は「状態を更新」で再試行できます。</p></section> : <>
      <div className={styles.header}><div><p className={styles.eyebrow}>{host ? 'INTERVIEWER' : 'INTERVIEW SESSION'}</p><h1 className={styles.title}>{session.template.title}</h1><div className={styles.row}><span className={styles.badge}>{modeLabel(session.template.mode)}</span><span className={styles.badge}>{statusLabel(session.invitation)}</span><span className={styles.muted}>{session.invitation.candidate_name} さん ／ {session.template.job_title}</span></div></div>{remaining !== null && !ended && <div><p className={styles.muted}>残り時間</p><span className={styles.timer}>{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span></div>}</div>
      {session.invitation.status === 'waiting' && <p role="status" className={styles.notice}>{host ? '応募者が待機しています。準備ができたら入室を許可してください。' : '企業の担当者による入室許可を待っています。この画面でお待ちください。'}</p>}
      {host && session.template.mode === 'human' && session.invitation.status === 'waiting' && <button className={styles.primary} style={{ marginBottom: 24 }} disabled={busy} onClick={() => void run(async () => receive(await hiringApi<InterviewSession>(`/invitations/${id}/admit`, token, {})))}>応募者の入室を許可</button>}
      {ended && <section className={styles.card}><h2>{session.invitation.status === 'completed' ? '面接が終了しました' : session.invitation.status === 'revoked' ? 'この招待は取り消されました' : 'この招待の有効期限が切れました'}</h2><p className={styles.subtitle}>{session.invitation.status === 'completed' ? '送信済みの回答・発言は保存されました。ご参加ありがとうございました。' : '再度参加する場合は、企業の担当者へお問い合わせください。'}{!host && '選考に関する連絡は企業からの案内をお待ちください。'}</p>{host && <Link className={styles.primary} href={`/company/report?id=${encodeURIComponent(id)}`}>集計と担当者の判断を確認する</Link>}</section>}
      {session.invitation.status === 'completed' && !host && <InterviewFeedback feedback={session.feedback} processing={session.feedback_processing} busy={refreshingFeedback} onRefresh={refreshFeedback} />}
      <HiringVitalSummary session={session} />
      <div className={styles.sessionGrid} style={session.template.mode === 'human' || ended ? { gridTemplateColumns: 'minmax(0, 1fr)' } : undefined}>
        <div>{session.template.mode === 'human' && !ended && <HiringHumanRoom id={id} token={token} host={host} session={session} onSession={receive} />}
          {session.template.mode === 'ai' && !ended && !host && <section className={styles.card}><span className={styles.badge}>{aiSource === 'ai' ? 'AIが質問を作成' : aiSource === 'local' || !session.ai_available ? '回答に応じた質問（AI未使用）' : 'AI接続設定あり'}</span>
            {session.interview_progress && <p className={styles.muted} aria-label="面接の進行状況">主質問 {Math.min(session.interview_progress.question_index + 1, session.interview_progress.question_count)} / {session.interview_progress.question_count}{session.interview_progress.follow_up_depth > 0 ? ` ・ 深掘り ${session.interview_progress.follow_up_depth} / ${session.interview_progress.max_follow_ups}` : ' ・ 新しいテーマ'}<br />回答の内容と残り時間に応じて、追加の質問を行います。</p>}
            <AiInterviewer voice={voice} question={currentQuestion} processing={busy || processing || finishingAnswer} listening={speech.listening} disabled={remaining === 0 || Boolean(pending)} onStart={startInterview} onTextOnly={textOnly} onStop={stopQuestion} onReplay={replayQuestion} onToggleVoice={toggleVoice} />{aiSource === 'local' && <p className={styles.muted}>設定された質問に沿って、回答の中で詳しく確認したい点を追加で質問します。</p>}
            <hr className={styles.divider} />{processing && <p role="status" className={styles.notice}>回答を保存しました。次の質問を準備しています…</p>}<form className={styles.form} onSubmit={send}><label className={styles.field}>あなたの回答<textarea className={styles.textarea} rows={7} value={draft} readOnly={Boolean(pending)} disabled={busy || finishingAnswer} maxLength={6000} onChange={e => updateDraft(e.target.value)} placeholder="話した内容がここに表示されます。文字での入力・修正もできます。" /></label>
              {speech.interim && <p className={styles.notice} data-testid="ai-answer-interim" aria-live="polite">認識中：{speech.interim}</p>}
              {speech.preparing && <p className={styles.notice} role="status">マイクの利用許可を確認しています。ブラウザーの案内に従ってください。</p>}
              {speech.error && <p role="alert" className={styles.error}>{speech.error}</p>}
              <div className={styles.row}><button className={styles.primary} disabled={busy || processing || finishingAnswer || voice.reading || (!draft.trim() && !speech.interim.trim() && !speech.listening) || (!pending && (!currentQuestion || remaining === 0))}>{finishingAnswer ? '回答を確定しています…' : busy || processing ? '面接官が確認しています…' : pending ? '同じ回答の送信を再確認' : '回答を完了'}</button>{speech.error && speech.supported && <button type="button" className={styles.button} disabled={busy || finishingAnswer || !!pending || processing || remaining === 0 || voice.reading || speech.preparing} onClick={() => void retryMicrophone()}>音声入力を再試行</button>}</div>
              {pending && !busy && <p className={styles.notice}>送信の結果が確認できていません。同じ回答を再送して確認できます。重複して記録されることはありません。</p>}
              <p className={styles.muted}>質問が終わると音声入力が始まります。話し終えたら「回答を完了」を押すと保存され、次の質問へ進みます。文字で回答することもできます。音声入力ではブラウザーの音声認識サービスを利用する場合があります。{!speech.supported && 'このブラウザーでは音声入力に対応していません。文字で回答してください。'}</p>
            </form>
          </section>}
          {host && <section className={styles.card}><h2>面接の確認項目</h2><h3>質問</h3><ol className={styles.report}>{session.template.questions.map((q, n) => <li key={n}>{q}</li>)}</ol><h3>確認したい項目</h3><ul className={styles.report}>{session.template.criteria.map((c, n) => <li key={n}>{c}</li>)}</ul></section>}
          {!ended && (host || session.template.mode === 'ai') && <div className={styles.row}><button className={styles.danger} disabled={busy || finishingAnswer || Boolean(pending) || session.invitation.status !== 'in_progress'} onClick={finish}>面接を終了</button><p className={styles.muted}>終了すると、回答を追加できなくなります。</p></div>}
          {remaining === 0 && !ended && <p role="status" className={styles.notice}>面接時間が終了しました。保存状態を確認しています。</p>}
        </div>
        <section className={styles.card}><h2>保存された会話</h2><p className={styles.muted}>送信済みの発言は企業の担当者が確認できます。</p><div className={styles.transcript} aria-live="polite">{session.transcript.map(turn => <article id={`turn-${turn.id}`} key={turn.id} tabIndex={-1} className={`${styles.turn} ${turn.role === 'candidate' ? styles.candidate : ''}`}><span className={styles.muted}>{turn.role === 'candidate' ? '応募者' : session.template.mode === 'ai' ? 'AI面接官' : '面接官'} · {dateLabel(turn.created_at)}</span><p>{turn.text}</p></article>)}{!session.transcript.length && <p className={styles.empty}>まだ発言はありません。</p>}<div ref={transcriptEnd} /></div></section>
      </div>
    </>}
  </div></main>;
}
