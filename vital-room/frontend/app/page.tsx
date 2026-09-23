'use client';

import { useMemo, useState, type RefObject } from 'react';
import styles from './page.module.css';
import { useWebcam } from '@/hooks/useWebcam';
import { useVitalRoom } from '@/hooks/useVitalRoom';
import type { Participant, Role, Vitals } from '@/types';

function randomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const ROLE_LABEL: Record<string, string> = {
  interviewer: '面接官',
  candidate: '就活生',
};

/* ===== ストレスメーター ===== */
function StressMeter({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const hue = 120 - (v / 100) * 120; // 緑→赤
  return (
    <div className={styles.meterWrap}>
      <div className={styles.meterHead}>
        <span>ストレス</span>
        <span className={styles.meterVal}>{Math.round(v)}</span>
      </div>
      <div className={styles.meterTrack}>
        <div className={styles.meterFill} style={{ width: `${v}%`, background: `hsl(${hue} 60% 45%)` }} />
      </div>
    </div>
  );
}

/* ===== 参加者カード ===== */
function VitalCard({
  p,
  isSelf,
  videoRef,
}: {
  p: Participant;
  isSelf: boolean;
  videoRef?: RefObject<HTMLVideoElement | null>;
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
        <video ref={videoRef} className={styles.selfPreview} playsInline muted />
      )}

      <div className={styles.bpmRow}>
        <span className={styles.bpmNum}>{bpm ?? '--'}</span>
        <span className={styles.bpmUnit}>bpm</span>
      </div>

      <StressMeter value={v.stress ?? 0} />

      <div className={styles.subMetrics}>
        <span>HRV(RMSSD) {v.hrv_rmssd ? `${Math.round(v.hrv_rmssd)} ms` : '--'}</span>
        <span>信頼度 {v.confidence ? v.confidence.toFixed(2) : '--'}</span>
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

  const room = useVitalRoom({ roomId, role, name: name || '参加者', active: joined });
  const { videoRef, canvasRef, start, stop } = useWebcam({
    onFrame: room.sendFrame,
    intervalMs: 40,
    quality: 0.6,
  });

  const canJoin = name.trim().length > 0 && roomId.trim().length > 0 && consent;

  const join = async () => {
    if (!canJoin) return;
    setJoined(true);
    await start();
  };
  const leave = () => {
    stop();
    setJoined(false);
  };

  // 自分カードは参加直後から常に描画(映像要素を確実にマウント)。
  // サーバのスナップショットが来たら自分の値で上書きする。
  const others = useMemo(
    () => room.participants.filter((p) => p.client_id !== room.selfId),
    [room.participants, room.selfId],
  );
  const selfServer = room.participants.find((p) => p.client_id === room.selfId);
  const selfCard: Participant = selfServer ?? {
    client_id: 'self',
    role,
    name: name || '参加者',
    vitals: { current_bpm: 0, is_anomalous: false },
  };

  if (!joined) {
    return (
      <div className={styles.lobbyWrap}>
        <div className={styles.lobby}>
          <h1 className={styles.title}>バイタル共有ルーム</h1>
          <p className={styles.lead}>
            カメラ映像から自分の心拍・HRV・ストレスを推定し、同じルームの相手と
            <b>お互いに見える形で</b>共有します。全員の同意が前提の透明なモードです。
          </p>

          <label className={styles.field}>
            <span>表示名</span>
            <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="例: 高橋" />
          </label>

          <label className={styles.field}>
            <span>ルームコード（相手と同じ値にする）</span>
            <div className={styles.roomRow}>
              <input className={styles.input} value={roomId}
                onChange={(e) => setRoomId(e.target.value.toUpperCase())} />
              <button type="button" className={styles.ghostBtn} onClick={() => setRoomId(randomCode())}>
                再生成
              </button>
            </div>
          </label>

          <div className={styles.field}>
            <span>役割</span>
            <div className={styles.roleRow}>
              <button type="button"
                className={`${styles.roleBtn} ${role === 'interviewer' ? styles.roleOn : ''}`}
                onClick={() => setRole('interviewer')}>面接官</button>
              <button type="button"
                className={`${styles.roleBtn} ${role === 'candidate' ? styles.roleOn : ''}`}
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

          <button type="button" className={styles.joinBtn} disabled={!canJoin} onClick={join}>
            同意して参加
          </button>
        </div>
        <canvas ref={canvasRef} className={styles.hidden} />
      </div>
    );
  }

  const status =
    room.connection === 'open'
      ? '計測・共有中（全員が同意済み）'
      : room.connection === 'connecting'
        ? '接続中…'
        : room.connection === 'error'
          ? '接続エラー（バックエンド:8000を確認）'
          : '待機中';

  return (
    <div className={styles.roomWrap}>
      <header className={styles.roomBar}>
        <div className={styles.status}>
          <span className={styles.liveDot} aria-hidden="true" />
          {status}
        </div>
        <div className={styles.roomMeta}>
          <span className={styles.roomCode}>ルーム {roomId}</span>
          <button type="button" className={styles.leaveBtn} onClick={leave}>退出</button>
        </div>
      </header>

      <main className={styles.cards}>
        <VitalCard p={selfCard} isSelf videoRef={videoRef} />
        {others.map((p) => (
          <VitalCard key={p.client_id} p={p} isSelf={false} />
        ))}
        {others.length === 0 && (
          <div className={`${styles.card} ${styles.waiting}`}>
            <div className={styles.waitText}>相手の参加を待っています…</div>
            <div className={styles.waitSub}>同じルームコード「{roomId}」で参加してもらってください。</div>
          </div>
        )}
      </main>

      <canvas ref={canvasRef} className={styles.hidden} />
    </div>
  );
}
