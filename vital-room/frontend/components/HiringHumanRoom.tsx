'use client';

import { FormEvent, useEffect, useRef, useState, type CSSProperties } from 'react';
import { hiringSocketUrl, InterviewSession, newRequestId } from '@/lib/hiring';
import { HiringDeviceControls, StreamVideo, useHiringDevices, useHiringSpeech } from './HiringDevices';
import { useHiringVitals, type HiringVitalPeer } from '@/hooks/useHiringVitals';
import { HiringVitals } from './HiringVitals';
import { useHumanTranscription } from './useHumanTranscription';
import { useScreenShare } from '@/hooks/useScreenShare';
import styles from './Hiring.module.css';
import roomStyles from './HiringHumanRoom.module.css';

type Peer = HiringVitalPeer;
type PendingMessage = { text: string; request_id: string };
function iceServers(): RTCIceServer[] {
  try { const configured = process.env.NEXT_PUBLIC_RTC_ICE_SERVERS; if (configured) { const parsed: unknown = JSON.parse(configured); if (Array.isArray(parsed)) return parsed as RTCIceServer[]; } } catch { /* use default */ }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

const screenMediaStyle: CSSProperties = { display: 'block', width: '100%', maxHeight: '60vh', objectFit: 'contain', background: '#000', borderRadius: 12 };

/** 受信した共有画面をimgへDOM直更新(再描画を避ける)。 */
function HiringScreenView({ frameRef }: { frameRef: { current: string | null } }) {
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    let raf = 0; let last = '';
    const tick = () => { const f = frameRef.current; if (f && f !== last && imgRef.current) { imgRef.current.src = `data:image/jpeg;base64,${f}`; last = f; } raf = requestAnimationFrame(tick); };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [frameRef]);
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={imgRef} alt="共有画面" style={screenMediaStyle} />;
}

/** 自分が共有中のプレビュー。 */
function HiringScreenSelf({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) { ref.current.srcObject = stream; ref.current.play?.().catch(() => undefined); } }, [stream]);
  return <video ref={ref} muted playsInline style={screenMediaStyle} />;
}

