'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { newRequestId } from '@/lib/hiring';
import { useAiInterviewRecognition } from './useAiInterviewRecognition';

type Fragment = { text: string; request_id: string };
export function useHumanTranscription({ id, host, socket, active, microphone }: {
  id: string; host: boolean; socket: RefObject<WebSocket | null>; active: boolean; microphone: boolean;
}) {
  const key = `hiring_transcription_${id}_${host ? 'host' : 'candidate'}`;
  const queue = useRef<Fragment[]>([]);
  const [count, setCount] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState('');
  const activeRef = useRef(active); activeRef.current = active;
  const enabledRef = useRef(false);
  const attempt = useRef(0);
  const lastSent = useRef(0);
  const persist = useCallback(() => {
    setCount(queue.current.length);
    try { sessionStorage.setItem(key, JSON.stringify(queue.current)); }
    catch { setError('文字起こしの一時保存ができません。この画面を閉じずに接続を確認してください。'); }
  }, [key]);
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(key) || '[]');
      queue.current = Array.isArray(stored) ? stored.filter(p => p && typeof p.text === 'string' && p.text.length <= 6000 && typeof p.request_id === 'string').slice(0, 100) : [];
      setCount(queue.current.length);
    } catch { queue.current = []; }
  }, [key]);
  const speech = useAiInterviewRecognition(text => {
    if (!activeRef.current || !enabledRef.current || !text.trim()) return;
    const pieces = text.match(/[\s\S]{1,6000}/g) || [];
    if (queue.current.length + pieces.length > 100) {
      enabledRef.current = false; setEnabled(false);
      setError('未保存の発言が多いため文字起こしを停止しました。接続を確認し、未保存の内容を保存してください。');
      return;
    }
    queue.current.push(...pieces.map(text => ({ text, request_id: newRequestId() })));
    persist();
  });
  const { abort, finish } = speech;
  useEffect(() => {
    if (!active || !microphone || !enabled) {
      attempt.current++;
      // Finishing while muted preserves trailing speech; a completed interview
      // no longer accepts turns. Never continue recording after either change.
      abort(active && enabledRef.current);
      enabledRef.current = false; setEnabled(false);
    }
  }, [active, microphone, enabled, abort]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!activeRef.current || !queue.current.length || socket.current?.readyState !== WebSocket.OPEN || Date.now() - lastSent.current < 4000) return;
      socket.current.send(JSON.stringify({ type: 'transcript', ...queue.current[0] }));
      lastSent.current = Date.now();
    }, 300);
    return () => window.clearInterval(timer);
  }, [socket]);
  const receive = useCallback((message: { type?: string; request_id?: string; status?: number; message?: string }) => {
    if (!queue.current.length || message.request_id !== queue.current[0].request_id) return;
    if (message.type === 'transcript_saved') {
      queue.current.shift(); lastSent.current = 0; persist();
    } else if (message.type === 'error' && [403, 409, 413, 422].includes(message.status || 0)) {
      enabledRef.current = false; setEnabled(false); lastSent.current = Number.POSITIVE_INFINITY;
      setError(message.message || '発言を保存できません。未保存の内容を確認してください。');
    }
  }, [persist]);
  async function toggle() {
    if (enabledRef.current) {
      await finish(); enabledRef.current = false; setEnabled(false); return;
    }
    const current = ++attempt.current;
    setError('');
    if (await speech.prepare() && current === attempt.current && activeRef.current && microphone) {
      enabledRef.current = true; setEnabled(true); lastSent.current = 0; speech.start();
    }
  }
  return { supported: speech.supported, enabled, listening: speech.listening, preparing: speech.preparing,
    interim: speech.interim, error: error || speech.error.replaceAll('回答を完了', '発言を保存'), count, toggle, receive,
    unsaved: queue.current.map(p => p.text).join('\n') };
}
