import { useCallback, useRef, useState } from 'react';

interface Options {
  /** 画面フレーム(base64 JPEG)を受け取る。数fpsで呼ばれる。 */
  onFrame: (base64: string) => void;
  /** 共有停止時に呼ばれる(サーバへ screen_stop を送る用) */
  onStop: () => void;
  fps?: number;       // 送信フレームレート(資料表示は5fpsで十分)
  maxWidth?: number;  // 送信解像度の上限(帯域を抑える)
  quality?: number;   // JPEG品質
}

export interface ScreenShare {
  sharing: boolean;
  stream: MediaStream | null;
  start: () => Promise<void>;
  stop: () => void;
}

const JPEG_PREFIX = /^data:image\/jpeg;base64,/;

/**
 * getDisplayMedia で画面/ウィンドウ/タブを取得し、数fpsで JPEG フレームを送る。
 * 音声そのものは扱わず、画像フレームだけを中継する(既存の心拍フレームと同方式)。
 * ブラウザUIの「共有を停止」にも追従する。
 */
export function useScreenShare({
  onFrame, onStop, fps = 5, maxWidth = 1280, quality = 0.6,
}: Options): ScreenShare {
  const [sharing, setSharing] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const onFrameRef = useRef(onFrame); onFrameRef.current = onFrame;
  const onStopRef = useRef(onStop); onStopRef.current = onStop;

  const stop = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    streamRef.current = null;
    if (videoRef.current) { try { videoRef.current.srcObject = null; } catch { /* noop */ } }
    videoRef.current = null;
    setStream(null);
    setSharing(false);
    onStopRef.current();
  }, []);

  const start = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const md = navigator.mediaDevices as any;
      const s: MediaStream = await md.getDisplayMedia({
        video: { frameRate: 10 }, audio: false,
      });
      streamRef.current = s;
      setStream(s);
      setSharing(true);
      // ブラウザ標準の「共有を停止」に追従
      s.getVideoTracks()[0]?.addEventListener('ended', () => stop());

      const v = document.createElement('video');
      v.srcObject = s; v.muted = true; v.playsInline = true;
      await v.play().catch(() => undefined);
      videoRef.current = v;

      const canvas = canvasRef.current ?? document.createElement('canvas');
      canvasRef.current = canvas;

      timerRef.current = setInterval(() => {
        const vid = videoRef.current;
        if (!vid || vid.videoWidth === 0) return;
        const scale = Math.min(1, maxWidth / vid.videoWidth);
        canvas.width = Math.round(vid.videoWidth * scale);
        canvas.height = Math.round(vid.videoHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
        const b64 = canvas.toDataURL('image/jpeg', quality).replace(JPEG_PREFIX, '');
        onFrameRef.current(b64);
      }, Math.round(1000 / fps));
    } catch {
      // ユーザーがキャンセル/権限拒否/非対応
      stop();
    }
  }, [fps, maxWidth, quality, stop]);

  return { sharing, stream, start, stop };
}
