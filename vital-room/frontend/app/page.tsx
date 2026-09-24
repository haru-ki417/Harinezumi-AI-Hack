'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import styles from './page.module.css';
import { useWebcam } from '@/hooks/useWebcam';
import { useVitalRoom } from '@/hooks/useVitalRoom';
import { useBackgroundFx, type BgMode } from '@/hooks/useBackgroundFx';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { useAudioDevices } from '@/hooks/useAudioDevices';
import { LineChart, type Series } from '@/components/LineChart';
import { Report } from '@/components/Report';
import type { Participant, Role, Sample, Vitals } from '@/types';

function randomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const ROLE_LABEL: Record<string, string> = { interviewer: '面接官', candidate: '就活生' };
const TOPIC_PRESETS = [
  '自己紹介', '志望動機', 'ガクチカ', '強み・弱み',
  'キャリアパス', '働き方・残業', '給与・待遇', '逆質問',
];
const SERIES_COLORS = ['#5a8ce6', '#e6a15a', '#8b5ae6', '#5ae6a1'];

/* ===== マイク入力レベル(DOM直接更新・再描画しない) ===== */
function MicMeter({ levelRef }: { levelRef: { current: number } }) {
  const fillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = fillRef.current;
      if (el) el.style.width = `${Math.round((levelRef.current ?? 0) * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);
  return (
    <div className={styles.levelTrack} title="入力レベル">
      <div ref={fillRef} className={styles.levelFill} style={{ width: '0%' }} />
    </div>
  );
}

/* ===== ストレスメーター ===== */
function StressMeter({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const hue = 120 - (v / 100) * 120;
  return (
    <div className={styles.meterWrap}>
      <div className={styles.meterHead}>
        <span>ストレス</span><span className={styles.meterVal}>{Math.round(v)}</span>
      </div>
      <div className={styles.meterTrack}>
        <div className={styles.meterFill} style={{ width: `${v}%`, background: `hsl(${hue} 60% 45%)` }} />
      </div>
    </div>
  );
}

/* ===== 参加者カード ===== */
function VitalCard({
  p, isSelf, videoRef, fxCanvasRef, bgActive, mediaControls, stressHistory, color,
}: {
  p: Participant;
  isSelf: boolean;
  videoRef?: RefObject<HTMLVideoElement | null>;
  fxCanvasRef?: RefObject<HTMLCanvasElement | null>;
  bgActive?: boolean;
  mediaControls?: ReactNode;
  stressHistory: number[];
  color: string;
}) {
  const v: Vitals = p.vitals || { current_bpm: 0, is_anomalous: false };
  const bpm = v.current_bpm && v.current_bpm > 0 ? Math.round(v.current_bpm) : null;
  return (
    <div className={`${styles.card} ${isSelf ? styles.cardSelf : ''}`}>
      <div className={styles.cardHead}>
        <span className={styles.roleBadge}>{ROLE_LABEL[p.role] ?? p.role}</span>
        <span className={styles.cardName}>{p.name}{isSelf ? '（あなた）' : ''}</span>
        {v.is_anomalous && <span className={styles.chip}>変化あり</span>}
      </div>

      {isSelf && (
        <>
          <div className={styles.mediaWrap}>
            <video ref={videoRef}
              className={`${styles.mediaLayer} ${bgActive ? styles.layerHidden : ''}`}
              playsInline muted />
            <canvas ref={fxCanvasRef}
              className={`${styles.mediaLayer} ${bgActive ? '' : styles.layerHidden}`} />
          </div>
          {mediaControls}
        </>
      )}

      <div className={styles.bpmRow}>
        <span className={styles.bpmNum}>{bpm ?? '--'}</span>
        <span className={styles.bpmUnit}>bpm</span>
      </div>

      <StressMeter value={v.stress ?? 0} />

      <div className={styles.spark}>
        <LineChart series={[{ name: 'stress', color, values: stressHistory }]}
          yMin={0} yMax={100} height={48} yLabel="ストレス推移" />
      </div>

      <div className={styles.subMetrics}>
        <span>HRV(RMSSD) {v.hrv_rmssd ? `${Math.round(v.hrv_rmssd)} ms` : '--'}</span>
        <span>信頼度 {v.confidence ? `${Math.round(v.confidence * 100)}%` : '--'}</span>
      </div>
    </div>
  );
}

export default function Home() {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState(() => randomCode());
  const [role, setRole] = useState<Role>('candidate');
  const [consent, setConsent] = useState(false);
  const [joined, setJoined] = useState(false);
  const [customTopic, setCustomTopic] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [history, setHistory] = useState<Record<string, Sample[]>>({});

  const [bgMode, setBgMode] = useState<BgMode>('none');
  const [bgMenuOpen, setBgMenuOpen] = useState(false);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const [bgImageName, setBgImageName] = useState('');

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCam, setSelectedCam] = useState<string>('');

  const room = useVitalRoom({ roomId, role, name: name || '参加者', active: joined });
  const { videoRef, canvasRef, isActive, start, stop, switchCamera } = useWebcam({
    onFrame: room.sendFrame, intervalMs: 40, quality: 0.6,
  });

  // カメラ一覧を列挙(権限取得後にラベルが入る)。抜き差しにも追従。
  useEffect(() => {
    if (!joined) { setCameras([]); return; }
    const refresh = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const cams = list.filter((d) => d.kind === 'videoinput');
        setCameras(cams);
        const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
        const activeId = track?.getSettings?.().deviceId;
        setSelectedCam((cur) =>
          cur && cams.some((c) => c.deviceId === cur) ? cur : (activeId || cams[0]?.deviceId || ''),
        );
      } catch {
        /* noop */
      }
    };
    refresh();
    navigator.mediaDevices.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', refresh);
  }, [joined, isActive, videoRef]);

  const onSelectCamera = async (id: string) => {
    setSelectedCam(id);
    await switchCamera(id);
  };

  // マイク/スピーカー(選択・レベルメーター・テスト音)
  const audio = useAudioDevices(joined);

  const downloadTranscript = () => {
    const lines = room.transcript.map((s) => {
      const t = new Date((s.ts || 0) * 1000).toLocaleTimeString('ja-JP');
      return `[${t}] ${ROLE_LABEL[s.role] ?? s.role} ${s.name}: ${s.text}`;
    });
    const header = `面接文字起こし  ルーム:${roomId}\n生成: ${new Date().toLocaleString('ja-JP')}\n\n`;
    const blob = new Blob([header + lines.join('\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `interview-transcript-${roomId}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };
  // 背景ぼかし/差し替え(表示用のみ。rPPGは生映像から算出するため影響なし)
  const { canvasRef: fxCanvasRef, status: bgStatus } = useBackgroundFx(videoRef, bgMode, bgImageRef);

  // 文字起こし(面接官がONにすると全員が自分の発話を認識してテキスト送信)
  const [sttLang, setSttLang] = useState('ja-JP');
  const { status: sttStatus } = useSpeechToText(
    joined && room.transcribe, sttLang, room.sendTranscript,
  );

  const onPickBgImage = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { bgImageRef.current = img; };
    img.src = url;
    setBgImageName(file.name);
    setBgMode('image');
  };

  const canJoin = name.trim().length > 0 && roomId.trim().length > 0 && consent;

  const join = async () => {
    if (!canJoin) return;
    setJoined(true);
    await start();
  };
  const leave = () => {
    stop();
    setJoined(false);
    setHistory({});
    setShowReport(false);
  };

  // 時系列の蓄積(各ブロードキャストごとに全参加者を1サンプル追記)
  useEffect(() => {
    if (!joined || room.participants.length === 0) return;
    const now = Date.now();
    setHistory((prev) => {
      const next = { ...prev };
      for (const p of room.participants) {
        const arr = next[p.client_id] ? next[p.client_id].slice() : [];
        arr.push({
          t: now,
          bpm: p.vitals?.current_bpm ?? 0,
          stress: p.vitals?.stress ?? 0,
          topic: room.topic,
        });
        if (arr.length > 1200) arr.shift();
        next[p.client_id] = arr;
      }
      return next;
    });
  }, [room.participants, room.topic, joined]);

  const others = useMemo(
    () => room.participants.filter((p) => p.client_id !== room.selfId),
    [room.participants, room.selfId],
  );
  const selfServer = room.participants.find((p) => p.client_id === room.selfId);
  const selfCard: Participant = selfServer ?? {
    client_id: 'self', role, name: name || '参加者',
    vitals: { current_bpm: 0, is_anomalous: false },
  };

  const stressOf = (cid: string, n: number) =>
    (history[cid] ?? []).slice(-n).map((s) => s.stress);

  // 下部タイムライン(全参加者のストレスを重ね描き)＋トピック切替マーカー
  const timelineSeries: Series[] = room.participants.map((p, i) => ({
    name: `${ROLE_LABEL[p.role] ?? p.role}: ${p.name}`,
    color: SERIES_COLORS[i % SERIES_COLORS.length],
    values: stressOf(p.client_id, 300),
  }));
  const timelineMarkers = useMemo(() => {
    const base = history[room.selfId ?? ''] ?? [];
    const win = base.slice(-300);
    const ms: { at: number }[] = [];
    for (let i = 1; i < win.length; i++) {
      if (win[i].topic !== win[i - 1].topic) ms.push({ at: i / (win.length - 1) });
    }
    return ms;
  }, [history, room.selfId]);

  if (!joined) {
    return (
      <div className={styles.lobbyWrap}>
        <div className={styles.lobby}>
          <h1 className={styles.title}>本音マッチング ルーム</h1>
          <p className={styles.lead}>
            カメラ映像から自分の心拍・HRV・ストレスを推定し、同じルームの相手と
            <b>お互いに見える形で</b>共有します。緊張の高さは<b>嘘や善悪の判定ではなく</b>、
            率直に話すきっかけとして使います。全員の同意が前提の透明なモードです。
          </p>

          <label className={styles.field}>
            <span>表示名</span>
            <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 高橋" />
          </label>

          <label className={styles.field}>
            <span>ルームコード（相手と同じ値にする）</span>
            <div className={styles.roomRow}>
              <input className={styles.input} value={roomId} onChange={(e) => setRoomId(e.target.value.toUpperCase())} />
              <button type="button" className={styles.ghostBtn} onClick={() => setRoomId(randomCode())}>再生成</button>
            </div>
          </label>

          <div className={styles.field}>
            <span>役割</span>
            <div className={styles.roleRow}>
              <button type="button" className={`${styles.roleBtn} ${role === 'interviewer' ? styles.roleOn : ''}`}
                onClick={() => setRole('interviewer')}>面接官</button>
              <button type="button" className={`${styles.roleBtn} ${role === 'candidate' ? styles.roleOn : ''}`}
                onClick={() => setRole('candidate')}>就活生</button>
            </div>
          </div>

          <div className={styles.consentBox}>
            <p className={styles.consentText}>
              このアプリは、あなたのカメラ映像から<b>あなた自身の</b>心拍・心拍変動・
              ストレスの目安を推定し、同じルームの参加者に数値として表示します
              （相手の映像は共有されません）。また、面接官が<b>文字起こし</b>をONにした場合、
              あなたのマイク音声は端末内で認識され<b>確定テキストのみ</b>が記録・共有されます
              （音声そのものは送られません／ON中は全員に「文字起こし中」と表示されます）。
              医療目的ではなく、精度は環境に左右されます。計測はいつでも「退出」で停止できます。
            </p>
            <label className={styles.consentCheck}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>上記に同意し、自分のバイタルを共有することを承諾します</span>
            </label>
          </div>

          <button type="button" className={styles.joinBtn} disabled={!canJoin} onClick={join}>同意して参加</button>
        </div>
        <canvas ref={canvasRef} className={styles.hidden} />
      </div>
    );
  }

  const status =
    room.connection === 'open' ? '計測・共有中（全員が同意済み）'
      : room.connection === 'connecting' ? '接続中…'
      : room.connection === 'error' ? '接続エラー（バックエンド:8000を確認）'
      : '待機中';

  const bgModeLabel = bgMode === 'none' ? 'なし' : bgMode === 'blur' ? 'ぼかし' : '画像';
  const bgControls = (
    <>
    {cameras.length > 0 && (
      <div className={styles.camRow}>
        <span className={styles.camLabel}>カメラ</span>
        <select className={styles.camSelect} value={selectedCam}
          onChange={(e) => onSelectCamera(e.target.value)}>
          {cameras.map((c, i) => (
            <option key={c.deviceId || i} value={c.deviceId}>
              {c.label || `カメラ ${i + 1}`}
            </option>
          ))}
        </select>
      </div>
    )}
    {audio.mics.length > 0 && (
      <div className={styles.camRow}>
        <span className={styles.camLabel}>マイク</span>
        <select className={styles.camSelect} value={audio.selectedMic}
          onChange={(e) => audio.selectMic(e.target.value)}>
          {audio.mics.map((c, i) => (
            <option key={c.deviceId || i} value={c.deviceId}>
              {c.label || `マイク ${i + 1}`}
            </option>
          ))}
        </select>
        <MicMeter levelRef={audio.micLevelRef} />
      </div>
    )}
    {audio.speakers.length > 0 && (
      <div className={styles.camRow}>
        <span className={styles.camLabel}>スピーカー</span>
        <select className={styles.camSelect} value={audio.selectedSpeaker}
          onChange={(e) => audio.selectSpeaker(e.target.value)}
          disabled={!audio.speakerSupported}>
          {audio.speakers.map((c, i) => (
            <option key={c.deviceId || i} value={c.deviceId}>
              {c.label || `スピーカー ${i + 1}`}
            </option>
          ))}
        </select>
        <button type="button" className={styles.testBtn} onClick={audio.testSpeaker}>
          テスト音
        </button>
      </div>
    )}
    <div className={styles.bgControls}>
      <button type="button" className={styles.bgToggle}
        onClick={() => setBgMenuOpen((o) => !o)} aria-expanded={bgMenuOpen}>
        <span>背景: {bgModeLabel}</span>
        <span className={styles.caret}>{bgMenuOpen ? '▲' : '▼'}</span>
      </button>

      {bgMenuOpen && (
        <div className={styles.bgMenu}>
          <button type="button" className={`${styles.bgMenuItem} ${bgMode === 'none' ? styles.bgMenuItemOn : ''}`}
            onClick={() => { setBgMode('none'); setBgMenuOpen(false); }}>なし（元のカメラ）</button>
          <button type="button" className={`${styles.bgMenuItem} ${bgMode === 'blur' ? styles.bgMenuItemOn : ''}`}
            onClick={() => { setBgMode('blur'); setBgMenuOpen(false); }}>ぼかし</button>
          <button type="button" className={`${styles.bgMenuItem} ${bgMode === 'image' ? styles.bgMenuItemOn : ''}`}
            onClick={() => { setBgMode('image'); setBgMenuOpen(false); }}>画像（グラデーション）</button>
          <label className={styles.bgMenuItem}>
            画像をアップロード…
            <input type="file" accept="image/*" hidden
              onChange={(e) => { onPickBgImage(e.target.files?.[0] ?? undefined); setBgMenuOpen(false); }} />
          </label>
        </div>
      )}

      {bgMode !== 'none' && bgStatus === 'loading' && <span className={styles.bgNote}>背景処理を読込中…</span>}
      {bgMode !== 'none' && bgStatus === 'error' && <span className={styles.bgNote}>背景処理を読み込めません（ネット接続を確認）</span>}
      {bgMode === 'image' && bgImageName && <span className={styles.bgNote}>{bgImageName}</span>}
    </div>
    </>
  );

  return (
    <div className={styles.roomWrap}>
      <header className={styles.roomBar}>
        <div className={styles.status}>
          <span className={styles.liveDot} aria-hidden="true" />{status}
          {room.transcribe && <span className={styles.recBadge}>● 文字起こし中</span>}
        </div>
        <div className={styles.roomMeta}>
          <span className={styles.roomCode}>ルーム {roomId}</span>
          <button type="button" className={styles.reportBtn} onClick={() => setShowReport(true)}>レポート</button>
          <button type="button" className={styles.leaveBtn} onClick={leave}>退出</button>
        </div>
      </header>

      {/* トピックバー */}
      <div className={styles.topicBar}>
        <span className={styles.topicLabel}>現在の話題</span>
        <span className={styles.topicNow}>{room.topic || '未設定'}</span>
        {role === 'interviewer' && (
          <div className={styles.topicControls}>
            {TOPIC_PRESETS.map((t) => (
              <button key={t} type="button"
                className={`${styles.topicChip} ${room.topic === t ? styles.topicChipOn : ''}`}
                onClick={() => room.sendTopic(t)}>{t}</button>
            ))}
            <input className={styles.topicInput} value={customTopic}
              onChange={(e) => setCustomTopic(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && customTopic.trim()) { room.sendTopic(customTopic.trim()); setCustomTopic(''); } }}
              placeholder="自由入力→Enter" />
          </div>
        )}
        {role === 'interviewer' && (
          <div className={styles.sttControls}>
            <button type="button"
              className={`${styles.sttToggle} ${room.transcribe ? styles.sttOn : ''}`}
              onClick={() => room.sendTranscribe(!room.transcribe)}>
              文字起こし: {room.transcribe ? 'ON' : 'OFF'}
            </button>
            <select className={styles.sttLang} value={sttLang}
              onChange={(e) => setSttLang(e.target.value)}>
              <option value="ja-JP">日本語</option>
              <option value="en-US">English</option>
            </select>
          </div>
        )}
      </div>

      <main className={styles.cards}>
        <VitalCard p={selfCard} isSelf videoRef={videoRef}
          fxCanvasRef={fxCanvasRef} bgActive={bgMode !== 'none'} mediaControls={bgControls}
          stressHistory={stressOf(room.selfId ?? 'self', 80)} color={SERIES_COLORS[0]} />
        {others.map((p, i) => (
          <VitalCard key={p.client_id} p={p} isSelf={false}
            stressHistory={stressOf(p.client_id, 80)} color={SERIES_COLORS[(i + 1) % SERIES_COLORS.length]} />
        ))}
        {others.length === 0 && (
          <div className={`${styles.card} ${styles.waiting}`}>
            <div className={styles.waitText}>相手の参加を待っています…</div>
            <div className={styles.waitSub}>同じルームコード「{roomId}」で参加してもらってください。</div>
          </div>
        )}
      </main>

      {/* 共有タイムライン */}
      {room.participants.length > 0 && (
        <section className={styles.timeline}>
          <div className={styles.timelineHead}>
            <span>ストレス推移（全員・重ね描き）</span>
            <span className={styles.timelineTopic}>話題: {room.topic || '未設定'}</span>
          </div>
          <LineChart series={timelineSeries} yMin={0} yMax={100} height={120}
            markers={timelineMarkers} showLegend yLabel="ストレス推移" />
          <div className={styles.timelineHint}>点線 = 話題の切り替わり</div>
        </section>
      )}

      {/* 文字起こし(面接記録) */}
      {(room.transcribe || room.transcript.length > 0) && (
        <section className={styles.transcript}>
          <div className={styles.transcriptHead}>
            <span>文字起こし（面接記録）</span>
            <div className={styles.transcriptActions}>
              {sttStatus === 'unsupported' && room.transcribe && (
                <span className={styles.sttNote}>この端末は音声認識非対応（Chrome/Edge推奨）</span>
              )}
              {role === 'interviewer' && room.transcript.length > 0 && (
                <button type="button" className={styles.dlBtn} onClick={downloadTranscript}>
                  .txtで保存
                </button>
              )}
            </div>
          </div>
          <div className={styles.transcriptBody}>
            {room.transcript.length === 0 ? (
              <p className={styles.transcriptEmpty}>
                {room.transcribe ? '発話を待っています…（マイク許可が必要です）' : '文字起こしはオフです。'}
              </p>
            ) : (
              room.transcript.map((s, i) => (
                <div key={i} className={styles.line}>
                  <span className={styles.lineWho}>{ROLE_LABEL[s.role] ?? s.role}・{s.name}</span>
                  <span className={styles.lineText}>{s.text}</span>
                </div>
              ))
            )}
          </div>
          <div className={styles.transcriptHint}>
            音声そのものは共有されず、確定テキストのみが記録されます。公平な評価のための記録用です。
          </div>
        </section>
      )}

      <canvas ref={canvasRef} className={styles.hidden} />

      {showReport && (
        <Report participants={room.participants} history={history} onClose={() => setShowReport(false)} />
      )}
    </div>
  );
}
