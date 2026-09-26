'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionResult { isFinal: boolean; [index: number]: { transcript: string } }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { resultIndex: number; results: { length: number; [index: number]: RecognitionResult } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
const recognitionConstructor = () => {
  const browser = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return browser.SpeechRecognition || browser.webkitSpeechRecognition;
};

/** An answering turn can span multiple browser recognition sessions. */
export function useAiInterviewRecognition(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const callback = useRef(onText); callback.current = onText;
  const alive = useRef(false);
  const desired = useRef(false);
  const recognition = useRef<Recognition | null>(null);
  const generation = useRef(0);
  const permissionGeneration = useRef(0);
  const permission = useRef<Promise<boolean> | null>(null);
  const granted = useRef(false);
  const fragments = useRef(new Map<number, { text: string; final: boolean }>());
  const delivered = useRef(new Set<number>());
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishing = useRef<Promise<boolean> | null>(null);
  const finishResolve = useRef<((ok: boolean) => void) | null>(null);
  const launchRef = useRef<() => void>(() => undefined);

  const clearTimers = useCallback(() => {
    if (restartTimer.current) clearTimeout(restartTimer.current);
    if (finishTimer.current) clearTimeout(finishTimer.current);
    restartTimer.current = null; finishTimer.current = null;
  }, []);
  const settle = useCallback((ok: boolean) => {
    if (finishTimer.current) clearTimeout(finishTimer.current);
    finishTimer.current = null;
    const resolve = finishResolve.current; finishResolve.current = null; finishing.current = null;
    resolve?.(ok);
  }, []);
  const flushInterim = useCallback(() => {
    const text = [...fragments.current.entries()].sort(([a], [b]) => a - b)
      .filter(([index]) => !delivered.current.has(index)).map(([, result]) => result.text).filter(Boolean).join(' ');
    fragments.current.clear(); delivered.current.clear();
    if (text) callback.current(text);
    if (alive.current) setInterim('');
  }, []);
  const detach = (rec: Recognition) => { rec.onstart = null; rec.onresult = null; rec.onerror = null; rec.onend = null; };
  const abort = useCallback((preserveInterim = false) => {
    desired.current = false; generation.current++; clearTimers();
    const rec = recognition.current; recognition.current = null;
    if (rec) { detach(rec); try { rec.abort(); } catch { /* already stopped */ } }
    if (preserveInterim) flushInterim();
    fragments.current.clear(); delivered.current.clear(); settle(false);
    if (alive.current) { setListening(false); setInterim(''); }
  }, [clearTimers, flushInterim, settle]);
  const invalidatePermission = useCallback(() => { permissionGeneration.current++; }, []);

  useEffect(() => {
    alive.current = true; setSupported(Boolean(recognitionConstructor()));
    return () => { alive.current = false; invalidatePermission(); abort(); };
  }, [abort, invalidatePermission]);

  // Request microphone permission from the initial click. The temporary stream
  // is immediately released; only SpeechRecognition listens during answers.
  const prepare = useCallback((): Promise<boolean> => {
    if (!recognitionConstructor()) {
      setError('このブラウザーでは音声入力を利用できません。文字を入力して「回答を完了」を押してください。');
      return Promise.resolve(false);
    }
    if (granted.current) return Promise.resolve(true);
    if (permission.current) return permission.current;
    const attempt = ++permissionGeneration.current;
    setPreparing(true); setError('');
    const pending = (async () => {
      try {
        if (navigator.mediaDevices?.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop());
        }
        if (!alive.current || attempt !== permissionGeneration.current) return false;
        granted.current = true; return true;
      } catch {
        if (alive.current && attempt === permissionGeneration.current) setError('マイクを利用できません。ブラウザーのマイク権限を確認するか、文字を入力して「回答を完了」を押してください。');
        return false;
      } finally {
        if (attempt === permissionGeneration.current) { permission.current = null; if (alive.current) setPreparing(false); }
      }
    })();
    permission.current = pending;
    return pending;
  }, []);

  const launch = useCallback(() => {
    if (!desired.current || !alive.current || recognition.current) return;
    const Constructor = recognitionConstructor();
    if (!Constructor) return;
    const rec = new Constructor(); const current = ++generation.current;
    recognition.current = rec; fragments.current.clear(); delivered.current.clear();
    rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
    rec.onstart = () => { if (current === generation.current && alive.current) setListening(true); };
    rec.onresult = event => {
      if (current !== generation.current || !alive.current) return;
      for (const index of fragments.current.keys()) if (index >= event.results.length && !delivered.current.has(index)) fragments.current.delete(index);
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]; const text = result[0]?.transcript.trim() || '';
        fragments.current.set(index, { text, final: result.isFinal });
        if (result.isFinal && !delivered.current.has(index)) {
          delivered.current.add(index); if (text) callback.current(text);
        }
      }
      setInterim([...fragments.current.entries()].sort(([a], [b]) => a - b)
        .filter(([index, result]) => !result.final && !delivered.current.has(index)).map(([, result]) => result.text).filter(Boolean).join(' '));
    };
    rec.onerror = event => {
      if (current !== generation.current || !alive.current) return;
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      desired.current = false; granted.current = false; setListening(false);
      setError(['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)
        ? 'マイクを利用できません。ブラウザーのマイク権限を確認するか、文字を入力して「回答を完了」を押してください。'
        : '音声入力が中断されました。再試行するか、文字を入力して「回答を完了」を押してください。');
      flushInterim();
      recognition.current = null; detach(rec); try { rec.abort(); } catch { /* already ended */ }
      settle(true);
    };
    rec.onend = () => {
      if (current !== generation.current || !alive.current) return;
      recognition.current = null; detach(rec); setListening(false); flushInterim();
      if (!desired.current) { settle(true); return; }
      // Browser engines end after silence or their own time limit. Resume the
      // same answer, without asking the applicant to turn their microphone on.
      restartTimer.current = setTimeout(() => { restartTimer.current = null; launchRef.current(); }, 180);
    };
    try { rec.start(); }
    catch {
      recognition.current = null; detach(rec); desired.current = false; setListening(false);
      setError('音声入力を開始できませんでした。再試行するか、文字で回答してください。'); settle(true);
    }
  }, [flushInterim, settle]);
  launchRef.current = launch;

  const start = useCallback(() => {
    if (!alive.current || !recognitionConstructor()) return;
    desired.current = true; setError(''); launch();
  }, [launch]);
  const finish = useCallback((): Promise<boolean> => {
    if (finishing.current) return finishing.current;
    desired.current = false;
    if (restartTimer.current) clearTimeout(restartTimer.current);
    restartTimer.current = null;
    const rec = recognition.current;
    if (!rec) { flushInterim(); return Promise.resolve(true); }
    const done = new Promise<boolean>(resolve => { finishResolve.current = resolve; });
    finishing.current = done;
    // stop() requests a final result; abort() would discard trailing speech.
    finishTimer.current = setTimeout(() => {
      if (recognition.current !== rec) return;
      flushInterim(); recognition.current = null; generation.current++; detach(rec);
      try { rec.abort(); } catch { /* no active engine */ }
      if (alive.current) setListening(false); settle(true);
    }, 1800);
    try { rec.stop(); } catch { flushInterim(); abort(); return Promise.resolve(true); }
    return done;
  }, [abort, flushInterim, settle]);

  return { supported, listening, preparing, interim, error, prepare, start, finish, abort };
}
