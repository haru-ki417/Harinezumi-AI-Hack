'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { HIRING_API, Turn } from '@/lib/hiring';
import hiringStyles from './Hiring.module.css';
import styles from './AiInterviewer.module.css';

type VoicePhase = 'idle' | 'loading' | 'speaking' | 'blocked' | 'error';
type VoiceSource = 'ai' | 'browser' | null;
interface VoiceOptions {
  sessionId: string;
  token: string;
  question?: Turn;
  providerAvailable: boolean;
  active: boolean;
  processing: boolean;
  onBeforePlayback: () => void;
  onPlaybackComplete?: () => void;
}

/** Read only the current, saved interviewer question; never send candidate text for speech. */
export function useAiInterviewVoice({ sessionId, token, question, providerAvailable, active, processing, onBeforePlayback, onPlaybackComplete }: VoiceOptions) {
  const [enabled, setEnabled] = useState(true);
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [source, setSource] = useState<VoiceSource>(null);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voices = useRef<SpeechSynthesisVoice[]>([]);
  const lastQuestion = useRef('');
  const beforePlayback = useRef(onBeforePlayback);
  beforePlayback.current = onBeforePlayback;
  const playbackComplete = useRef(onPlaybackComplete);
  playbackComplete.current = onPlaybackComplete;

  const cancel = useCallback(() => {
    generation.current++;
    request.current?.abort(); request.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (player.current) {
      player.current.onplaying = null; player.current.onwaiting = null; player.current.onended = null; player.current.onerror = null;
      player.current.pause(); player.current.removeAttribute('src'); player.current.load(); player.current = null;
    }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    if (utterance.current) {
      utterance.current.onstart = null; utterance.current.onend = null; utterance.current.onerror = null;
      utterance.current = null;
      window.speechSynthesis?.cancel();
    }
  }, []);

  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return cancel;
    const updateVoices = () => { voices.current = synth.getVoices(); };
    updateVoices(); synth.addEventListener('voiceschanged', updateVoices);
    return () => { synth.removeEventListener('voiceschanged', updateVoices); cancel(); };
  }, [cancel]);

  const browserVoice = useCallback((text: string, current: number, fallback: boolean) => {
    if (current !== generation.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) {
      setPhase('error'); setSource(null);
      setMessage('この環境では音声を再生できません。下の質問文を読んで、回答を続けられます。');
      return;
    }
    setSource('browser');
    setMessage(fallback ? 'AI音声に接続できないため、ブラウザーの音声で質問を読み上げます。' : 'ブラウザーの音声で質問を読み上げます。');
    const line = new SpeechSynthesisUtterance(text);
    utterance.current = line;
    line.lang = 'ja-JP'; line.rate = 1; line.pitch = 1;
    const available = voices.current.length ? voices.current : synth.getVoices();
    const japanese = available.find(voice => /^ja(?:-|_)/i.test(voice.lang));
    if (japanese) line.voice = japanese;
    // Engines may populate voices only when first asked to speak. In that case
    // let the language setting select a voice and handle the engine's error.
    else if (available.length) {
      setPhase('error');
      setMessage('日本語の読み上げ音声が見つかりません。端末の日本語音声を有効にするか、質問文を読んで回答してください。');
      return;
    }
    let began = false; let completed = false; let failed = false;
    line.onstart = () => {
      if (current !== generation.current || failed) return;
      began = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null; setPhase('speaking');
    };
    line.onend = () => {
      if (current !== generation.current || failed) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null; utterance.current = null; setPhase('idle');
      if (began && !completed) { completed = true; playbackComplete.current?.(); }
    };
    line.onerror = event => {
      if (current !== generation.current) return;
      failed = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setPhase(event.error === 'not-allowed' ? 'blocked' : 'error');
      setMessage(event.error === 'not-allowed' ? '音声を再生するには「音声を再生」を押してください。' : '読み上げを開始できませんでした。「もう一度聞く」で再試行するか、質問文を読んで回答してください。');
    };
    beforePlayback.current(); setPhase('loading');
    timer.current = setTimeout(() => {
      if (current !== generation.current) return;
      // Some browsers silently ignore speech without a fresh user gesture.
      line.onstart = null; line.onend = null; line.onerror = null; synth.cancel();
      setPhase('blocked'); setMessage('音声を再生するには「音声を再生」を押してください。');
    }, 8000);
    try { synth.cancel(); synth.speak(line); }
    catch {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null; setPhase('error');
      setMessage('読み上げを開始できませんでした。質問文を読んで回答を続けられます。');
    }
  }, []);

  const playAudio = useCallback((audio: HTMLAudioElement, current: number, text: string) => {
    if (current !== generation.current) return;
    beforePlayback.current(); setPhase('loading');
    let began = false; let completed = false;
    audio.onplaying = () => { if (current === generation.current) { began = true; setPhase('speaking'); } };
    audio.onwaiting = () => { if (current === generation.current) setPhase('loading'); };
    audio.onended = () => { if (current === generation.current) { setPhase('idle'); if (began && !completed) { completed = true; playbackComplete.current?.(); } } };
    let fallbackUsed = false;
    const fallback = () => {
      if (current !== generation.current || fallbackUsed) return;
      fallbackUsed = true;
      audio.onplaying = null; audio.onwaiting = null; audio.onended = null; audio.onerror = null;
      audio.pause();
      browserVoice(text, current, true);
    };
    audio.onerror = fallback;
    void audio.play().catch((error: unknown) => {
      if (current !== generation.current) return;
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        setPhase('blocked'); setMessage('音声を再生するには「音声を再生」を押してください。');
      } else fallback();
    });
  }, [browserVoice]);

  const speak = useCallback(() => {
    if (!question || !active || processing) return;
    cancel();
    const current = generation.current;
    const text = question.text;
    lastQuestion.current = `${sessionId}:${question.id}`;
    beforePlayback.current(); setPhase('loading'); setMessage(''); setSource(null);
    if (!providerAvailable) { browserVoice(text, current, false); return; }
    const controller = new AbortController(); request.current = controller;
    timer.current = setTimeout(() => controller.abort(), 25000);
    void (async () => {
      try {
        const response = await fetch(`${HIRING_API}/api/hiring/session/${encodeURIComponent(sessionId)}/speech`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ turn_id: question.id }), signal: controller.signal, cache: 'no-store',
        });
        if (current !== generation.current) return;
        if (!response.ok) {
          // A stale/ended question or revoked authorization must not be read.
          if ([400, 401, 403, 404, 409, 410, 422].includes(response.status)) {
            setPhase('error'); setMessage('この質問の音声を再生できません。面接の状態を更新してください。');
            return;
          }
          throw new Error('Speech temporarily unavailable');
        }
        const blob = await response.blob();
        if (current !== generation.current) return;
        if (!blob.size || !blob.type.startsWith('audio/')) throw new Error('Invalid audio');
        objectUrl.current = URL.createObjectURL(blob);
        const audio = new Audio(objectUrl.current); player.current = audio;
        audio.preload = 'auto'; setSource('ai');
        playAudio(audio, current, text);
      } catch {
        if (current === generation.current) browserVoice(text, current, true);
      } finally {
        if (current === generation.current) {
          request.current = null;
          if (timer.current && !utterance.current) { clearTimeout(timer.current); timer.current = null; }
        }
      }
    })();
  }, [active, browserVoice, cancel, playAudio, processing, providerAvailable, question?.id, question?.text, sessionId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active || processing || !enabled || !question) { cancel(); setPhase('idle'); return; }
    if (started && question && lastQuestion.current !== `${sessionId}:${question.id}`) speak();
  }, [active, processing, enabled, started, question?.id, sessionId, speak, cancel]); // eslint-disable-line react-hooks/exhaustive-deps

  const stop = useCallback(() => { cancel(); setPhase('idle'); setMessage(''); }, [cancel]);
  const start = () => { setEnabled(true); setStarted(true); speak(); };
  const replay = () => {
    if (!active || processing || !question) return;
    setEnabled(true); setStarted(true);
    if (player.current && source === 'ai') {
      player.current.currentTime = 0;
      setMessage(''); playAudio(player.current, generation.current, question.text);
    } else speak();
  };
  const toggle = () => {
    if (enabled) { setEnabled(false); stop(); }
    else { setEnabled(true); setStarted(true); speak(); }
  };
  const textOnly = () => { setStarted(true); setEnabled(false); stop(); };
  return { enabled, started, phase, source, message, start, replay, stop, toggle, textOnly, reading: phase === 'loading' || phase === 'speaking' };
}

