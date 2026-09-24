import { useEffect, useRef, useState, type RefObject } from 'react';

export type BgMode = 'none' | 'blur' | 'image';
export type BgStatus = 'idle' | 'loading' | 'ready' | 'error';

// MediaPipe tasks-vision の WASM とセルフィー・セグメンテーションモデル(CDN)
const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

function drawCover(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  w: number,
  h: number,
  iw: number,
  ih: number,
) {
  const ir = iw / ih;
  const cr = w / h;
  let dw: number, dh: number, dx: number, dy: number;
  if (ir > cr) { dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0; }
  else { dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2; }
  ctx.drawImage(img, dx, dy, dw, dh);
}

/**
 * 背景ぼかし / 背景差し替え(Zoom風)。人物を切り抜いて背景だけ加工する。
 * 生の <video>(videoRef) は加工せず温存するので、rPPG(心拍推定)には影響しない。
 * mode==='none' の間はループを回さない(canvasは隠す運用)。
 */
export function useBackgroundFx(
  videoRef: RefObject<HTMLVideoElement | null>,
  mode: BgMode,
  bgImageRef: RefObject<HTMLImageElement | null>,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const segmenterRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const modeRef = useRef<BgMode>(mode);
  modeRef.current = mode;
  const [status, setStatus] = useState<BgStatus>('idle');

  // セグメンターの遅延ロード(初めて mode!=='none' になったとき)
  useEffect(() => {
    if (mode === 'none' || segmenterRef.current) return;
    let cancelled = false;
    setStatus('loading');
    (async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE);
        const seg = await vision.ImageSegmenter.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          outputCategoryMask: false,
          outputConfidenceMasks: true,
        });
        if (cancelled) { seg.close(); return; }
        segmenterRef.current = seg;
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  // 描画ループ
  useEffect(() => {
    if (mode === 'none') return;
    let running = true;

    const ensureMask = (w: number, h: number) => {
      if (!maskCanvasRef.current) maskCanvasRef.current = document.createElement('canvas');
      const m = maskCanvasRef.current;
      if (m.width !== w || m.height !== h) { m.width = w; m.height = h; }
      return m;
    };

    const loop = () => {
      if (!running) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const seg: any = segmenterRef.current;

      if (video && canvas && video.readyState >= 2 && video.videoWidth > 0) {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          let composed = false;
          if (seg) {
            try {
              const res = seg.segmentForVideo(video, performance.now());
              const cmask = res.confidenceMasks && res.confidenceMasks[0];
              if (cmask) {
                const f: Float32Array = cmask.getAsFloat32Array();
                const m = ensureMask(w, h);
                const mctx = m.getContext('2d');
                if (mctx) {
                  const img = mctx.createImageData(w, h);
                  for (let i = 0; i < f.length; i++) {
                    const a = f[i] < 0 ? 0 : f[i] > 1 ? 1 : f[i];
                    img.data[i * 4 + 3] = (a * 255) | 0;
                  }
                  mctx.putImageData(img, 0, 0);

                  ctx.save();
                  ctx.clearRect(0, 0, w, h);
                  ctx.globalCompositeOperation = 'source-over';
                  ctx.drawImage(video, 0, 0, w, h);         // 人物(全面)
                  ctx.globalCompositeOperation = 'destination-in';
                  ctx.drawImage(m, 0, 0, w, h);             // マスクで人物だけ残す
                  ctx.globalCompositeOperation = 'destination-over';
                  if (modeRef.current === 'blur') {
                    ctx.filter = 'blur(14px)';
                    ctx.drawImage(video, 0, 0, w, h);        // 背景=ぼかし映像
                    ctx.filter = 'none';
                  } else {
                    const bg = bgImageRef.current;
                    if (bg && bg.complete && bg.naturalWidth > 0) {
                      drawCover(ctx, bg, w, h, bg.naturalWidth, bg.naturalHeight);
                    } else {
                      const g = ctx.createLinearGradient(0, 0, w, h);
                      g.addColorStop(0, '#2b3a67');
                      g.addColorStop(1, '#141426');
                      ctx.fillStyle = g;
                      ctx.fillRect(0, 0, w, h);
                    }
                  }
                  ctx.restore();
                  ctx.globalCompositeOperation = 'source-over';
                  composed = true;
                }
              }
              if (typeof res.close === 'function') res.close();
            } catch {
              composed = false;
            }
          }
          if (!composed) {
            // 未ロード/失敗時は生映像をそのまま表示(壊さない)
            ctx.globalCompositeOperation = 'source-over';
            ctx.drawImage(video, 0, 0, w, h);
          }
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [mode, status, videoRef, bgImageRef]);

  // アンマウント時にセグメンター解放
  useEffect(() => () => {
    try { segmenterRef.current?.close?.(); } catch { /* noop */ }
    segmenterRef.current = null;
  }, []);

  return { canvasRef, status };
}
