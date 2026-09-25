'use client';

import { useEffect, useRef, useState } from 'react';
import type { ImageSegmenter } from '@mediapipe/tasks-vision';
import styles from './CameraPreview.module.css';

export type Background = 'none' | 'blur' | 'slate' | 'cream';
export interface CameraSettings {
  enabled: boolean;
  deviceId: string;
  background: Background;
  brightness: number;
  mirrored: boolean;
}

export function CameraPreview({ stream, settings, className = '', onReady }: {
  stream: MediaStream | null;
  settings: CameraSettings;
  className?: string;
  onReady?: (ready: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const { background, brightness, mirrored } = settings;

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    let cancelled = false;
    let frame = 0;
    let segmenter: ImageSegmenter | undefined;
    let lastTime = -1;
    let lastFrameAt = 0;
    let ready = false;
    setStatus('loading');
    onReady?.(false);
    video.srcObject = stream;
    if (!stream) return;
    const timeout = window.setTimeout(() => {
      if (!ready && !cancelled) { setStatus('error'); onReady?.(false); }
    }, 20000);

    const markReady = () => {
      if (ready || cancelled) return;
      ready = true;
      window.clearTimeout(timeout);
      setStatus('ready');
      onReady?.(true);
    };
    const render = (now: number) => {
      if (cancelled) return;
      if (video.readyState >= 2 && video.videoWidth > 0 && video.currentTime !== lastTime && now - lastFrameAt >= 66) {
        lastTime = video.currentTime;
        lastFrameAt = now;
        if (background === 'none') {
          markReady();
        } else if (segmenter) {
          try {
            if (canvas.width !== video.videoWidth) canvas.width = video.videoWidth;
            if (canvas.height !== video.videoHeight) canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Canvas is unavailable');
            segmenter.segmentForVideo(video, now, (result) => {
              // 2チャネル出力では index 1 が人物。単一チャネル版も人物の確率。
              const masks = result.confidenceMasks;
              const mask = masks?.[masks.length - 1];
              if (!mask) throw new Error('Person mask is unavailable');
              const values = mask.getAsFloat32Array();
              maskCanvas.width = mask.width;
              maskCanvas.height = mask.height;
              const maskCtx = maskCanvas.getContext('2d')!;
              const pixels = maskCtx.createImageData(mask.width, mask.height);
              for (let i = 0; i < values.length; i++) {
                pixels.data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, (values[i] - 0.25) / 0.5)) * 255);
              }
              maskCtx.putImageData(pixels, 0, 0);
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              ctx.globalCompositeOperation = 'source-over';
              ctx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
              ctx.globalCompositeOperation = 'source-in';
              ctx.drawImage(video, 0, 0);
              ctx.globalCompositeOperation = 'destination-over';
              if (background === 'blur') {
                ctx.filter = 'blur(14px)';
                ctx.drawImage(video, -20, -20, canvas.width + 40, canvas.height + 40);
                ctx.filter = 'none';
              } else {
                ctx.fillStyle = background === 'slate' ? '#334155' : '#e8dfd0';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
              }
              ctx.globalCompositeOperation = 'source-over';
            });
            markReady();
          } catch {
            setStatus('error');
            onReady?.(false);
            return;
          }
        }
      }
      frame = requestAnimationFrame(render);
    };
    const maskCanvas = document.createElement('canvas');
    const start = async () => {
      try {
        await video.play();
        if (background !== 'none') {
          const { FilesetResolver, ImageSegmenter } = await import('@mediapipe/tasks-vision');
          const files = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm');
          if (cancelled) return;
          const created = await ImageSegmenter.createFromOptions(files, {
            baseOptions: {
              modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
            },
            runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true,
          });
          if (cancelled) { created.close(); return; }
          segmenter = created;
        }
        if (!cancelled) frame = requestAnimationFrame(render);
      } catch {
        if (!cancelled) { setStatus('error'); onReady?.(false); }
      }
    };
    void start();
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      cancelAnimationFrame(frame);
      segmenter?.close();
      video.pause();
      video.srcObject = null;
    };
  }, [stream, background, attempt, onReady]);

  const visualStyle = { transform: mirrored ? 'scaleX(-1)' : undefined, filter: `brightness(${brightness}%)` };
  return (
    <div className={`${styles.preview} ${className}`} aria-label="カメラプレビュー">
      <video ref={videoRef} autoPlay playsInline muted style={visualStyle}
        className={background === 'none' && stream && status === 'ready' ? styles.media : styles.hidden} />
      <canvas ref={canvasRef} style={visualStyle} aria-label="背景加工済みのカメラ映像"
        className={background !== 'none' && stream && status === 'ready' ? styles.media : styles.hidden} />
      {(!stream || status !== 'ready') && (
        <div className={styles.message} role="status">
          {!settings.enabled ? 'カメラはオフです' : !stream ? 'カメラ映像を待っています' : status === 'error' ? (
            <><span>プレビューを表示できません。接続環境を確認して再試行してください。</span>
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>プレビューを再試行</button></>
          ) : background === 'none' ? 'カメラを準備しています…' : '背景加工を準備しています…'}
        </div>
      )}
    </div>
  );
}
