'use client';

import { useEffect, useRef, useState } from 'react';
import { CHAT_MAX_LENGTH, CHAT_MAX_FILES, CHAT_MAX_FILE_SIZE, type ChatAttachment, type useRoomChat } from '@/hooks/useRoomChat';
import styles from './RoomChat.module.css';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(size / 1024))} KB`;

function DraftFile({ file }: { file: File }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!IMAGE_TYPES.has(file.type)) return;
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => URL.revokeObjectURL(preview);
  }, [file]);
  return <>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {url && <img className={styles.thumbnail} src={url} alt="" />}
    <span className={styles.fileName}><span>{file.name}</span><small>{fileSize(file.size)}</small></span>
  </>;
}

function Attachment({ attachment, getBlob }: {
  attachment: ChatAttachment;
  getBlob: ReturnType<typeof useRoomChat>['getAttachmentBlob'];
}) {
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const downloadRef = useRef<AbortController | null>(null);
  const isImage = IMAGE_TYPES.has(attachment.content_type);

  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    setPreview('');
    setPreviewError(false);
    if (isImage) {
      void getBlob(attachment, controller.signal).then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      }).catch(() => { if (!controller.signal.aborted) setPreviewError(true); });
    }
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [attachment, getBlob, isImage, attempt]);
  useEffect(() => () => downloadRef.current?.abort(), [getBlob]);

  const download = async () => {
    if (downloadRef.current) return;
    const controller = new AbortController();
    downloadRef.current = controller;
    setDownloading(true);
    setDownloadError('');
    try {
      const blob = await getBlob(attachment, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = attachment.name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (!controller.signal.aborted) setDownloadError(error instanceof Error ? error.message : 'ファイルを取得できませんでした。');
    } finally {
      downloadRef.current = null;
      setDownloading(false);
    }
  };

  return <div className={styles.attachment}>
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {preview && !previewError && <img src={preview} alt={attachment.name} className={styles.image} onError={() => setPreviewError(true)} />}
    {isImage && !preview && !previewError && <span className={styles.fileHint}>画像を読み込み中…</span>}
    {isImage && previewError && <button type="button" onClick={() => setAttempt((n) => n + 1)}>画像を再読み込み</button>}
    <button type="button" className={styles.download} onClick={() => void download()} disabled={downloading}
      aria-label={`${attachment.name}をダウンロード`}>
      <span className={styles.fileName}><span>{attachment.name}</span><small>{fileSize(attachment.size)} · {downloading ? '取得中…' : 'ダウンロード'}</small></span>
      <span aria-hidden="true">↓</span>
    </button>
    {downloadError && <p role="alert" className={styles.error}>{downloadError}</p>}
  </div>;
}

export function RoomChat({ chat, roomId }: { chat: ReturnType<typeof useRoomChat>; roomId: string }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const seen = useRef(new Set<string>());
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const nearBottom = useRef(true);
  const count = Array.from(draft).length;

  useEffect(() => { setFiles([]); setDraft(''); setFileError(''); setUnread(0); seen.current.clear(); }, [roomId]);

  const addFiles = (incoming: File[]) => {
    if (chat.sending || chat.connection !== 'open' || incoming.length === 0) return;
    if (files.length + incoming.length > CHAT_MAX_FILES) {
      setFileError(`一度に添付できるファイルは${CHAT_MAX_FILES}件までです。`);
      return;
    }
    if (incoming.some((file) => file.size > CHAT_MAX_FILE_SIZE)) {
      setFileError('1ファイルのサイズは10MBまでです。');
      return;
    }
    if (incoming.some((file) => file.size === 0)) {
      setFileError('空のファイルは添付できません。');
      return;
    }
    setFileError('');
    setFiles((current) => [...current, ...incoming]);
  };

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
    if (chat.sending || chat.connection !== 'open' || (!draft.trim() && files.length === 0) || count > CHAT_MAX_LENGTH) return;
    const text = draft;
    const selected = files;
    nearBottom.current = true;
    if (await chat.sendMessage(text, selected)) {
      setDraft((current) => current === text ? '' : current);
      setFiles((current) => current.filter((file) => !selected.includes(file)));
      setFileError('');
    }
  };
  const close = () => { setOpen(false); toggleRef.current?.focus(); };

  return (
    <aside className={styles.widget} aria-label="チャット">
      <button ref={toggleRef} className={styles.toggle} type="button" aria-label="チャット" aria-controls="room-chat-panel" aria-expanded={open}
        onClick={() => setOpen((current) => !current)}>
        チャット{unread > 0 && !open && <span className={styles.badge} aria-label={`未読${unread}件`}>{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && <section id="room-chat-panel" className={`${styles.panel} ${dragging ? styles.dragging : ''}`} aria-label="ルームチャット"
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(Array.from(event.dataTransfer.files)); }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
        <header className={styles.header}>
          <div><h2>ルームチャット</h2><span>ルーム {roomId}</span></div>
          <button type="button" onClick={close} aria-label="チャットを閉じる">閉じる</button>
        </header>
        <div className={styles.connection} role="status">
          {chat.connection === 'open' ? '接続済み · 面接中の参加者と送受信できます' : chat.connection === 'connecting' ? 'チャットに接続中…' : chat.connection === 'idle' ? '面接への入室が完了するとチャットを利用できます。' : 'チャット未接続'}
          {chat.connection === 'error' && <button type="button" onClick={chat.reconnect}>再接続</button>}
        </div>
        <div ref={logRef} className={styles.log} role="log" aria-label="チャット履歴" aria-live="polite" aria-relevant="additions" tabIndex={0}
          onLoadCapture={() => { if (nearBottom.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }}
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
            {message.text && <p>{message.text}</p>}
            {message.attachments?.map((attachment) => <Attachment key={attachment.id} attachment={attachment} getBlob={chat.getAttachmentBlob} />)}
          </article>)}
        </div>
        <form className={styles.composer} aria-label="メッセージを作成" onSubmit={(event) => { event.preventDefault(); void submit(); }}
          onPaste={(event) => {
            if (event.clipboardData.files.length) { event.preventDefault(); addFiles(Array.from(event.clipboardData.files)); }
          }}>
          <input ref={fileInputRef} className={styles.hidden} type="file" multiple aria-label="添付ファイルを選択"
            disabled={chat.connection !== 'open' || chat.sending}
            onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <div className={styles.attachRow}>
            <button type="button" disabled={chat.connection !== 'open' || chat.sending || files.length >= CHAT_MAX_FILES}
              onClick={() => fileInputRef.current?.click()}>ファイルを添付</button>
            <span className={styles.fileHint}>写真・PDFなど<br />5件まで・各10MB</span>
          </div>
          {files.length > 0 && <ul className={styles.pending} aria-label="送信する添付ファイル">
            {files.map((file, index) => <li key={`${index}-${file.name}`}>
              <DraftFile file={file} />
              <button type="button" disabled={chat.sending} aria-label={`${file.name}を取り消す`}
                onClick={() => { setFiles((current) => current.filter((_, i) => i !== index)); setFileError(''); }}>×</button>
            </li>)}
          </ul>}
          <label htmlFor="room-chat-message">メッセージ</label>
          <textarea id="room-chat-message" ref={inputRef} rows={3} value={draft} aria-describedby="room-chat-limit"
            placeholder="メッセージを入力 · 画像の貼り付けもできます" onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
                event.preventDefault(); void submit();
              }
            }} />
          <div className={styles.sendRow}>
            <span id="room-chat-limit" className={count > CHAT_MAX_LENGTH ? styles.error : ''}>{count} / {CHAT_MAX_LENGTH}文字 · Shift+Enterで改行</span>
            <button type="submit" disabled={chat.connection !== 'open' || chat.sending || (!draft.trim() && files.length === 0) || count > CHAT_MAX_LENGTH}>
              {chat.sending ? '送信中…' : '送信'}
            </button>
          </div>
          <p className={styles.fileHint}>ファイルをここへドロップできます。全員が退出すると添付も削除されます。</p>
          {fileError && <p className={styles.error} role="alert">{fileError}</p>}
          {chat.error && <p className={styles.error} role="alert">{chat.error}</p>}
        </form>
      </section>}
    </aside>
  );
}
