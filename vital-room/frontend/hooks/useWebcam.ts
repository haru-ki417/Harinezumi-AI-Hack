import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

interface UseWebcamOptions {
  /** キャプチャした純粋な Base64 文字列を受け取るコールバック */
  onFrame: (base64: string) => void;
  /** フレーム取得間隔 (ms)。rPPGを成立させるため 33〜66ms(15〜30fps)推奨 */
  intervalMs?: number;
  /** JPEG 品質 (0.0〜1.0) */
  quality?: number;
}

interface UseWebcamResult {
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  isActive: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

const DATA_URL_PREFIX = /^data:image\/jpeg;base64,/;

export function useWebcam({
  onFrame,
  intervalMs = 40, // 25fps。1fpsではrPPGが原理的に動かないため
  quality = 0.6,
}: UseWebcamOptions): UseWebcamResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // コールバックの最新参照を保持（interval を張り直さないため）
  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 現在フレームを canvas に描画し、純粋な Base64 を返す */
  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    // メタデータ未ロード時は黒フレームを避けてスキップ
    if (video.readyState < 2 || video.videoWidth === 0) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const base64 = dataUrl.replace(DATA_URL_PREFIX, '');
    onFrameRef.current(base64);
  }, [quality]);

  /** ストリーム・タイマーを完全停止（メモリリーク防止の要） */
  const stop = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsActive(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    if (streamRef.current) return; // 二重起動防止

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          // 解像度を抑えて 25fps 送信時のペイロード/CPUを軽くする
          width: { ideal: 480 },
          height: { ideal: 360 },
          facingMode: 'user',
        },
        audio: false,
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        // play() の失敗はユーザー操作待ちの場合があるため握りつぶす
        await video.play().catch(() => undefined);
      }

      setIsActive(true);
      if (intervalRef.current === null) {
        intervalRef.current = setInterval(captureFrame, intervalMs);
      }
    } catch (err) {
      streamRef.current = null;
      setError(err instanceof Error ? err.message : 'カメラの起動に失敗しました');
      setIsActive(false);
    }
  }, [captureFrame, intervalMs]);

  // アンマウント時に必ずクリーンアップ
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { videoRef, canvasRef, isActive, error, start, stop };
}
