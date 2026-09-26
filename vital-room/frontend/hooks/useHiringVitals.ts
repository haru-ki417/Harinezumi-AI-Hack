'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { InterviewSession } from '@/lib/hiring';
import type { Vitals } from '@/types';

export type HiringVitalPeer = { client_id: string; role: 'interviewer' | 'candidate'; name: string; vital_consent: boolean };
export type HiringVitalRecord = { vitals: Vitals; receivedAt: number; history: number[] };
const MAX_HISTORY = 300;
const STALE_AFTER_MS = 8000;

/** Consented measurements share the authenticated hiring socket and camera stream. */
export function useHiringVitals({ socket, stream, camera, active, socketReady, role }: {
  socket: RefObject<WebSocket | null>; stream: MediaStream | null; camera: boolean;
  active: boolean; socketReady: boolean; role: HiringVitalPeer['role'];
}) {
  const [consent, setConsentValue] = useState(false);
  const [participants, setParticipants] = useState<HiringVitalPeer[]>([]);
  const [records, setRecords] = useState<Record<string, HiringVitalRecord>>({});
  const [cameraState, setCameraState] = useState<{ stream: MediaStream | null; live: boolean }>({ stream: null, live: false });
  const [error, setError] = useState('');
  const consentRef = useRef(false);
  const peersRef = useRef<HiringVitalPeer[]>([]);
  const activeRef = useRef(active); activeRef.current = active;
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const roleRef = useRef(role); roleRef.current = role;
  const ownPeer = participants.find(p => p.role === role);
  const acknowledged = Boolean(ownPeer?.vital_consent);
  const liveCamera = Boolean(camera && cameraState.stream === stream && cameraState.live);
  const desiredSharing = consent && active && socketReady && liveCamera;

  const reset = useCallback(() => {
    consentRef.current = false; peersRef.current = []; setConsentValue(false); setParticipants([]); setRecords({}); setError('');
  }, []);
  const setConsent = useCallback((enabled: boolean) => {
    consentRef.current = enabled; setConsentValue(enabled); setError('');
    if (!enabled) {
      const ownId = peersRef.current.find(p => p.role === roleRef.current)?.client_id;
      if (ownId) setRecords(current => { const next = { ...current }; delete next[ownId]; return next; });
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'vital_consent', enabled: false }));
    }
  }, [socket]);
  useEffect(() => {
    const tracks = stream?.getVideoTracks() || [];
    const refreshCamera = () => {
      const live = Boolean(camera && stream?.getVideoTracks().some(track => track.readyState === 'live'));
      setCameraState({ stream, live });
      // カメラ/マイクをオフにしても「計測に同意」チェックは外さない(本人の意思として保持)。
      // カメラが無い間は liveCamera=false で計測は自動的に一時停止し、戻れば自動再開する。
    };
    tracks.forEach(track => track.addEventListener('ended', refreshCamera));
    stream?.addEventListener('removetrack', refreshCamera);
    refreshCamera();
    return () => {
      tracks.forEach(track => track.removeEventListener('ended', refreshCamera));
      stream?.removeEventListener('removetrack', refreshCamera);
    };
  }, [stream, camera]);
  const receive = useCallback((message: Record<string, unknown>) => {
    if (message.type === 'state') {
      const next = (Array.isArray(message.peers) ? message.peers : []).filter((p): p is HiringVitalPeer =>
        Boolean(p && typeof p.client_id === 'string' && ['interviewer', 'candidate'].includes(p.role) && typeof p.name === 'string'));
      peersRef.current = next; setParticipants(next);
      const session = message.session as InterviewSession | undefined;
      const running = session?.invitation?.status === 'in_progress';
      activeRef.current = running;
      setRecords(current => {
        const kept = Object.fromEntries(Object.entries(current).filter(([key]) => running && next.some(p => p.client_id === key && p.vital_consent)));
        return Object.keys(kept).length === Object.keys(current).length ? current : kept;
      });
      return;
    }
    if (message.type === 'vitals_clear' && typeof message.client_id === 'string') {
      const id = message.client_id;
      const cleared = peersRef.current.find(p => p.client_id === id);
      const next = peersRef.current.map(p => p.client_id === id ? { ...p, vital_consent: false } : p);
      peersRef.current = next; setParticipants(next);
      // サーバが同意をクリアしても、本人のチェック(=意思)は外さない。カメラが戻り
      // 条件が揃えば desiredSharing により自動で再開する(カメラ/マイク操作で
      // チェックが外れてしまう問題への対応)。cleared は未使用でよい。
      void cleared;
      setRecords(current => { if (!current[id]) return current; const next = { ...current }; delete next[id]; return next; });
      return;
    }
    if (message.type !== 'vitals' || !activeRef.current || typeof message.client_id !== 'string' || !message.vitals || typeof message.vitals !== 'object') return;
    const participant = peersRef.current.find(p => p.client_id === message.client_id);
    if (!participant?.vital_consent || (participant.role === roleRef.current && (!consentRef.current || !cameraRef.current))) return;
    const raw = message.vitals as Vitals;
    const id = participant.client_id;
    // サーバは新しい推定が確定した瞬間だけ measurement_valid=true を送り、
    // それ以外の毎フレームは直近値をキャッシュ配信(=false)する。表示をこの
    // フラグだけで判定すると、確定フレームだけ数値が出て他は消え「点滅」する。
    // → 直近の有効値を保持し、サーバが 0(計測リセット)を返したときのみ空にする。
    const freshBpm = Number.isFinite(raw.current_bpm) && raw.current_bpm > 0 && raw.measurement_valid !== false;
    const freshStress = typeof raw.stress === 'number' && Number.isFinite(raw.stress)
      && raw.stress >= 0 && raw.stress <= 100 && raw.stress_valid !== false;
    const reset = !(Number.isFinite(raw.current_bpm) && raw.current_bpm > 0); // 計測リセット
    setRecords(current => {
      const prev = current[id]?.vitals;
      const bpm = freshBpm ? (raw.current_bpm as number) : reset ? 0 : (prev?.current_bpm ?? 0);
      const stress = freshStress ? raw.stress : reset ? undefined : prev?.stress;
      const vitals: Vitals = { ...raw, current_bpm: bpm, stress, is_anomalous: Boolean(raw.is_anomalous) };
      const history = freshStress
        ? [...(current[id]?.history || []), raw.stress as number].slice(-MAX_HISTORY)
        : (current[id]?.history || []);
      return { ...current, [id]: { vitals, receivedAt: Date.now(), history } };
    });
  }, []);

  useEffect(() => {
    if (!socketReady || !active) return;
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN && desiredSharing !== acknowledged) {
      ws.send(JSON.stringify({ type: 'vital_consent', enabled: desiredSharing, save_summary: desiredSharing }));
    }
    if (!desiredSharing && ownPeer) setRecords(current => {
      if (!current[ownPeer.client_id]) return current;
      const next = { ...current }; delete next[ownPeer.client_id]; return next;
    });
  }, [socket, socketReady, active, desiredSharing, acknowledged, ownPeer]);

  useEffect(() => {
    if (!desiredSharing || !acknowledged || !stream) return;
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) { setError('このブラウザーでは計測用の画像を取得できません。'); return; }
    let stopped = false;
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    void video.play().catch(() => { if (!stopped) setError('カメラ画像を読み取れません。カメラ設定を確認してください。'); });
    const timer = window.setInterval(() => {
      const ws = socket.current;
      const self = peersRef.current.find(p => p.role === roleRef.current);
      if (stopped || !consentRef.current || !activeRef.current || !cameraRef.current || !self?.vital_consent) return;
      if (!stream.getVideoTracks().some(track => track.readyState === 'live')) {
        // カメラが無効な間は送信を止めるだけ。同意チェックは外さない(戻れば自動再開)。
        setCameraState({ stream, live: false }); return;
      }
      if (ws?.readyState !== WebSocket.OPEN || ws.bufferedAmount > 250_000) return;
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      const scale = Math.min(1, 320 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.max(1, Math.round(video.videoWidth * scale)); const height = Math.max(1, Math.round(video.videoHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      try {
        context.drawImage(video, 0, 0, width, height);
        const frame = canvas.toDataURL('image/jpeg', 0.65);
        if (frame.length <= 128_000) ws.send(JSON.stringify({ type: 'frame', image_base64: frame }));
      } catch { if (!stopped) setError('計測用画像を送信できません。接続を確認してください。'); }
    }, 50);
    return () => { stopped = true; window.clearInterval(timer); video.pause(); video.srcObject = null; };
  }, [desiredSharing, acknowledged, stream, socket]);

  useEffect(() => {
    const timer = window.setInterval(() => setRecords(current => {
      const fresh = Object.fromEntries(Object.entries(current).filter(([, record]) => Date.now() - record.receivedAt < STALE_AFTER_MS));
      return Object.keys(fresh).length === Object.keys(current).length ? current : fresh;
    }), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return { consent, setConsent, participants, records, error, receive, reset, measuring: desiredSharing && acknowledged, liveCamera };
}
