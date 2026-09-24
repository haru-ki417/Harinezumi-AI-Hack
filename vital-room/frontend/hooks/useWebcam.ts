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
  /** 起動。deviceId を渡すとそのカメラで起動 */
  start: (deviceId?: string) => Promise<void>;
  stop: () => void;
  /** 起動中にカメラを切り替える(停止→指定カメラで再起動) */
  switchCamera: (deviceId: string) => Promise<void>;
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

  const onFrameRef = useRef(onFrame);
  useEffect(() => {
    onFrameRef.current = onFrame;
  }, [onFrame]);

  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
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

  /** ストリームだけ止める(切替時に使う。intervalは維持) */
  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, []);

  /** 完全停止(タイマーも止める) */
  const stop = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    stopStream();
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsActive(false);
  }, [stopStream]);

  const start = useCallback(
    async (deviceId?: string) => {
      setError(null);
      stopStream(); // 既存があれば止めてから(切替対応)

      try {
        const videoConstraints: MediaTrackConstraints = {
          width: { ideal: 480 },
          height: { ideal: 360 },
        };
        if (deviceId) {
          videoConstraints.deviceId = { exact: deviceId };
        } else {
          videoConstraints.facingMode = 'user';
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
        streamRef.current = stream;

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => undefined);
        }

        setIsActive(true);
        if (intervalRef.current === null) {
          intervalRef.current = setInterval(captureFrame, intervalMs);
        }
      } catch (err) {
        stopStream();
        setError(err instanceof Error ? err.message : 'カメラの起動に失敗しました');
        setIsActive(false);
      }
    },
    [captureFrame, intervalMs, stopStream],
  );

  const switchCamera = useCallback(
    async (deviceId: string) => {
      await start(deviceId);
    },
    [start],
  );

  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  return { videoRef, canvasRef, isActive, error, start, stop, switchCamera };
}
