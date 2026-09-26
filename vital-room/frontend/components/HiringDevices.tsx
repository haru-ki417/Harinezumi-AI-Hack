'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './Hiring.module.css';

const DEVICE_KEY = 'hiring_devices';
export function useHiringDevices(autoStart = false) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camera, setCameraValue] = useState(true);
  const [microphone, setMicrophoneValue] = useState(true);
  const [videoDevice, setVideoDeviceValue] = useState('');
  const [audioDevice, setAudioDeviceValue] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [ready, setReady] = useState(false);
  const current = useRef<MediaStream | null>(null);
  const acquiring = useRef(new Set<MediaStream>());
  const request = useRef(0);
  const stopAcquiring = useCallback(() => { acquiring.current.forEach(stream => stream.getTracks().forEach(t => t.stop())); acquiring.current.clear(); }, []);
  const stopAll = useCallback(() => { request.current++; stopAcquiring(); current.current?.getTracks().forEach(t => t.stop()); }, [stopAcquiring]);
  useEffect(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(DEVICE_KEY) || 'null'); if (saved) { setCameraValue(saved.camera !== false); setMicrophoneValue(saved.microphone !== false); setVideoDeviceValue(saved.videoDevice || ''); setAudioDeviceValue(saved.audioDevice || ''); } } catch { /* use defaults */ }
    setReady(true);
    return stopAll;
  }, [stopAll]);
  const cancelCheck = () => { request.current++; stopAcquiring(); setLoading(false); setChecked(false); };
  const setCamera = (value: boolean) => { cancelCheck(); if (!value) current.current?.getVideoTracks().forEach(t => t.stop()); setCameraValue(value); };
  const setMicrophone = (value: boolean) => { cancelCheck(); if (!value) current.current?.getAudioTracks().forEach(t => t.stop()); setMicrophoneValue(value); };
  const setVideoDevice = (value: string) => { cancelCheck(); current.current?.getVideoTracks().forEach(t => t.stop()); setVideoDeviceValue(value); };
  const setAudioDevice = (value: string) => { cancelCheck(); current.current?.getAudioTracks().forEach(t => t.stop()); setAudioDeviceValue(value); };
  useEffect(() => { try { if (ready) sessionStorage.setItem(DEVICE_KEY, JSON.stringify({ camera, microphone, videoDevice, audioDevice })); } catch { /* The join form explains unavailable storage before claiming an invitation. */ } }, [ready, camera, microphone, videoDevice, audioDevice]);
  const start = useCallback(async () => {
    const id = ++request.current;
    stopAcquiring();
    setLoading(true); setError(''); setChecked(false);
    current.current?.getTracks().forEach(t => t.stop()); current.current = null; setStream(null);
    try { sessionStorage.setItem(DEVICE_KEY, JSON.stringify({ camera, microphone, videoDevice, audioDevice })); } catch { /* Keep device controls usable when storage is blocked. */ }
    if ((!camera && !microphone)) { setChecked(true); setLoading(false); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError('カメラ・マイクにはHTTPS接続と対応ブラウザーが必要です。オフにしてテキストで参加することもできます。'); setLoading(false); return; }
    const capture = (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints).then(result => {
      // A second permission prompt can remain open after the first track starts.
      // Track every resolved stream immediately so off/unmount can stop it now.
      if (id !== request.current) { result.getTracks().forEach(t => t.stop()); return null; }
      acquiring.current.add(result); return result;
    });
    const results = await Promise.allSettled([
      camera ? capture({ video: videoDevice ? { deviceId: { exact: videoDevice } } : true }) : Promise.resolve(null),
      microphone ? capture({ audio: audioDevice ? { deviceId: { exact: audioDevice } } : true }) : Promise.resolve(null),
    ]);
    const tracks: MediaStreamTrack[] = [];
    results.forEach(result => { if (result.status === 'fulfilled') { tracks.push(...(result.value?.getTracks() || [])); if (result.value) acquiring.current.delete(result.value); } });
    if (id !== request.current) { tracks.forEach(t => t.stop()); return; }
    const combined = new MediaStream(tracks); current.current = combined; setStream(combined); setLoading(false); setChecked(results.every(r => r.status === 'fulfilled'));
    const failures = results.flatMap((r, index) => r.status === 'rejected' ? [index === 0 ? 'カメラ' : 'マイク'] : []);
    if (failures.length) setError(`${failures.join('・')}を開始できません。ブラウザーの権限・使用中のアプリを確認するか、該当機器をオフにしてください。`);
    try { const list = await navigator.mediaDevices.enumerateDevices(); if (id === request.current) setDevices(list); } catch { /* selected devices still usable */ }
  }, [camera, microphone, videoDevice, audioDevice, stopAcquiring]);
  useEffect(() => { if (ready && autoStart) void start(); }, [ready, autoStart, start]);
  return { stream, camera, microphone, videoDevice, audioDevice, devices, error, loading, checked, start, setCamera, setMicrophone, setVideoDevice, setAudioDevice };
}

