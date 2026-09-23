import { useCallback, useRef, useState } from 'react';
import type { VitalResponse } from '@/types';

const API_ENDPOINT = 'http://localhost:8000/api/vital';
const REQUEST_TIMEOUT_MS = 5000;

interface UseVitalAPIResult {
  currentBpm: number | null;
  isAnomalous: boolean;
  error: string | null;
  sendFrame: (imageBase64: string) => Promise<void>;
}

export function useVitalAPI(): UseVitalAPIResult {
  const [currentBpm, setCurrentBpm] = useState<number | null>(null);
  const [isAnomalous, setIsAnomalous] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // バックエンドが遅い場合にリクエストが積み上がるのを防ぐ
  const inFlightRef = useRef<boolean>(false);

  const sendFrame = useCallback(async (imageBase64: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_base64: imageBase64 }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = (await res.json()) as VitalResponse;

      // 最低限のランタイムガード
      if (typeof data.current_bpm === 'number') {
        setCurrentBpm(data.current_bpm);
      }
      setIsAnomalous(Boolean(data.is_anomalous));
      setError(null);
    } catch (err) {
      // フェイルセーフ: 直前の値は保持し、エラーは静かに記録するだけ
      const message =
        err instanceof DOMException && err.name === 'AbortError'
          ? 'timeout'
          : err instanceof Error
            ? err.message
            : 'network error';
      setError(message);
    } finally {
      clearTimeout(timeoutId);
      inFlightRef.current = false;
    }
  }, []);

  return { currentBpm, isAnomalous, error, sendFrame };
}
