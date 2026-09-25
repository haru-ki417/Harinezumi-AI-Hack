import { useCallback, useEffect, useRef, useState } from 'react';
import type { InterviewQuestion, Participant, RoomConnection, Role, TranscriptSegment } from '@/types';

const WS_BASE = 'ws://localhost:8000/ws/room';

interface Options {
  roomId: string;
  role: Role;
  name: string;
  /** 同意して参加した後に true にする。true の間だけ接続する。 */
  active: boolean;
}

export interface Presenter { client_id: string; name: string }

export interface VitalRoom {
  connection: RoomConnection;
  selfId: string | null;
  joinedAt: number | null;
  participants: Participant[];
  topic: string;
  questionId: number;
  questions: InterviewQuestion[];
  endedAt: number | null;
  transcribe: boolean;
  transcript: TranscriptSegment[];
  presenter: Presenter | null;              // 画面共有中の相手(自分以外)
  screenFrameRef: { current: string | null }; // 受信した画面フレーム(base64)
  sendFrame: (imageBase64: string) => void;
  sendTopic: (topic: string) => void;
  sendTranscribe: (on: boolean) => void;
  sendTranscript: (text: string) => void;
  sendScreen: (imageBase64: string) => void;
  sendScreenStop: () => void;
  endSession: () => void;
}

/**
 * 同意付き・透明な双方向ルームに接続する。
 * 参加時に consent:true を送り(サーバは同意が無ければ拒否)、
 * 自分のフレームを送信、全員のバイタルと現在のトピックを受け取る。
 */
export function useVitalRoom({ roomId, role, name, active }: Options): VitalRoom {
  const [connection, setConnection] = useState<RoomConnection>('idle');
  const [selfId, setSelfId] = useState<string | null>(null);
  const [joinedAt, setJoinedAt] = useState<number | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [topic, setTopic] = useState<string>('');
  const [questionId, setQuestionId] = useState(0);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [transcribe, setTranscribe] = useState<boolean>(false);
  const [transcript, setTranscript] = useState<TranscriptSegment[]>([]);
  const [presenter, setPresenter] = useState<Presenter | null>(null);
  const screenFrameRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!active || !roomId) return;
    setConnection('connecting');
    setJoinedAt(null);
    setEndedAt(null);
    let disposed = false;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`${WS_BASE}/${encodeURIComponent(roomId)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'join', role, name, consent: true }));
      };
      ws.onmessage = (ev) => {
        if (disposed) return;
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'joined') {
            setSelfId(m.client_id);
            setJoinedAt(Number.isFinite(m.joined_at) ? m.joined_at : null);
            setConnection('open');
          } else if (m.type === 'room') {
            setParticipants(Array.isArray(m.participants) ? m.participants : []);
            if (typeof m.topic === 'string') setTopic(m.topic);
            if (Number.isInteger(m.question_id) && m.question_id >= 0) setQuestionId(m.question_id);
            if (Array.isArray(m.questions)) setQuestions(m.questions.filter((q: InterviewQuestion) =>
              Number.isInteger(q.id) && q.id > 0 && typeof q.topic === 'string' && Number.isFinite(q.started_at)).slice(0, 200));
            if (typeof m.transcribe === 'boolean') setTranscribe(m.transcribe);
          } else if (m.type === 'session_ended' && Number.isFinite(m.ended_at)) {
            setEndedAt(m.ended_at);
          } else if (m.type === 'transcript' && m.segment) {
            setTranscript((prev) => {
              const next = [...prev, m.segment as TranscriptSegment];
              return next.length > 500 ? next.slice(next.length - 500) : next;
            });
          } else if (m.type === 'screen' && typeof m.image_base64 === 'string') {
            screenFrameRef.current = m.image_base64;
            setPresenter((prev) =>
              prev && prev.client_id === m.client_id
                ? prev
                : { client_id: m.client_id, name: m.name || '参加者' });
          } else if (m.type === 'screen_stop') {
            setPresenter((prev) => {
              if (prev && prev.client_id === m.client_id) {
                screenFrameRef.current = null;
                return null;
              }
              return prev;
            });
          } else if (m.type === 'error') {
            setConnection('error');
          }
        } catch {
          /* 壊れたメッセージは無視 */
        }
      };
      ws.onerror = () => { if (!disposed) setConnection('error'); };
      ws.onclose = () => {
        if (disposed) return;
        wsRef.current = null;
        setConnection((c) => (c === 'open' ? 'idle' : c));
      };
    } catch {
      setConnection('error');
    }

    return () => {
      disposed = true;
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
      setJoinedAt(null);
      setTopic('');
      setQuestionId(0);
      setQuestions([]);
      setEndedAt(null);
      setConnection('idle');
      setTranscribe(false);
      setTranscript([]);
      setPresenter(null);
      screenFrameRef.current = null;
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
  const sendScreenStop = useCallback(() => send({ type: 'screen_stop' }), [send]);
  const endSession = useCallback(() => send({ type: 'end_session' }), [send]);

  const sendScreen = useCallback((imageBase64: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // 画面フレームは大きいので、送信待ちが溜まっていたら間引く
    if (ws.bufferedAmount > 4_000_000) return;
    try {
      ws.send(JSON.stringify({ type: 'screen', image_base64: imageBase64 }));
    } catch { /* noop */ }
  }, []);

  return {
    connection, selfId, joinedAt, participants, topic, questionId, questions, endedAt, transcribe, transcript,
    presenter, screenFrameRef,
    sendFrame, sendTopic, sendTranscribe, sendTranscript, sendScreen, sendScreenStop, endSession,
  };
}
