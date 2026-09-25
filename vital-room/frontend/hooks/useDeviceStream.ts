import { useCallback, useEffect, useState } from 'react';

function mediaError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError') return 'アクセスが許可されていません。ブラウザーの権限を確認して再試行してください。';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '選択した機器が見つかりません。接続と機器の選択を確認してください。';
  if (name === 'NotReadableError') return '機器を使用できません。他のアプリで使用中でないか確認してください。';
  return '機器を起動できませんでした。接続を確認して再試行してください。';
}

/** 切替・画面遷移中に遅れて取得できたストリームも必ず停止する。 */
export function useDeviceStream(kind: 'video' | 'audio', active: boolean, deviceId: string) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    stream: MediaStream | null; error: string | null; loading: boolean;
    deviceId: string; attempt: number;
  }>({ stream: null, error: null, loading: false, deviceId: '', attempt: -1 });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let acquired: MediaStream | null = null;
    const available = typeof navigator.mediaDevices?.getUserMedia === 'function';
    setState({ stream: null, error: null, loading: true, deviceId, attempt });
    const open = async () => {
      try {
        if (!available) throw new Error('unsupported');
        const device = deviceId ? { deviceId: { exact: deviceId } } : {};
        const stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? {
          video: { ...device, width: { ideal: 480 }, height: { ideal: 360 }, facingMode: 'user' },
          audio: false,
        } : { video: false, audio: { ...device, echoCancellation: true, noiseSuppression: true } });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        acquired = stream;
        for (const track of stream.getTracks()) {
          track.onended = () => {
            if (!cancelled) {
              stream.getTracks().forEach((t) => t.stop());
              setState({ stream: null, error: '機器との接続が切れました。接続を確認して再試行してください。', loading: false, deviceId, attempt });
            }
          };
        }
        setState({ stream, error: null, loading: false, deviceId, attempt });
      } catch (error) {
        if (!cancelled) setState({
          stream: null, loading: false, deviceId, attempt,
          error: available ? mediaError(error) : 'カメラ・マイクには HTTPS または localhost でアクセスしてください。',
        });
      }
    };
    void open();
    return () => {
      cancelled = true;
      acquired?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    };
  }, [kind, active, deviceId, attempt]);

  const current = active && state.deviceId === deviceId && state.attempt === attempt;
  return {
    stream: current ? state.stream : null,
    error: current ? state.error : null,
    loading: active && (!current || state.loading),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  };
}
