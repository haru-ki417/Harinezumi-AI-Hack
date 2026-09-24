import { useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, RoomConnection, Role, TranscriptSegment } from '@/types';

const WS_BASE = 'ws://localhost:8000/ws/room';

interface Options {
  roomId: string;
  role: Role;
  name: string;
  /** 同意して参加した後に true にする。true の間だけ接続する。 */
  active: boolean;
}

export interface VitalRoom {
  connection: RoomConnection;
  selfId: string | null;
  participants: Participant[];
  topic: string;
  transcribe: boolean;
  transcript: TranscriptSegment[];
  sendFrame: (imageBase64: string) => void;
  sendTopic: (topic: string) => void;
  sendTranscribe: (on: boolean) => void;
  sendTranscript: (text: string) => void;
}

/**
 * 同意付き・透明な双方向ルームに接続する。
 * 参加時に consent:true を送り(サーバは同意が無ければ拒否)、
 * 自分のフレームを送信、全員のバイタルと現在のトピックを受け取る。
 */
export function useVitalRoom({ roomId, role, name, active }: Options): VitalRoom {
  const [connection, setConnection] = useState<RoomConnection>('idle');
  const [selfId, setSelfId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [topic, setTopic] = useState<string>('');
  const [transcribe, setTranscribe] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active || !roomId) return;
    setConnection('connecting');
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${WS_BASE}/${encodeURIComponent(roomId)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'join', role, name, consent: true }));
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'joined') {
            setSelfId(m.client_id);
            setConnection('open');
          } else if (m.type === 'room') {
            setParticipants(Array.isArray(m.participants) ? m.participants : []);
            if (typeof m.topic === 'string') setTopic(m.topic);
            if (typeof m.transcribe === 'boolean') setTranscribe(m.transcribe);
          } else if (m.type === 'transcript' && m.segment) {
            setTranscript((prev) => {
              const next = [...prev, m.segment as TranscriptSegment];
              return next.length > 500 ? next.slice(next.length - 500) : next;
            });
          } else if (m.type === 'error') {
            setConnection('error');
          }
        } catch {
          /* 壊れたメッセージは無視 */
        }
      };
      ws.onerror = () => setConnection('error');
      ws.onclose = () => {
        wsRef.current = null;
        setConnection((c) => (c === 'open' ? 'idle' : c));
      };
    } catch {
      setConnection('error');
    }

    return () => {
      try {
        ws?.send(JSON.stringify({ type: 'leave' }));
      } catch {
        /* noop */
      }
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
      setParticipants([]);
      setSelfId(null);
      setTopic('');
      setTranscribe(false);
      setTranscript([]);
    };
  }, [active, roomId, role, name]);

  const sendFrame = useCallback((imageBase64: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // rPPGはできるだけ全フレームをサーバで処理したい(表示だけサーバ側で間引く)。
    // 絞り込みは「ソケットに送信待ちが溜まりすぎた時だけ」にする。
    if (ws.bufferedAmount > 1_000_000) return; // ~1MB以上滞留していたらスキップ
    try {
      ws.send(JSON.stringify({ type: 'frame', image_base64: imageBase64 }));
    } catch {
      /* noop */
    }
  }, []);

  const send = useCallback((obj: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* noop */ }
    }
  }, []);

  const sendTopic = useCallback((t: string) => send({ type: 'topic', topic: t }), [send]);
  const sendTranscribe = useCallback((on: boolean) => send({ type: 'transcribe', on }), [send]);
  const sendTranscript = useCallback((text: string) => send({ type: 'transcript', text }), [send]);

  return {
    connection, selfId, participants, topic, transcribe, transcript,
    sendFrame, sendTopic, sendTranscribe, sendTranscript,
  };
}
