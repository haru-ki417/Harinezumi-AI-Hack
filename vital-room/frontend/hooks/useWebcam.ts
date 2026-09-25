import { useEffect, useRef } from 'react';
import { useDeviceStream } from './useDeviceStream';

interface UseWebcamOptions {
  active: boolean;
  deviceId: string;
  /** プレビュー中は false。面接に参加するまで画像を送らない。 */
  transmitting: boolean;
  onFrame: (base64: string) => void;
  intervalMs?: number;
  quality?: number;
}

export function useWebcam({
  active, deviceId, transmitting, onFrame, intervalMs = 40, quality = 0.6,
}: UseWebcamOptions) {
  const camera = useDeviceStream('video', active, deviceId);
  const onFrameRef = useRef(onFrame);
  useEffect(() => { onFrameRef.current = onFrame; }, [onFrame]);

  useEffect(() => {
    if (!camera.stream || !transmitting) return;
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = camera.stream;
    void video.play().catch(() => undefined);
    const timer = window.setInterval(() => {
      if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
      if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
      if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      // rPPG の色変化を壊さないよう、表示用の背景・明るさ加工は計測に適用しない。
      ctx.drawImage(video, 0, 0);
      onFrameRef.current(canvas.toDataURL('image/jpeg', quality).replace(/^data:image\/jpeg;base64,/, ''));
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
      video.pause();
      video.srcObject = null;
    };
  }, [camera.stream, transmitting, intervalMs, quality]);

  return camera;
}