export function HiringHumanRoom({ id, token, host, session, onSession }: { id: string; token: string; host: boolean; session: InterviewSession; onSession: (session: InterviewSession) => void }) {
  const device = useHiringDevices(true);
  const [remote, setRemote] = useState<MediaStream | null>(null); const [peers, setPeers] = useState<Peer[]>([]); const [connection, setConnection] = useState('接続中'); const [socketReady, setSocketReady] = useState(false); const [error, setError] = useState(''); const [draft, setDraft] = useState(''); const [pending, setPending] = useState<PendingMessage | null>(null); const [retry, setRetry] = useState(0); const [saved, setSaved] = useState('');
  const socket = useRef<WebSocket | null>(null); const callback = useRef(onSession); callback.current = onSession;
  const vital = useHiringVitals({ socket, stream: device.stream, camera: device.camera, active: session.invitation.status === 'in_progress', socketReady, role: host ? 'interviewer' : 'candidate' });
  const { receive: receiveVitals, reset: resetVitals } = vital;
  const transcription = useHumanTranscription({ id, host, socket, active: session.invitation.status === 'in_progress', microphone: device.microphone });
  const { receive: receiveTranscription } = transcription;
  const statusRef = useRef(session.invitation.status); statusRef.current = session.invitation.status;
  const pendingRef = useRef<PendingMessage | null>(null); pendingRef.current = pending;
  const speech = useHiringSpeech(text => { if (!pendingRef.current) setDraft(value => `${value}${value ? '\n' : ''}${text}`.slice(0, 6000)); });
  const stopSpeech = speech.stop;
  useEffect(() => { if (!device.microphone) stopSpeech(); }, [device.microphone, stopSpeech]);
  // 画面共有(WebRTC通話とは独立に、画面フレームをWSで中継して相手に表示)
  const incomingScreen = useRef<string | null>(null);
  const [presenter, setPresenter] = useState<string | null>(null);
  const presenterRef = useRef<string | null>(null); presenterRef.current = presenter;
  const screenShare = useScreenShare({
    onFrame: (b64) => { const ws = socket.current; if (ws?.readyState === WebSocket.OPEN && ws.bufferedAmount < 512_000 && b64.length < 120_000) ws.send(JSON.stringify({ type: 'screen', image_base64: b64 })); },
    onStop: () => { const ws = socket.current; if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'screen_stop' })); },
    maxWidth: 1000, quality: 0.5,
  });
  const stopScreen = screenShare.stop;
  useEffect(() => () => stopScreen(), [stopScreen]); // アンマウント時に共有停止
  const storageKey = `hiring_human_pending_${id}_${host ? 'host' : 'candidate'}`;
  useEffect(() => { try { const savedMessage = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as PendingMessage | null; if (savedMessage) { setPending(savedMessage); setDraft(savedMessage.text); } } catch { /* nothing to restore */ } }, [storageKey]);

  useEffect(() => {
    let configuredIce = iceServers();
    let stopped = false; let ws: WebSocket | null = null; let pc: RTCPeerConnection | null = null; let reconnectTimer: number | undefined; let joined = false; let present: Peer[] = []; let offering = false; let queuedIce: RTCIceCandidateInit[] = []; let attempts = 0; let signalChain = Promise.resolve(); let wasReady = false;
    const closePeer = () => { if (pc) { pc.onconnectionstatechange = null; pc.ontrack = null; pc.onicecandidate = null; pc.close(); pc = null; } queuedIce = []; if (!stopped) setRemote(null); };
    const signal = (data: unknown) => { if (!stopped && ws?.readyState === WebSocket.OPEN && joined) ws.send(JSON.stringify({ type: 'signal', data })); };
    const createPeer = () => {
      const next = new RTCPeerConnection({ iceServers: configuredIce }); pc = next;
      device.stream?.getTracks().forEach(track => next.addTrack(track, device.stream!));
      // Always receive both media kinds, including when this participant chooses to disable devices.
      if (!device.stream?.getAudioTracks().length) next.addTransceiver('audio', { direction: 'recvonly' });
      if (!device.stream?.getVideoTracks().length) next.addTransceiver('video', { direction: 'recvonly' });
      next.onicecandidate = event => { if (event.candidate) signal({ candidate: event.candidate.toJSON() }); };
      next.ontrack = event => { if (!stopped && next === pc) setRemote(event.streams[0] || new MediaStream([event.track])); };
      next.onconnectionstatechange = () => { if (stopped || next !== pc) return; if (next.connectionState === 'connected') { setConnection('通話接続済み'); setError(''); } else if (next.connectionState === 'failed') { setConnection('通話の再接続が必要'); setError('映像・音声を接続できませんでした。「接続をやり直す」をお試しください。文字の送信は引き続き利用できます。'); } else if (next.connectionState === 'disconnected') setConnection('通話を再接続中'); };
      return next;
    };
    const canCall = () => !stopped && statusRef.current === 'in_progress' && present.some(p => p.role === 'interviewer') && present.some(p => p.role === 'candidate');
    const offer = async (restart = false) => {
      if (!host || !canCall() || offering || (pc && !restart)) return;
      offering = true;
      try { closePeer(); const next = createPeer(); const description = await next.createOffer(); if (stopped || next !== pc) return; await next.setLocalDescription(description); if (stopped || next !== pc) return; signal({ description: next.localDescription }); setConnection('通話を接続中'); } catch { if (!stopped) setError('通話の接続に失敗しました。接続をやり直してください。'); } finally { offering = false; }
    };
    const handleSignal = async (data: { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; renegotiate?: boolean }) => {
      if (stopped || !canCall()) return;
      if (data.renegotiate && host) {
        if (offering) return; // The pending offer will be sent once local SDP is ready.
        if (pc?.signalingState === 'have-local-offer' && pc.localDescription) signal({ description: pc.localDescription });
        else await offer(true);
        return;
      }
      if (data.description) {
        if (data.description.type === 'offer' && !host) {
          if (pc && pc.remoteDescription?.sdp === data.description.sdp && pc.localDescription?.type === 'answer') { signal({ description: pc.localDescription }); return; }
          const earlyIce = queuedIce; closePeer(); const next = createPeer(); await next.setRemoteDescription(data.description); if (stopped || next !== pc) return; for (const candidate of earlyIce) await next.addIceCandidate(candidate); queuedIce = [];
          const answer = await next.createAnswer(); if (stopped || next !== pc) return; await next.setLocalDescription(answer); if (stopped || next !== pc) return; signal({ description: next.localDescription });
        } else if (data.description.type === 'answer' && host && pc?.signalingState === 'have-local-offer') { await pc.setRemoteDescription(data.description); for (const candidate of queuedIce) await pc.addIceCandidate(candidate); queuedIce = []; }
      } else if (data.candidate) { if (pc?.remoteDescription) await pc.addIceCandidate(data.candidate); else queuedIce.push(data.candidate); }
    };
    const connect = () => {
      if (stopped) return;
      resetVitals();
      setConnection(attempts ? 'サーバーへ再接続中' : '接続中'); setSocketReady(false); joined = false; wasReady = false;
      ws = new WebSocket(hiringSocketUrl(id)); socket.current = ws;
      ws.onopen = () => { ws?.send(JSON.stringify({ type: 'join', token })); };
      ws.onmessage = event => {
        if (stopped) return;
        try {
          const message = JSON.parse(event.data);
          receiveVitals(message);
          receiveTranscription(message);
          if (message.type === 'screen' && typeof message.image_base64 === 'string') {
            incomingScreen.current = message.image_base64;
            const who = typeof message.role === 'string' ? message.role : 'other';
            if (presenterRef.current !== who) setPresenter(who);
            return;
          }
          if (message.type === 'screen_stop') {
            incomingScreen.current = null;
            if (presenterRef.current) setPresenter(null);
            return;
          }
          if (message.type === 'state') {
            if (Array.isArray(message.ice_servers) && message.ice_servers.length) configuredIce = [...iceServers(), ...message.ice_servers];
            const firstState = !joined; joined = true; attempts = 0; setSocketReady(true); present = message.peers || []; setPeers(present); statusRef.current = message.session.invitation.status; callback.current(message.session);
            const readyToCall = canCall();
            if (readyToCall) { if (host) void offer(); else if (!wasReady) signal({ renegotiate: true }); if ((firstState || !wasReady) && pendingRef.current) ws?.send(JSON.stringify({ type: 'transcript', ...pendingRef.current })); }
            else { closePeer(); setConnection(message.session.invitation.status === 'waiting' ? '入室許可を待っています' : '相手の接続を待っています'); }
            wasReady = readyToCall;
          } else if (message.type === 'signal') { signalChain = signalChain.then(() => handleSignal(message.data)).catch(() => { if (!stopped) setError('通話の接続に失敗しました。接続をやり直してください。'); }); }
          else if (message.type === 'transcript_saved' && message.request_id === pendingRef.current?.request_id) { setPending(null); pendingRef.current = null; sessionStorage.removeItem(storageKey); setDraft(''); setSaved('発言を保存しました。'); }
          else if (message.type === 'error') {
            setError(message.message || message.detail || '接続中にエラーが発生しました。');
            if ([403, 409, 422].includes(message.status) && message.request_id === pendingRef.current?.request_id) { setPending(null); pendingRef.current = null; sessionStorage.removeItem(storageKey); }
          }
        } catch { setError('受信した内容を読み取れませんでした。接続をやり直してください。'); }
      };
      ws.onclose = event => {
        if (stopped) return; joined = false; setSocketReady(false); resetVitals(); closePeer();
        incomingScreen.current = null; setPresenter(null);
        if (event.code === 4001) { setConnection('別のタブに接続が移りました'); setError('同じ参加者が別のタブで接続しました。このタブで再開する場合は「接続をやり直す」を押してください。'); return; }
        if ([4003, 4401, 4403, 1008].includes(event.code)) { setConnection('接続できません'); setError('参加権限または面接の状態を確認できません。ページを更新して状態を確認してください。'); return; }
        if (['completed', 'revoked', 'expired'].includes(statusRef.current)) return;
        attempts++; setConnection('通信が切断されました。再接続中…'); reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** attempts, 10000));
      };
      ws.onerror = () => { if (!stopped) setConnection('サーバーとの接続を確認しています'); };
    };
    connect();
    return () => { stopped = true; window.clearTimeout(reconnectTimer); if (ws) { ws.onclose = null; ws.close(); } socket.current = null; resetVitals(); closePeer(); };
  }, [id, token, host, retry, device.stream, storageKey, receiveVitals, resetVitals, receiveTranscription]);

  const send = (event: FormEvent) => { event.preventDefault(); speech.stop(); if (!socketReady || session.invitation.status !== 'in_progress') return; const message = pending || { text: draft.trim(), request_id: newRequestId() }; if (!message.text) return; setError(''); setSaved(''); setPending(message); pendingRef.current = message; sessionStorage.setItem(storageKey, JSON.stringify(message)); socket.current?.send(JSON.stringify({ type: 'transcript', ...message })); };
  return <section className={styles.card}>
    <div className={styles.row}><span className={styles.badge}>{connection}</span><span className={styles.muted}>{peers.map(p => `${p.role === 'interviewer' ? '担当者' : '応募者'}：${p.name}`).join(' ／ ')}</span>
      {/* 文字起こしの開始/停止を最上部(残り時間の直下)に配置してすぐ押せるように */}
      <button type="button" className={transcription.enabled ? styles.primary : styles.button} style={{ marginLeft: 'auto' }}
        disabled={!transcription.supported || !device.microphone || !socketReady || session.invitation.status !== 'in_progress' || transcription.preparing}
        onClick={() => { speech.stop(); void transcription.toggle(); }}>
        {transcription.enabled ? '● 文字起こしを停止' : '文字起こしを開始'}
      </button>
      {/* 画面共有(資料・PC画面を相手に表示)。WebRTC通話とは独立。 */}
      <button type="button" className={screenShare.sharing ? styles.primary : styles.button}
        disabled={session.invitation.status !== 'in_progress'}
        onClick={() => { if (screenShare.sharing) screenShare.stop(); else void screenShare.start(); }}>
        {screenShare.sharing ? '● 画面共有を停止' : '画面を共有'}
      </button>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {(screenShare.sharing || presenter) && (
      <section style={{ margin: '12px 0', border: '1px solid var(--accent-line, rgba(91,140,255,0.45))', borderRadius: 12, overflow: 'hidden' }}>
        <div className={styles.row} style={{ padding: '8px 12px' }}>
          <span className={styles.badge}>{screenShare.sharing ? 'あなたが画面を共有中' : `${presenter === 'interviewer' ? '担当者' : '応募者'} が画面を共有中`}</span>
          {screenShare.sharing && <button type="button" className={styles.button} style={{ marginLeft: 'auto' }} onClick={() => screenShare.stop()}>共有を停止</button>}
        </div>
        {screenShare.sharing ? <HiringScreenSelf stream={screenShare.stream} /> : <HiringScreenView frameRef={incomingScreen} />}
      </section>
    )}
    <div className={roomStyles.liveLayout}>
      <div className={roomStyles.call}>
        <StreamVideo stream={remote} muted={false} /><div className={roomStyles.preview}><StreamVideo stream={device.stream} small /></div>
        <details className={roomStyles.deviceSettings}><summary>カメラ・マイク設定</summary><div className={roomStyles.deviceFields}><HiringDeviceControls device={device} preview={false} /></div></details>
        <div className={`${styles.row} ${roomStyles.reconnect}`}><button className={styles.button} onClick={() => { setError(''); setRetry(n => n + 1); }}>接続をやり直す</button></div>
      </div>
      <HiringVitals vital={vital} host={host} active={session.invitation.status === 'in_progress'} connected={socketReady} />
    </div>
    <div className={roomStyles.answer}>
    <h3>文字起こし</h3><p className={styles.muted}>開始すると自分のマイクの発言を文字に変換し、確定した内容を面接記録へ自動保存します。各参加者が自分の端末で開始してください（開始/停止は画面上部のボタンから操作できます）。音声ファイルは保存しません。ブラウザーの音声認識サービスへ音声が送信される場合があります。</p>
    {!transcription.supported && <p className={styles.muted}>このブラウザーは音声認識に対応していません。下の発言内容を入力して保存できます。</p>}
    {transcription.enabled && <p role="status">{transcription.listening ? '文字起こし中…' : '音声認識の接続を確認中…'}</p>}
    {transcription.interim && <p data-testid="human-transcription-interim">{transcription.interim}（認識中）</p>}
    {transcription.error && <p role="alert" className={styles.error}>{transcription.error}</p>}
    <p className={styles.muted} data-testid="human-transcript-queue">{transcription.count ? `未保存の発言：${transcription.count}件。接続が戻ると再送します。` : '文字起こしの未保存データはありません。'}</p>
    {transcription.count > 0 && <details><summary>未保存の発言を確認</summary><p style={{ whiteSpace: 'pre-wrap' }}>{transcription.unsaved}</p></details>}
    <h3>発言を手動で保存</h3><p className={styles.muted}>入力した内容を「発言を保存」で送信できます。文字起こしは誤認識することがあるため、保存された会話を確認してください。</p>
    <form className={styles.form} onSubmit={send}><label className={styles.field}>発言内容<textarea className={styles.textarea} value={draft} readOnly={Boolean(pending)} maxLength={6000} onChange={e => setDraft(e.target.value)} placeholder="自分の発言を入力してください" disabled={session.invitation.status !== 'in_progress'} /></label>
      {speech.error && <p role="alert" className={styles.error}>{speech.error}</p>}
      <div className={styles.row}>{speech.supported && <button type="button" className={styles.button} disabled={transcription.enabled || !!pending || !device.microphone || session.invitation.status !== 'in_progress'} onClick={() => speech.listening ? speech.stop() : speech.start()}>{speech.listening ? '音声入力を停止' : '音声入力'}</button>}<button className={styles.primary} disabled={!socketReady || session.invitation.status !== 'in_progress' || !draft.trim()}>{pending ? '保存を再確認' : '発言を保存'}</button></div>
      {pending && <p className={styles.notice}>保存完了を確認しています。通信が戻ったら同じ発言を再送でき、重複して保存されません。</p>}{saved && <p role="status" className={styles.muted}>{saved}</p>}
      <p className={styles.muted}>音声入力ではブラウザーの音声認識サービスを利用する場合があります。認識結果は送信前に修正できます。</p>
    </form>
    </div>
  </section>;
}
