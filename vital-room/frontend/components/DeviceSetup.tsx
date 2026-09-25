'use client';

import { useEffect, useRef, useState } from 'react';
import { CameraPreview, type Background, type CameraSettings } from './CameraPreview';
import { useDeviceStream } from '@/hooks/useDeviceStream';
import styles from './DeviceSetup.module.css';

export interface AudioSettings { enabled: boolean; deviceId: string; outputId: string }
interface Props {
  name: string;
  camera: ReturnType<typeof useDeviceStream>;
  settings: CameraSettings;
  audio: AudioSettings;
  onCameraChange: (settings: CameraSettings) => void;
  onAudioChange: (settings: AudioSettings) => void;
  onBack: () => void;
  onJoin: () => void;
}

function MicrophoneMeter({ stream }: { stream: MediaStream | null }) {
  const contextRef = useRef<AudioContext | null>(null);
  const [level, setLevel] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    setLevel(0);
    setError(false);
    if (!stream) return;
    let context: AudioContext;
    try { context = new AudioContext(); } catch { setError(true); return; }
    contextRef.current = context;
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser); // スピーカーには接続せず、ハウリングを防ぐ。
    const data = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => {
      setSuspended(context.state === 'suspended');
      analyser.getByteTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / data.length);
      setLevel(Math.min(100, Math.round(rms * 400)));
    }, 100);
    return () => {
      window.clearInterval(timer);
      source.disconnect();
      analyser.disconnect();
      void context.close();
      contextRef.current = null;
    };
  }, [stream]);
  return (
    <div>
      <label className={styles.meterLabel}>マイク入力 <meter min={0} max={100} value={level} aria-label="マイク入力レベル" /></label>
      {stream && suspended && <button type="button" onClick={() => {
        void contextRef.current?.resume().catch(() => setError(true));
      }}>マイクの入力確認を開始</button>}
      {error && <p role="alert">このブラウザーではマイクの入力レベルを確認できません。</p>}
      <p className={styles.hint}>話しかけるとメーターが動きます。音声は録音・送信されません。</p>
    </div>
  );
}

