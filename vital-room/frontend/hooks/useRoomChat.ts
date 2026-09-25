import { useCallback, useEffect, useRef, useState } from 'react';
import type { Role, RoomConnection } from '@/types';

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  content_type: string;
}

export interface ChatMessage {
  id: string;
  request_id: string;
  sender_id: string;
  name: string;
  role: Role;
  text: string;
  sent_at: string;
  attachments?: ChatAttachment[];
}

export const CHAT_MAX_LENGTH = 2000;
export const CHAT_MAX_FILES = 5;
export const CHAT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const HISTORY_LIMIT = 100;
const FILE_TIMEOUT = 60000;
const WS_BASE = (process.env.NEXT_PUBLIC_WS_BASE_URL || 'ws://localhost:8000').replace(/\/+$/, '');
const HTTP_BASE = WS_BASE.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');

interface ChatSession {
  ws: WebSocket;
  roomId: string;
  name: string;
  role: Role;
  attempt: number;
  ready: boolean;
  token: string;
  requests: Set<AbortController>;
}

function isAttachment(value: unknown): value is ChatAttachment {
  if (!value || typeof value !== 'object') return false;
  const attachment = value as ChatAttachment;
  return typeof attachment.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(attachment.id)
    && typeof attachment.name === 'string' && attachment.name.length > 0 && attachment.name.length <= 1024
    && Number.isSafeInteger(attachment.size) && attachment.size > 0 && attachment.size <= CHAT_MAX_FILE_SIZE
    && typeof attachment.content_type === 'string'
    && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(attachment.content_type)
    && attachment.content_type.length <= 128;
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as ChatMessage;
  return ['id', 'request_id', 'sender_id', 'name', 'text', 'sent_at'].every((key) =>
    typeof message[key as keyof ChatMessage] === 'string') && Number.isFinite(Date.parse(message.sent_at))
    && (message.attachments === undefined || (Array.isArray(message.attachments)
      && message.attachments.length <= CHAT_MAX_FILES && message.attachments.every(isAttachment)));
}

function chatError(reason: unknown, fallback = 'チャットへの接続を確認してください。'): string {
  switch (reason) {
    case 'invalid_message': return 'メッセージは2000文字以内で入力するか、ファイルを添付してください。';
    case 'file_too_large': return 'ファイルは1件10 MB以内で添付してください。';
    case 'room_storage_full': return 'このルームのファイル保存容量が上限に達しています。';
    case 'storage_full': return 'ファイル保存容量が上限に達しています。時間をおいて再送してください。';
    case 'too_many_attachments': return '添付ファイルが上限に達しています。時間をおいて再送してください。';
    case 'upload_interrupted': return 'ファイルの送信が中断されました。接続を確認して再送してください。';
    case 'invalid_file': return 'ファイルを読み取れませんでした。別のファイルを選択してください。';
    case 'invalid_session': return 'チャットの接続が切れました。再接続してから操作してください。';
    case 'invalid_attachment': return '添付ファイルを確認できませんでした。ファイルを選び直して再送してください。';
    default: return fallback;
  }
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  let reason: unknown;
  try { reason = (await response.json()).detail; } catch { /* 応答本文がない場合は共通の説明を使う。 */ }
  return new Error(chatError(reason, fallback));
}

