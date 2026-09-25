import { useCallback, useEffect, useRef, useState } from 'react';
import type { Role, RoomConnection } from '@/types';

export interface ChatMessage {
  id: string;
  request_id: string;
  sender_id: string;
  name: string;
  role: Role;
  text: string;
  sent_at: string;
}

export const CHAT_MAX_LENGTH = 2000;
const HISTORY_LIMIT = 100;
const WS_BASE = process.env.NEXT_PUBLIC_WS_BASE_URL || 'ws://localhost:8000';

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as ChatMessage;
  return ['id', 'request_id', 'sender_id', 'name', 'text', 'sent_at'].every((key) =>
    typeof m[key as keyof ChatMessage] === 'string') && Number.isFinite(Date.parse(m.sent_at));
}

export function useRoomChat({ roomId, name, role, active }: {
  roomId: string; name: string; role: Role; active: boolean;
}) {
  const [connection, setConnection] = useState<RoomConnection>('idle');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const pendingRef = useRef<{ id: string; finish: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    if (!active) { setMessages([]); setSelfId(null); setConnection('idle'); setError(''); return; }
    let disposed = false;
    let clientId: string | null = null;
    readyRef.current = false;
    setConnection('connecting');
    setError('');
    setMessages([]);
    setSelfId(null);
    let ws: WebSocket;
    try { ws = new WebSocket(`${WS_BASE}/ws/chat/${encodeURIComponent(roomId)}`); }
    catch { setConnection('error'); setError('チャットの接続先を確認してください。'); return; }
    wsRef.current = ws;
    const timer = window.setTimeout(() => {
      if (!readyRef.current && !disposed) {
        setError('チャットに接続できません。再接続してください。');
        ws.close();
      }
    }, 15000);
    ws.onopen = () => {
      if (!disposed) ws.send(JSON.stringify({ type: 'join', name, role, consent: true }));
    };
    ws.onmessage = (event) => {
      if (disposed) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'chat_joined' && typeof data.client_id === 'string') {
          clientId = data.client_id;
          setSelfId(clientId);
          setMessages(Array.isArray(data.messages) ? data.messages.filter(isMessage).slice(-HISTORY_LIMIT) : []);
          readyRef.current = true;
          setConnection('open');
          window.clearTimeout(timer);
        } else if (data.type === 'chat_message' && isMessage(data.message)) {
          const message = data.message;
          setMessages((prev) => prev.some((m) => m.id === message.id) ? prev : [...prev, message].slice(-HISTORY_LIMIT));
          if (message.sender_id === clientId && message.request_id === pendingRef.current?.id) {
            pendingRef.current?.finish(true);
          }
        } else if (data.type === 'chat_error') {
          setError(data.reason === 'invalid_message' ? 'メッセージは空白以外の1〜2000文字で入力してください。' : 'チャットへの接続を確認してください。');
          if (!data.request_id || data.request_id === pendingRef.current?.id) pendingRef.current?.finish(false);
        }
      } catch { /* 不正な応答は表示しない。 */ }
    };
    ws.onerror = () => { if (!disposed) setError('チャットに接続できません。バックエンドの起動を確認してください。'); };
    ws.onclose = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      readyRef.current = false;
      pendingRef.current?.finish(false);
      setConnection('error');
      setError((current) => current || 'チャットの接続が切れました。再接続してください。');
    };
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      readyRef.current = false;
      pendingRef.current?.finish(false);
      wsRef.current = null;
      ws.close();
    };
  }, [active, roomId, name, role, attempt]);

  const sendMessage = useCallback((text: string): Promise<boolean> => {
    const ws = wsRef.current;
    if (!text.trim() || Array.from(text).length > CHAT_MAX_LENGTH) {
      setError('メッセージは空白以外の1〜2000文字で入力してください。');
      return Promise.resolve(false);
    }
    if (!ws || ws.readyState !== WebSocket.OPEN || !readyRef.current || pendingRef.current) return Promise.resolve(false);
    setError('');
    setSending(true);
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        setError('送信完了を確認できませんでした。履歴を確認してから再送してください。');
        pendingRef.current?.finish(false);
      }, 10000);
      const finish = (ok: boolean) => {
        window.clearTimeout(timeout);
        pendingRef.current = null;
        setSending(false);
        resolve(ok);
      };
      pendingRef.current = { id, finish };
      try { ws.send(JSON.stringify({ type: 'chat', request_id: id, text })); }
      catch { setError('送信できませんでした。接続を確認してください。'); finish(false); }
    });
  }, []);

  return { connection, messages, selfId, error, sending, sendMessage,
    reconnect: useCallback(() => setAttempt((n) => n + 1), []) };
}