export function DeviceSetup({ name, camera, settings, audio, onCameraChange, onAudioChange, onBack, onJoin }: Props) {
  const mic = useDeviceStream('audio', audio.enabled, audio.deviceId);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState('');
  const [previewReady, setPreviewReady] = useState(false);
  const [sinkSupported, setSinkSupported] = useState(false);
  const [testing, setTesting] = useState(false);
  const [speakerError, setSpeakerError] = useState('');
  const stopTest = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSinkSupported('setSinkId' in HTMLMediaElement.prototype);
    return () => { stopTest.current?.(); };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const list = await navigator.mediaDevices.enumerateDevices();
        if (!cancelled) { setDevices(list); setDeviceError(''); }
      } catch {
        if (!cancelled) setDeviceError('機器の一覧を取得できません。ブラウザーの権限を確認してください。');
      }
    };
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => { cancelled = true; navigator.mediaDevices?.removeEventListener('devicechange', refresh); };
  }, [camera.stream, mic.stream]);

  const options = (kind: MediaDeviceKind, selected: string) => {
    const list = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default');
    return <>
      <option value="">システムの既定</option>
      {selected && !list.some((d) => d.deviceId === selected) && <option value={selected}>選択した機器（未接続）</option>}
      {list.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `機器 ${i + 1}`}</option>)}
    </>;
  };

  const testSpeaker = async () => {
    stopTest.current?.();
    setSpeakerError('');
    setTesting(true);
    let context: AudioContext | undefined;
    let output: HTMLAudioElement | undefined;
    let timer: number | undefined;
    let cancelled = false;
    const cleanup = () => {
      cancelled = true;
      window.clearTimeout(timer);
      output?.pause();
      if (output) output.srcObject = null;
      if (context && context.state !== 'closed') void context.close();
    };
    stopTest.current = cleanup;
    try {
      context = new AudioContext();
      await context.resume();
      if (cancelled) return;
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.08;
      oscillator.connect(gain).connect(destination);
      output = new Audio();
      output.srcObject = destination.stream;
      if (audio.outputId && 'setSinkId' in output) {
        await (output as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(audio.outputId);
      }
      if (cancelled) return;
      await output.play();
      if (cancelled) return;
      oscillator.start();
      oscillator.stop(context.currentTime + 0.8);
      timer = window.setTimeout(() => { cleanup(); setTesting(false); }, 1000);
    } catch {
      if (!cancelled) {
        setSpeakerError('テスト音を再生できません。出力先や音量を確認してください。');
        setTesting(false);
        cleanup();
      }
    }
  };

  const changeCamera = (patch: Partial<CameraSettings>) => {
    if ('background' in patch || 'deviceId' in patch || 'enabled' in patch) setPreviewReady(false);
    onCameraChange({ ...settings, ...patch });
  };
  const canJoin = !settings.enabled || (!!camera.stream && previewReady && !camera.loading && !camera.error);
  return (
    <main className={styles.wrap}>
      <div className={styles.panel}>
        <div className={styles.grid}>
          <section className={styles.previewColumn} aria-label="映り方の確認">
            <CameraPreview stream={camera.stream} settings={settings} className={styles.preview} onReady={setPreviewReady} />
            <div className={styles.deviceButtons}>
              <button type="button" aria-label="カメラ" aria-pressed={settings.enabled}
                title={settings.enabled ? 'カメラをオフにする' : 'カメラをオンにする'}
                onClick={() => changeCamera({ enabled: !settings.enabled })}>
                <span className={styles.deviceDot} aria-hidden="true" />
                カメラ {settings.enabled ? 'オン' : 'オフ'}
              </button>
              <button type="button" aria-label="マイク" aria-pressed={audio.enabled}
                title={audio.enabled ? 'マイクをオフにする' : 'マイクをオンにする'}
                onClick={() => onAudioChange({ ...audio, enabled: !audio.enabled })}>
                <span className={styles.deviceDot} aria-hidden="true" />
                マイク {audio.enabled ? 'オン' : 'オフ'}
              </button>
            </div>
            <div className={styles.actions}>
              <button type="button" onClick={onBack}>前の画面に戻る</button>
              <button type="button" className={styles.primary} disabled={!canJoin} onClick={onJoin}>面接に接続</button>
            </div>
          </section>
          <section className={styles.settingsScroll} aria-label="設定項目" tabIndex={0}>
            <p className={styles.step}>ステップ 2 / 3 · 入室前の確認</p>
            <h1>カメラ・音声・背景の設定</h1>
            <p className={styles.intro}>{name} さん、映り方と音声を確認してください。「面接に接続」を押すとバイタルの計測・共有を開始し、入室が完了するとチャットも使えます。</p>
            {camera.loading && <p role="status">カメラの許可を確認しています…</p>}
            {camera.error && <div className={styles.error} role="alert">{camera.error}
              <button type="button" onClick={camera.retry}>カメラを再試行</button></div>}
            {!settings.enabled && <p className={styles.hint}>カメラをオフにして参加すると、自分のバイタルは計測されません。</p>}
            <p className={styles.hint}>背景・明るさの設定は面接画面にも引き継がれます。</p>
            <div className={styles.controls}>
              <fieldset>
                <legend>カメラ</legend>
                <label>使用するカメラ<select value={settings.deviceId} disabled={!settings.enabled}
                  onChange={(e) => changeCamera({ deviceId: e.target.value })}>{options('videoinput', settings.deviceId)}</select></label>
                <label className={styles.check}><input type="checkbox" checked={settings.mirrored}
                  onChange={(e) => changeCamera({ mirrored: e.target.checked })} />左右を反転して表示</label>
              </fieldset>
              <fieldset>
                <legend>背景と明るさ</legend>
                <label>背景<select value={settings.background} onChange={(e) => changeCamera({ background: e.target.value as Background })}>
                  <option value="none">なし</option><option value="blur">背景をぼかす</option>
                  <option value="slate">スレート</option><option value="cream">クリーム</option>
                </select></label>
                <label>明るさ {settings.brightness}%<input type="range" min={70} max={130} step={5} value={settings.brightness}
                  onChange={(e) => changeCamera({ brightness: Number(e.target.value) })} /></label>
              </fieldset>
              <fieldset>
                <legend>音声の確認</legend>
                <label>マイク<select value={audio.deviceId} disabled={!audio.enabled}
                  onChange={(e) => onAudioChange({ ...audio, deviceId: e.target.value })}>{options('audioinput', audio.deviceId)}</select></label>
                {mic.loading && <p role="status">マイクの許可を確認しています…</p>}
                {mic.error && <div className={styles.error} role="alert">{mic.error}
                  <button type="button" onClick={mic.retry}>マイクを再試行</button></div>}
                <MicrophoneMeter stream={mic.stream} />
                <label>スピーカー<select disabled={!sinkSupported || testing} value={audio.outputId}
                  onChange={(e) => onAudioChange({ ...audio, outputId: e.target.value })}>{options('audiooutput', audio.outputId)}</select></label>
                {!sinkSupported && <p className={styles.hint}>出力先の変更は端末の音声設定で行ってください。</p>}
                <button type="button" disabled={testing} onClick={() => void testSpeaker()}>{testing ? 'テスト音を再生中…' : 'スピーカーをテスト'}</button>
                {speakerError && <p role="alert" className={styles.error}>{speakerError}</p>}
              </fieldset>
              {deviceError && <p role="alert" className={styles.error}>{deviceError}</p>}
            </div>
            <p className={styles.hint}>このルームではバイタル値を共有します。相手への映像・音声の配信はありません。</p>
          </section>
        </div>
      </div>
    </main>
  );
}
