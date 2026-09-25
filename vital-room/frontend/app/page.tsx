'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import styles from './page.module.css';
import { useWebcam } from '@/hooks/useWebcam';
import { useVitalRoom } from '@/hooks/useVitalRoom';
import { LineChart, type Series } from '@/components/LineChart';
import { Report } from '@/components/Report';
import { CameraPreview, type CameraSettings } from '@/components/CameraPreview';
import { DeviceSetup, type AudioSettings } from '@/components/DeviceSetup';
import { getVitalAlert, VITAL_ALERT_THRESHOLDS } from '@/lib/vitalAlerts';
import { useRoomChat } from '@/hooks/useRoomChat';
import { RoomChat } from '@/components/RoomChat';
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

/* ===== ストレスメーター ===== */
function StressMeter({ value, alert }: { value: number | null; alert: boolean }) {
  const v = value ?? 0;
  const hue = 120 - (v / 100) * 120;
  return (
    <div className={styles.meterWrap}>
      <div className={styles.meterHead}>
        <span>ストレス</span><span className={`${styles.meterVal} ${alert ? styles.metricAlert : ''}`}>{value === null ? '--' : Math.round(v * 10) / 10}</span>
      </div>
      <div className={styles.meterTrack} role="meter" aria-label="ストレス" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={value ?? undefined} aria-valuetext={value === null ? '未計測' : undefined}>
        <div className={styles.meterFill} style={{ width: `${v}%`, background: alert ? '#ef5555' : `hsl(${hue} 60% 45%)` }} />
      </div>
    </div>
  );
}

/* ===== 参加者カード ===== */
function VitalCard({
  p, isSelf, preview, stressHistory, color, alertsEnabled,
}: {
  p: Participant;
  isSelf: boolean;
  preview?: ReactNode;
  stressHistory: number[];
  color: string;
  alertsEnabled: boolean;
}) {
  const v: Vitals = p.vitals || { current_bpm: 0, is_anomalous: false };
  const alert = getVitalAlert(v, alertsEnabled);
  const bpm = alert.bpm === null ? null : Math.round(alert.bpm * 10) / 10;
  const notice = alert.active ? `⚠ ${alert.message}`
    : !alertsEnabled ? '計測停止中'
      : alert.bpm === null && (alert.stress === null || alert.stress === 0) ? '計測データを待っています'
        : '設定値を超えた項目はありません';
  return (
    <section aria-label={isSelf ? '自分のバイタル' : `${p.name}のバイタル`}
      className={`${styles.card} ${isSelf ? styles.cardSelf : ''} ${alert.active ? styles.cardAlert : ''}`}>
      <div className={styles.cardHead}>
        <span className={styles.roleBadge}>{ROLE_LABEL[p.role] ?? p.role}</span>
        <span className={styles.cardName}>{p.name}{isSelf ? '（あなた）' : ''}</span>
        {v.is_anomalous && <span className={styles.chip}>変化あり</span>}
      </div>

      {isSelf && preview}

      <div className={styles.bpmRow}>
        <span className={`${styles.bpmNum} ${alert.bpmHigh ? styles.metricAlert : ''}`}>{bpm ?? '--'}</span>
        <span className={styles.bpmUnit}>bpm</span>
      </div>

      <StressMeter value={alert.stress} alert={alert.stressHigh} />

      <div className={styles.spark}>
        <LineChart series={[{ name: 'stress', color, values: stressHistory }]}
          yMin={0} yMax={100} height={48} yLabel="ストレス推移" />
      </div>

      <div className={styles.subMetrics}>
        <span>HRV(RMSSD) {v.hrv_rmssd ? `${Math.round(v.hrv_rmssd)} ms` : '--'}</span>
        <span>信頼度 {v.confidence ? v.confidence.toFixed(2) : '--'}</span>
      </div>
      <div className={`${styles.alertBar} ${alert.active ? styles.alertBarActive : ''}`}
        role="status" aria-label="バイタル通知" aria-live="polite" aria-atomic="true">
        {notice}
      </div>
      <p className={styles.alertThresholds}>通知設定：ストレス &gt; {VITAL_ALERT_THRESHOLDS.stress} ／ BPM &gt; {VITAL_ALERT_THRESHOLDS.bpm}</p>
    </section>
  );
}

