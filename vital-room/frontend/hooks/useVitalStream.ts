import { useCallback, useEffect, useRef, useState } from 'react';
import type { VitalResponse } from '@/types';

type Connection = 'connecting' | 'ws' | 'rest';

const WS_URL = 'ws://localhost:8000/ws/vital';
const REST_URL = 'http://localhost:8000/api/vital';
const REQUEST_TIMEOUT_MS = 5000;

export interface VitalStream {
  currentBpm: number | null;
  isAnomalous: boolean;
  stress: number;
  rmssd: number;
  sdnn: number;
  confidence: number;
  snrDb: number;
  effFps: number;
  connection: Connection;
  error: string | null;
  sendFrame: (imageBase64: string) => void;
}

const EMPTY: Omit<VitalStream, 'sendFrame'> = {
  currentBpm: null,
  isAnomalous: false,
  stress: 0,
  rmssd: 0,
  sdnn: 0,
  confidence: 0,
  snrDb: 0,
  effFps: 0,
  connection: 'connecting',
  error: null,
};

/**
 * WebSocket 優先でバイタルを取得し、失敗時は REST にフォールバックする。
 * 送信のバックログを抑えるため、未応答が一定数を超えたらフレームを間引く。
 */
export function useVitalStream(): VitalStream {
  const [state, setState] = useState(EMPTY);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingRef = useRef(0); // 未応答フレーム数
  const restInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const apply = useCallback((data: VitalResponse) => {
    if (!mountedRef.current) return;
    setState((prev) => ({
      ...prev,
      currentBpm: typeof data.current_bpm === 'number' ? data.current_bpm : prev.currentBpm,
      isAnomalous: Boolean(data.is_anomalous),
      stress: data.stress ?? prev.stress,
      rmssd: data.hrv_rmssd ?? prev.rmssd,
      sdnn: data.hrv_sdnn ?? prev.sdnn,
      confidence: data.confidence ?? prev.confidence,
      snrDb: data.snr_db ?? prev.snrDb,
      effFps: data.eff_fps ?? prev.effFps,
      error: null,
    }));
  }, []);

  // WebSocket 接続の確立（失敗時は REST モードへ）
  useEffect(() => {
    mountedRef.current = true;
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        if (mountedRef.current) setState((p) => ({ ...p, connection: 'ws' }));
      };
      ws.onmessage = (ev) => {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        try {
          apply(JSON.parse(ev.data) as VitalResponse);
        } catch {
          /* 壊れたメッセージは無視 */
        }
      };
      ws.onerror = () => {
        if (mountedRef.current) setState((p) => ({ ...p, connection: 'rest' }));
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (mountedRef.current) {
          setState((p) => (p.connection === 'ws' ? { ...p, connection: 'rest' } : p));
        }
      };
    } catch {
      setState((p) => ({ ...p, connection: 'rest' }));
    }

    return () => {
      mountedRef.current = false;
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  }, [apply]);

  // REST フォールバック送信
  const sendRest = useCallback(
    async (imageBase64: string) => {
      if (restInFlightRef.current) return;
      restInFlightRef.current = true;
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(REST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_base64: imageBase64 }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        apply((await res.json()) as VitalResponse);
      } catch (err) {
        if (mountedRef.current) {
          const msg =
            err instanceof DOMException && err.name === 'AbortError'
              ? 'timeout'
              : err instanceof Error
                ? err.message
                : 'network error';
          setState((p) => ({ ...p, error: msg }));
        }
      } finally {
        clearTimeout(to);
        restInFlightRef.current = false;
      }
    },
    [apply],
  );

  const sendFrame = useCallback(
    (imageBase64: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (pendingRef.current > 2) return; // バックログ抑制
        try {
          ws.send(JSON.stringify({ image_base64: imageBase64 }));
          pendingRef.current += 1;
        } catch {
          void sendRest(imageBase64);
        }
      } else {
        void sendRest(imageBase64);
      }
    },
    [sendRest],
  );

  return { ...state, sendFrame };
}