export function StreamVideo({ stream, muted = true, small = false }: { stream: MediaStream | null; muted?: boolean; small?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current) { ref.current.srcObject = stream; void ref.current.play().catch(() => undefined); } }, [stream]);
  return <video aria-label={muted ? '自分のカメラ映像' : '相手の映像と音声'} ref={ref} autoPlay muted={muted} playsInline controls={!muted} className={small ? styles.videoSmall : styles.video} />;
}

export function HiringDeviceControls({ device, preview = true }: { device: ReturnType<typeof useHiringDevices>; preview?: boolean }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!device.stream?.getAudioTracks().length) { setLevel(0); return; }
    let context: AudioContext;
    try { context = new AudioContext(); } catch { return; }
    const source = context.createMediaStreamSource(device.stream); const analyser = context.createAnalyser(); analyser.fftSize = 256; source.connect(analyser);
    const values = new Uint8Array(analyser.fftSize);
    const timer = window.setInterval(() => { if (context.state === 'suspended') void context.resume().catch(() => undefined); analyser.getByteTimeDomainData(values); const rms = Math.sqrt(values.reduce((a, v) => a + ((v - 128) / 128) ** 2, 0) / values.length); setLevel(Math.min(100, rms * 400)); }, 150);
    return () => { window.clearInterval(timer); source.disconnect(); void context.close(); };
  }, [device.stream]);
  const options = (kind: MediaDeviceKind) => <><option value="">既定の機器</option>{device.devices.filter(d => d.kind === kind && d.deviceId && d.deviceId !== 'default').map((d, n) => <option key={d.deviceId} value={d.deviceId}>{d.label || `機器 ${n + 1}`}</option>)}</>;
  return <div className={styles.form}>
    {preview && <StreamVideo stream={device.stream} />}
    {device.error && <p role="alert" className={styles.error}>{device.error}</p>}
    <div className={styles.row}><label className={styles.check}><input type="checkbox" checked={device.camera} onChange={e => device.setCamera(e.target.checked)} />カメラを使用</label><label className={styles.check}><input type="checkbox" checked={device.microphone} onChange={e => device.setMicrophone(e.target.checked)} />マイクを使用</label></div>
    <div className={styles.row}>{device.camera && <label className={styles.field}>カメラ<select className={styles.select} value={device.videoDevice} onChange={e => device.setVideoDevice(e.target.value)}>{options('videoinput')}</select></label>}{device.microphone && <label className={styles.field}>マイク<select className={styles.select} value={device.audioDevice} onChange={e => device.setAudioDevice(e.target.value)}>{options('audioinput')}</select></label>}</div>
    {device.microphone && <label className={styles.field}>マイク入力（話すとメーターが動きます）<meter aria-label="マイク入力レベル" className={styles.meter} min={0} max={100} value={level} /></label>}
    <div className={styles.row}><button type="button" className={styles.button} disabled={device.loading} onClick={() => void device.start()}>{device.loading ? '接続確認中…' : '機器を接続・確認'}</button><button type="button" className={styles.button} onClick={() => { const context = new AudioContext(); void context.resume(); const oscillator = context.createOscillator(); const gain = context.createGain(); gain.gain.value = .07; oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .5); oscillator.onended = () => { void context.close(); }; }}>テスト音を再生</button>{device.checked && <span className={styles.badge}>確認済み</span>}</div>
  </div>;
}

interface Recognition { lang: string; continuous: boolean; interimResults: boolean; onresult: ((event: { resultIndex: number; results: { length: number; [index: number]: { isFinal: boolean; [index: number]: { transcript: string } } } }) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null; start(): void; stop(): void; abort(): void }
export function useHiringSpeech(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false); const [listening, setListening] = useState(false); const [error, setError] = useState(''); const recognition = useRef<Recognition | null>(null); const callback = useRef(onText); callback.current = onText;
  useEffect(() => { const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }; setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition)); return () => { recognition.current?.abort(); }; }, []);
  const stop = useCallback(() => { recognition.current?.stop(); setListening(false); }, []);
  const start = () => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }; const SR = w.SpeechRecognition || w.webkitSpeechRecognition; if (!SR) return;
    recognition.current?.abort(); const rec = new SR(); recognition.current = rec; rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = false;
    rec.onresult = event => { for (let i = event.resultIndex; i < event.results.length; i++) if (event.results[i].isFinal) callback.current(event.results[i][0].transcript.trim()); };
    rec.onerror = event => { if (event.error !== 'aborted') setError('音声入力を続けられません。マイクの権限を確認するか、文字入力をご利用ください。'); setListening(false); };
    rec.onend = () => setListening(false);
    try { setError(''); rec.start(); setListening(true); } catch { setError('音声入力を開始できません。'); }
  };
  return { supported, listening, error, start, stop };
}
