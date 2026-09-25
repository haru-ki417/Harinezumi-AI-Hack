'use client';

import { useEffect, useRef, useState } from 'react';
import { CHAT_MAX_LENGTH, type useRoomChat } from '@/hooks/useRoomChat';
import styles from './RoomChat.module.css';

export function RoomChat({ chat, roomId }: { chat: ReturnType<typeof useRoomChat>; roomId: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const seen = useRef(new Set<string>());
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nearBottom = useRef(true);
  const count = Array.from(draft).length;

  useEffect(() => {
    const incoming = chat.messages.filter((m) => !seen.current.has(m.id) && m.sender_id !== chat.selfId).length;
    seen.current = new Set(chat.messages.map((m) => m.id));
    if (!open && incoming) setUnread((n) => n + incoming);
    if (open && nearBottom.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [chat.messages, chat.selfId, open]);

  useEffect(() => {
    if (!open) return;
    setUnread(0);
    nearBottom.current = true;
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    inputRef.current?.focus();
  }, [open]);

  const submit = async () => {
    if (chat.sending || chat.connection !== 'open' || !draft.trim() || count > CHAT_MAX_LENGTH) return;
    const text = draft;
    nearBottom.current = true;
    if (await chat.sendMessage(text)) setDraft((current) => current === text ? '' : current);
  };
  const close = () => { setOpen(false); toggleRef.current?.focus(); };

  return (
    <aside className={styles.widget} aria-label="チャット">
      <button ref={toggleRef} className={styles.toggle} type="button" aria-label="チャット" aria-controls="room-chat-panel" aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        チャット{unread > 0 && !open && <span className={styles.badge} aria-label={`未読${unread}件`}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && <section id="room-chat-panel" className={styles.panel} aria-label="ルームチャット"
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
        <header className={styles.header}>
          <div><h2>ルームチャット</h2><span>ルーム {roomId}</span></div>
          <button type="button" onClick={close} aria-label="チャットを閉じる">閉じる</button>
        </header>
        <div className={styles.connection} role="status">
          {chat.connection === 'open' ? '接続済み · 面接前も送受信できます' : chat.connection === 'connecting' ? 'チャットに接続中…' : chat.connection === 'idle' ? '表示名とルームコードを入力し、同意にチェックするとチャットを利用できます。' : 'チャット未接続'}
          {chat.connection === 'error' && <button type="button" onClick={chat.reconnect}>再接続</button>}
        </div>
        <div ref={logRef} className={styles.log} role="log" aria-label="チャット履歴" aria-live="polite" aria-relevant="additions" tabIndex={0}
          onScroll={() => {
            const log = logRef.current;
            if (log) nearBottom.current = log.scrollHeight - log.clientHeight - log.scrollTop < 40;
          }}>
          {chat.messages.length === 0 && <p className={styles.empty}>まだメッセージはありません。同じルームの相手に送信できます。</p>}
          {chat.messages.map((message) => <article key={message.id}
            className={`${styles.message} ${message.sender_id === chat.selfId ? styles.own : ''}`}>
            <div className={styles.meta}>
              <strong>{message.name}{message.sender_id === chat.selfId ? '（あなた）' : ''}</strong>
              <time dateTime={message.sent_at}>{new Date(message.sent_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</time>
            </div>
            <p>{message.text}</p>
          </article>)}
        </div>
        <form className={styles.composer} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label htmlFor="room-chat-message">メッセージ</label>
          <textarea id="room-chat-message" ref={inputRef} rows={3} value={draft} aria-describedby="room-chat-limit"
            placeholder="メッセージを入力" onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault(); void submit();
              }
            }} />
          <div className={styles.sendRow}>
            <span id="room-chat-limit" className={count > CHAT_MAX_LENGTH ? styles.error : ''}>{count} / {CHAT_MAX_LENGTH}文字 · Shift+Enterで改行</span>
            <button type="submit" disabled={chat.connection !== 'open' || chat.sending || !draft.trim() || count > CHAT_MAX_LENGTH}>
              {chat.sending ? '送信中…' : '送信'}
            </button>
          </div>
          {chat.error && <p className={styles.error} role="alert">{chat.error}</p>}
        </form>
      </section>}
    </aside>
  );
}