export default function Home() {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  // サーバーとブラウザーの初期描画を一致させてからコードを生成する。
  useEffect(() => {
    const code = randomCode();
    setRoomId((current) => current || code);
  }, []);
  const [role, setRole] = useState<Role>('candidate');
  const [consent, setConsent] = useState(false);
  const [stage, setStage] = useState<'lobby' | 'setup' | 'room'>('lobby');
  const joined = stage === 'room';
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>({
    enabled: true, deviceId: '', background: 'none', brightness: 100, mirrored: true,
  });
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({
    enabled: false, deviceId: '', outputId: '',
  });
  const [customTopic, setCustomTopic] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [history, setHistory] = useState<Record<string, Sample[]>>({});

  const canJoin = name.trim().length > 0 && roomId.trim().length > 0 && consent;
  const room = useVitalRoom({ roomId, role, name: name || '参加者', active: joined });
  const chat = useRoomChat({ roomId, role, name: name.trim().slice(0, 40), active: canJoin });
  const chatPanel = <header className={styles.toolbar} aria-label="ルーム操作">
    <div className={styles.roomMeta}>
      <RoomChat chat={chat} roomId={roomId} />
      <span className={styles.roomCode} title={`ルーム ${roomId}`}>ルーム {roomId}</span>
      {joined ? <>
        <button type="button" className={styles.reportBtn} onClick={() => setShowReport(true)}>レポート</button>
        <button type="button" className={styles.leaveBtn} onClick={() => leave()}>退出</button>
      </> : <><span aria-hidden="true" /><span aria-hidden="true" /></>}
    </div>
  </header>;
  const camera = useWebcam({
    active: stage !== 'lobby' && cameraSettings.enabled,
    deviceId: cameraSettings.deviceId,
    transmitting: joined,
    onFrame: room.sendFrame, intervalMs: 40, quality: 0.6,
  });

  const openSetup = () => {
    if (!canJoin) return;
    setStage('setup');
  };
  const join = () => {
    if (!canJoin || (cameraSettings.enabled && (!camera.stream || camera.error || camera.loading))) return;
    setStage('room');
  };
  const leave = () => {
    setStage('lobby');
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

  if (stage === 'setup') {
    return <><DeviceSetup name={name} camera={camera} settings={cameraSettings} audio={audioSettings}
      onCameraChange={setCameraSettings} onAudioChange={setAudioSettings}
      onBack={() => setStage('lobby')} onJoin={join} />{chatPanel}</>;
  }

  if (stage === 'lobby') {
    return (
      <><div className={styles.lobbyWrap}>
        <div className={styles.lobby}>
          <p className={styles.lead}>ステップ 1 / 3 · 名前と同意</p>
          <h1 className={styles.title}>本音マッチング ルーム</h1>
          <p className={styles.lead}>
            カメラ映像から自分の心拍・HRV・ストレスを推定し、同じルームの相手と
            <b>お互いに見える形で</b>共有します。緊張の高さは<b>嘘や善悪の判定ではなく</b>、
            率直に話すきっかけとして使います。全員の同意が前提の透明なモードです。
          </p>

          <label className={styles.field}>
            <span>表示名</span>
            <input className={styles.input} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="例: 高橋" />
          </label>

          <label className={styles.field}>
            <span>ルームコード（相手と同じ値にする）</span>
            <div className={styles.roomRow}>
              <input className={styles.input} maxLength={100} value={roomId} onChange={(e) => setRoomId(e.target.value.toUpperCase())} />
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
              （相手の映像は共有されません）。医療目的ではなく、精度は環境に左右されます。
              計測はいつでも「退出」で停止できます。
            </p>
            <label className={styles.consentCheck}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>上記に同意し、自分のバイタルを共有することを承諾します</span>
            </label>
          </div>

          <button type="button" className={styles.joinBtn} disabled={!canJoin} onClick={openSetup}>同意して機器の設定へ</button>
        </div>
      </div>{chatPanel}</>
    );
  }

  const status =
    room.connection === 'open' ? '計測・共有中（全員が同意済み）'
      : room.connection === 'connecting' ? '接続中…'
      : room.connection === 'error' ? '接続エラー（バックエンド:8000を確認）'
      : '待機中';

  return (
    <><div className={styles.roomWrap}>
      <header className={styles.roomBar}>
        <div className={styles.status}>
          <span className={styles.liveDot} aria-hidden="true" />{status}
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
      </div>

      <main className={styles.cards}>
        <VitalCard p={selfCard} isSelf preview={<>
          <CameraPreview stream={camera.stream} settings={cameraSettings} className={styles.selfPreview} />
          {camera.error && <p role="alert">{camera.error}<button type="button" onClick={camera.retry}>カメラを再試行</button></p>}
          {!cameraSettings.enabled && <p>カメラがオフのため、バイタルの計測は停止しています。</p>}
        </>}
          alertsEnabled={room.connection === 'open' && !!camera.stream && cameraSettings.enabled}
          stressHistory={stressOf(room.selfId ?? 'self', 80)} color={SERIES_COLORS[0]} />
        {others.map((p, i) => (
          <VitalCard key={p.client_id} p={p} isSelf={false}
            alertsEnabled={room.connection === 'open'}
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

      {showReport && (
        <Report participants={room.participants} history={history} onClose={() => setShowReport(false)} />
      )}
    </div>{chatPanel}</>
  );
}