function attachmentEndpoint(session: ChatSession, id?: string): string {
  return `${HTTP_BASE}/api/chat/${encodeURIComponent(session.roomId)}/attachments${id ? `/${encodeURIComponent(id)}` : ''}`;
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
  const sessionRef = useRef<ChatSession | null>(null);
  const pendingRef = useRef<{ id: string; finish: (ok: boolean) => void } | null>(null);

  useEffect(() => {
    if (!active) { setMessages([]); setSelfId(null); setConnection('idle'); setError(''); return; }
    let disposed = false;
    let clientId: string | null = null;
    setConnection('connecting');
    setError('');
    setMessages([]);
    setSelfId(null);
    let ws: WebSocket;
    try { ws = new WebSocket(`${WS_BASE}/ws/chat/${encodeURIComponent(roomId)}`); }
    catch { setConnection('error'); setError('チャットの接続先を確認してください。'); return; }
    const session: ChatSession = { ws, roomId, name, role, attempt, ready: false, token: '', requests: new Set() };
    sessionRef.current = session;
    const cancelSession = () => {
      session.ready = false;
      session.token = '';
      pendingRef.current?.finish(false);
      for (const request of session.requests) request.abort();
      session.requests.clear();
    };
    const timer = window.setTimeout(() => {
      if (!session.ready && !disposed) {
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
          session.token = typeof data.upload_token === 'string' ? data.upload_token : '';
          session.ready = true;
          setSelfId(clientId);
          setMessages(Array.isArray(data.messages) ? data.messages.filter(isMessage).slice(-HISTORY_LIMIT) : []);
          setConnection('open');
          window.clearTimeout(timer);
        } else if (data.type === 'chat_message' && isMessage(data.message)) {
          const message = data.message;
          setMessages((prev) => prev.some((item) => item.id === message.id) ? prev : [...prev, message].slice(-HISTORY_LIMIT));
          if (message.sender_id === clientId && message.request_id === pendingRef.current?.id) {
            pendingRef.current?.finish(true);
          }
        } else if (data.type === 'chat_error') {
          setError(chatError(data.reason));
          if (!data.request_id || data.request_id === pendingRef.current?.id) pendingRef.current?.finish(false);
        }
      } catch { /* 不正な応答は表示しない。 */ }
    };
    ws.onerror = () => { if (!disposed) setError('チャットに接続できません。バックエンドの起動を確認してください。'); };
    ws.onclose = () => {
      if (disposed) return;
      window.clearTimeout(timer);
      cancelSession();
      setConnection('error');
      setError((current) => current || 'チャットの接続が切れました。再接続してください。');
    };
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      cancelSession();
      if (sessionRef.current === session) sessionRef.current = null;
      ws.close();
    };
  }, [active, roomId, name, role, attempt]);

  const sendMessage = useCallback((text: string, files: File[] = []): Promise<boolean> => {
    const session = sessionRef.current;
    if ((!text.trim() && files.length === 0) || Array.from(text).length > CHAT_MAX_LENGTH) {
      setError(chatError('invalid_message'));
      return Promise.resolve(false);
    }
    if (files.length > CHAT_MAX_FILES) {
      setError('ファイルは1回に5件まで添付できます。');
      return Promise.resolve(false);
    }
    if (files.some((file) => file.size > CHAT_MAX_FILE_SIZE || file.size === 0)) {
      setError(files.some((file) => file.size === 0) ? '空のファイルは添付できません。' : chatError('file_too_large'));
      return Promise.resolve(false);
    }
    if (!active || !session || session.roomId !== roomId || session.name !== name || session.role !== role
      || session.attempt !== attempt || !session.ready || session.ws.readyState !== WebSocket.OPEN || pendingRef.current) {
      return Promise.resolve(false);
    }
    if (files.length && !session.token) {
      setError(chatError('invalid_session'));
      return Promise.resolve(false);
    }
    setError('');
    setSending(true);
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const uploaded: string[] = [];
      let finished = false;
      let timedOut = false;
      let timeout: number | undefined;
      const isCurrent = () => sessionRef.current === session && session.ready && session.ws.readyState === WebSocket.OPEN;
      const cleanupUploads = async () => {
        if (!isCurrent() || !session.token) return;
        const cleanupController = new AbortController();
        session.requests.add(cleanupController);
        const cleanupTimer = window.setTimeout(() => cleanupController.abort(), 10000);
        try {
          await Promise.allSettled(uploaded.map((attachmentId) => fetch(attachmentEndpoint(session, attachmentId), {
            method: 'DELETE', headers: { Authorization: `Bearer ${session.token}` }, signal: cleanupController.signal,
          })));
        } finally {
          window.clearTimeout(cleanupTimer);
          session.requests.delete(cleanupController);
        }
      };
      const pending = { id, finish: (ok: boolean) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timeout);
        controller.abort();
        session.requests.delete(controller);
        if (pendingRef.current === pending) { pendingRef.current = null; setSending(false); }
        if (!ok && uploaded.length) void cleanupUploads();
        resolve(ok);
      } };
      pendingRef.current = pending;
      session.requests.add(controller);
      void (async () => {
        try {
          for (const file of files) {
            timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, FILE_TIMEOUT);
            const response = await fetch(attachmentEndpoint(session), {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${session.token}`,
                'X-Filename': encodeURIComponent(file.name),
                'Content-Type': file.type || 'application/octet-stream',
              },
              body: file,
              signal: controller.signal,
            });
            if (!response.ok) throw await responseError(response, 'ファイルを送信できませんでした。接続を確認して再送してください。');
            const attachment: unknown = await response.json();
            if (!isAttachment(attachment)) throw new Error('ファイルの送信結果を確認できませんでした。');
            uploaded.push(attachment.id);
            window.clearTimeout(timeout);
            if (finished || !isCurrent()) { pending.finish(false); return; }
          }
          if (finished || !isCurrent()) { pending.finish(false); return; }
          timeout = window.setTimeout(() => {
            if (isCurrent()) setError('送信完了を確認できませんでした。履歴を確認してから再送してください。');
            pending.finish(false);
          }, 10000);
          session.ws.send(JSON.stringify({ type: 'chat', request_id: id, text, attachment_ids: uploaded }));
        } catch (cause) {
          if (!finished && isCurrent()) {
            setError(timedOut ? 'ファイルの送信がタイムアウトしました。接続を確認して再送してください。'
              : cause instanceof Error && cause.name === 'Error' ? cause.message : '送信できませんでした。接続を確認してください。');
          }
          pending.finish(false);
        }
      })();
    });
  }, [active, roomId, name, role, attempt]);

  const getAttachmentBlob = useCallback(async (attachment: ChatAttachment, signal?: AbortSignal): Promise<Blob> => {
    if (!isAttachment(attachment)) throw new Error(chatError('invalid_attachment'));
    const session = sessionRef.current;
    if (!active || !selfId || !session || session.roomId !== roomId || session.name !== name || session.role !== role
      || session.attempt !== attempt || !session.ready || !session.token) throw new Error(chatError('invalid_session'));
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    session.requests.add(controller);
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, FILE_TIMEOUT);
    try {
      const response = await fetch(attachmentEndpoint(session, attachment.id), {
        headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal,
      });
      if (!response.ok) throw await responseError(response, 'ファイルを取得できませんでした。再接続してからお試しください。');
      const blob = await response.blob();
      if (controller.signal.aborted || sessionRef.current !== session || !session.ready) throw new Error(chatError('invalid_session'));
      return blob;
    } catch (cause) {
      if (timedOut) throw new Error('ファイルの取得がタイムアウトしました。もう一度お試しください。');
      if (cause instanceof Error && cause.name === 'Error') throw cause;
      throw new Error(controller.signal.aborted ? 'ファイルの取得を中断しました。' : 'ファイルを取得できませんでした。接続を確認してください。');
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      session.requests.delete(controller);
    }
  }, [active, roomId, name, role, attempt, selfId]);

  return { connection, messages, selfId, error, sending, sendMessage, getAttachmentBlob,
    reconnect: useCallback(() => setAttempt((value) => value + 1), []) };
}
