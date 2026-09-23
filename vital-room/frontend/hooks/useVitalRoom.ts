import { useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, RoomConnection, Role } from '@/types';

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
  sendFrame: (imageBase64: string) => void;
}

/**
 * 同意付き・透明な双方向ルームに接続する。
 * 参加時に consent:true を送り(サーバは同意が無ければ拒否)、
 * 自分のフレームを送信、全員のバイタルのスナップショットを受け取る。
 */
export function useVitalRoom({ roomId, role, name, active }: Options): VitalRoom {
  const [connection, setConnection] = useState<RoomConnection>('idle');
  const [selfId, setSelfId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(0);

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
            pendingRef.current = Math.max(0, pendingRef.current - 1);
            setParticipants(Array.isArray(m.participants) ? m.participants : []);
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
    };
  }, [active, roomId, role, name]);

  const sendFrame = useCallback((imageBase64: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (pendingRef.current > 3) return;
      try {
        ws.send(JSON.stringify({ type: 'frame', image_base64: imageBase64 }));
        pendingRef.current += 1;
      } catch {
        /* noop */
      }
    }
  }, []);

  return { connection, selfId, participants, sendFrame };
}