export function AiInterviewer({ voice, question, processing, listening, disabled = false, onStart, onTextOnly, onReplay, onStop, onToggleVoice }: {
  voice: ReturnType<typeof useAiInterviewVoice>;
  question?: Turn;
  processing: boolean;
  listening: boolean;
  disabled?: boolean;
  onStart?: () => void;
  onTextOnly?: () => void;
  onReplay?: () => void;
  onStop?: () => void;
  onToggleVoice?: () => void;
}) {
  const state = processing ? 'processing' : voice.phase !== 'idle' ? voice.phase : listening ? 'listening' : !voice.started ? 'ready' : !voice.enabled ? 'muted' : 'waiting';
  const labels = {
    ready: '音声面接の準備ができました', loading: '音声を準備中', speaking: '質問中',
    processing: '回答を確認中', listening: 'あなたの回答を聞いています', waiting: '回答をお待ちしています',
    muted: '音声オフ・文字で回答できます', error: '質問文を読んで回答できます', blocked: '音声の再生をお待ちしています',
  };
  return <div className={styles.interviewer} data-testid="ai-interviewer" data-state={state}>
    <div className={styles.stage}>
      <div className={styles.avatar} aria-hidden="true"><div className={styles.orbit} /><div className={styles.face}><span /><span /></div></div>
      <p className={styles.name}>AI面接官</p>
      <div className={styles.wave} aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index} />)}</div>
      <p className={styles.status} role="status" aria-live="polite">{labels[state]}</p>
      <p className={styles.hint}>{state === 'speaking' ? '質問が終わるとマイクが自動でオンになります。' : state === 'processing' ? '回答をもとに次の質問を準備しています。' : state === 'listening' ? '話し終えたら「回答を完了」を押してください。' : state === 'muted' ? '質問を読み、文字を入力して「回答を完了」を押してください。' : '開始後は質問を聞いて話し、「回答を完了」を押すだけで進みます。'}</p>
    </div>
    <div className={styles.question}><h2>面接官からの質問</h2><p>{question?.text || '質問を準備しています…'}</p></div>
    <div className={hiringStyles.row}>
      {!voice.started ? <><button type="button" className={hiringStyles.primary} disabled={disabled || processing || !question} onClick={onStart || voice.start}>面接を開始</button><button type="button" className={hiringStyles.button} onClick={onTextOnly || voice.textOnly}>文字で続ける</button></> : <>
        {voice.enabled && <button type="button" className={hiringStyles.button} disabled={disabled || processing || !question} onClick={voice.reading ? onStop || voice.stop : onReplay || voice.replay}>{voice.reading ? '読み上げを停止' : voice.phase === 'blocked' ? '音声を再生' : 'もう一度聞く'}</button>}
        <button type="button" className={hiringStyles.button} aria-pressed={voice.enabled} disabled={disabled || processing} onClick={onToggleVoice || voice.toggle}>{voice.enabled ? '音声をオフ' : '音声をオン'}</button>
      </>}
    </div>
    <p className={styles.disclosure}>{voice.source === 'browser' ? '質問音声：ブラウザーの読み上げ' : voice.source === 'ai' ? '質問音声はAIによる合成音声です。' : '質問は合成音声で読み上げます。'}</p>
    {voice.message && <p className={hiringStyles.notice} role="status">{voice.message}</p>}
  </div>;
}
