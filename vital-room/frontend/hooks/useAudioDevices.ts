import { useCallback, useEffect, useRef, useState } from 'react';

export interface AudioDevices {
  mics: MediaDeviceInfo[];
  speakers: MediaDeviceInfo[];
  selectedMic: string;
  selectedSpeaker: string;
  /** 0..1 の現在入力レベル。React状態ではなくrefで持つ(60fps再描画を避ける) */
  micLevelRef: { current: number };
  micActive: boolean;         // 選択マイクのストリームが開けているか
  speakerSupported: boolean;  // setSinkId 対応か(Chrome/Edgeは対応)
  selectMic: (id: string) => void;
  selectSpeaker: (id: string) => void;
  testSpeaker: () => void;    // 選択スピーカーへテスト音(440Hz)
}

/**
 * マイク/スピーカーの列挙・選択・動作確認をまとめて扱う。
 *  - マイク: 選択したデバイスを getUserMedia で開き、入力レベルを可視化。
 *    (注: 文字起こしの Web Speech API は端末の既定マイクを使う仕様)
 *  - スピーカー: setSinkId で選択出力にテスト音を鳴らせる。
 *    このアプリは音声を相手へ送らない設計のため、通常は音は流れない。
 * active が true の間だけデバイスを開く。
 */
export function useAudioDevices(active: boolean, muted = false): AudioDevices {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [selectedMic, setSelectedMic] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const micLevelRef = useRef(0); // 再描画を起こさずに更新する
  const [micActive, setMicActive] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);

  const speakerSupported =
    typeof window !== 'undefined' &&
    typeof (document.createElement('audio') as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    }).setSinkId === 'function';

  // デバイス列挙(権限取得後にラベルが入る)。抜き差しにも追従。
  useEffect(() => {
    if (!active) { setMics([]); setSpeakers([]); return; }
    const refresh = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const ins = list.filter((d) => d.kind === 'audioinput');
        const outs = list.filter((d) => d.kind === 'audiooutput');
        setMics(ins);
        setSpeakers(outs);
        setSelectedMic((cur) =>
          cur && ins.some((d) => d.deviceId === cur) ? cur : (ins[0]?.deviceId || ''),
        );
        setSelectedSpeaker((cur) =>
          cur && outs.some((d) => d.deviceId === cur) ? cur : (outs[0]?.deviceId || ''),
        );
      } catch {
        /* noop */
      }
    };
    refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
  }, [active]);

  // 選択マイクを開いてレベルメーターを回す。ミュート中は開かない。
  // selectedMic が空(=まだ許可が無い/ラベル未取得)でも、既定マイクを開いて
  // 許可を得る→ラベル付きで再列挙する。
  useEffect(() => {
    if (!active || muted) { micLevelRef.current = 0; setMicActive(false); return; }
    let cancelled = false;

    const stop = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      streamRef.current = null;
      try { ctxRef.current?.close(); } catch { /* noop */ }
      ctxRef.current = null;
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        setMicActive(true);

        // 許可が付いたのでラベル付きで再列挙し、未選択なら実デバイスを採用。
        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          const ins = list.filter((d) => d.kind === 'audioinput');
          const outs = list.filter((d) => d.kind === 'audiooutput');
          if (!cancelled) {
            if (ins.length) setMics(ins);
            if (outs.length) setSpeakers(outs);
            if (!selectedMic) {
              const id = stream.getAudioTracks()[0]?.getSettings?.().deviceId
                || ins[0]?.deviceId || '';
              if (id) setSelectedMic(id);
            }
            setSelectedSpeaker((cur) =>
              cur && outs.some((d) => d.deviceId === cur) ? cur : (outs[0]?.deviceId || cur));
          }
        } catch { /* noop */ }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const AC: any = window.AudioContext || (window as any).webkitAudioContext;
        const ctx: AudioContext = new AC();
        ctxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);

        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const x = (buf[i] - 128) / 128; // -1..1
            sum += x * x;
          }
          const rms = Math.sqrt(sum / buf.length);      // 0..~1
          const level = Math.min(1, rms * 2.2);         // 見やすいようゲイン
          // setState せず ref を更新(ページ全体の再描画を避ける)
          micLevelRef.current = micLevelRef.current * 0.6 + level * 0.4;
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!cancelled) { micLevelRef.current = 0; setMicActive(false); }
      }
    })();

    return () => { cancelled = true; stop(); micLevelRef.current = 0; setMicActive(false); };
  }, [active, muted, selectedMic]);

  const selectMic = useCallback((id: string) => setSelectedMic(id), []);
  const selectSpeaker = useCallback((id: string) => setSelectedSpeaker(id), []);

  const testSpeaker = useCallback(() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const AC: any = window.AudioContext || (window as any).webkitAudioContext;
      const ctx: AudioContext = new AC();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.08;
      osc.frequency.value = 440;
      const dest = ctx.createMediaStreamDestination();
      osc.connect(gain).connect(dest);

      const el = new Audio();
      el.srcObject = dest.stream;
      const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      const play = async () => {
        if (selectedSpeaker && withSink.setSinkId) {
          try { await withSink.setSinkId(selectedSpeaker); } catch { /* 既定へ */ }
        }
        try { await el.play(); } catch { /* noop */ }
        osc.start();
        setTimeout(() => {
          try { osc.stop(); } catch { /* noop */ }
          try { ctx.close(); } catch { /* noop */ }
        }, 350);
      };
      play();
    } catch {
      /* noop */
    }
  }, [selectedSpeaker]);

  return {
    mics, speakers, selectedMic, selectedSpeaker, micLevelRef, micActive, speakerSupported,
    selectMic, selectSpeaker, testSpeaker,
  };
}
