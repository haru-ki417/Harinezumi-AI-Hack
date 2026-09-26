'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import styles from '../page.module.css';
import { useWebcam } from '@/hooks/useWebcam';
import { useVitalRoom } from '@/hooks/useVitalRoom';
import { useSpeechToText } from '@/hooks/useSpeechToText';
import { useAudioDevices } from '@/hooks/useAudioDevices';
import { useScreenShare } from '@/hooks/useScreenShare';
import { LineChart, type Series } from '@/components/LineChart';
import { Report } from '@/components/Report';
import { CameraPreview, type CameraSettings } from '@/components/CameraPreview';
import { DeviceSetup, type AudioSettings } from '@/components/DeviceSetup';
import { getVitalAlert, VITAL_ALERT_THRESHOLDS } from '@/lib/vitalAlerts';
import { useRoomChat } from '@/hooks/useRoomChat';
import { RoomChat } from '@/components/RoomChat';
import { PreFormStage, AnswersPanel } from '@/components/PreForm';
import { Feedback } from '@/components/Feedback';
import { Compare, type CompareRow } from '@/components/Compare';
import { Organize, type OrganizeRow } from '@/components/Organize';
import { fetchForm, type PreFormData } from '@/lib/preForm';
import { fetchFeedback } from '@/lib/feedback';
import {
  buildRecord, saveRecordToServer, downloadRecordJSON, downloadRecordCSV,
  type InterviewRecord,
} from '@/lib/records';
import { buildReportSummary, type ReportQuestion, type ReportSummary } from '@/lib/reportAnalysis';
import { buildInterviewComment, type InterviewComment } from '@/lib/interviewComment';
import type { Participant, Role, Sample, Vitals, TranscriptSegment } from '@/types';

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

/* ===== 状態ランプ(緑=正常 / 黄=準備中 / 赤=停止・異常) ===== */
type LampState = 'ok' | 'warn' | 'error';
const LAMP_CLASS: Record<LampState, string> = {
  ok: styles.lampOk, warn: styles.lampWarn, error: styles.lampError,
};
function StatusLamp({ label, state, hint }: { label: string; state: LampState; hint?: string }) {
  return (
    <div className={styles.lamp} title={hint}>
      <span className={`${styles.lampDot} ${LAMP_CLASS[state]}`} aria-hidden="true" />
      <span className={styles.lampLabel}>{label}</span>
    </div>
  );
}

/* ===== 鼓動するハート(心拍表示用) ===== */
function HeartBeat({ active }: { active: boolean }) {
  return (
    <svg className={`${styles.heart} ${active ? styles.heartOn : ''}`}
      viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path d="M12 21s-7.5-4.9-10-9.6C.6 8.6 2 5.5 5 5.1c1.9-.3 3.6.7 4.6 2.1C10.4 5.8 12.1 4.8 14 5.1c3 .4 4.4 3.5 3 6.3C19.5 16.1 12 21 12 21z"
        fill="currentColor" />
    </svg>
  );
}

/* ===== ブランド(ロゴマーク＋名称) ===== */
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`${styles.brand} ${compact ? styles.brandCompact : ''}`}>
      <span className={styles.brandMark} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18">
          <path d="M2 12h4l2-5 3 10 3-7 2 2h6" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className={styles.brandName}>Vital&nbsp;Room</span>
    </div>
  );
}

/* ===== 受信した共有画面(imgをDOM直更新) ===== */
function ScreenView({ frameRef }: { frameRef: { current: string | null } }) {
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    let raf = 0; let last = '';
    const tick = () => {
      const f = frameRef.current;
      if (f && f !== last && imgRef.current) {
        imgRef.current.src = `data:image/jpeg;base64,${f}`;
        last = f;
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [frameRef]);
  // eslint-disable-next-line @next/next/no-img-element
  return <img ref={imgRef} className={styles.screenImg} alt="共有画面" />;
}

/* ===== 自分が共有中のプレビュー ===== */
function ScreenSelfPreview({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      ref.current.play?.().catch(() => undefined);
    }
  }, [stream]);
  return <video ref={ref} className={styles.screenImg} muted playsInline />;
}

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
        <HeartBeat active={bpm != null} />
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
        <span>信頼度 {v.confidence ? `${Math.round(v.confidence * 100)}%` : '--'}</span>
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
  const [stage, setStage] = useState<'lobby' | 'prep' | 'setup' | 'room' | 'ended'>('lobby');
  const [endedSummary, setEndedSummary] = useState<ReportSummary | null>(null);
  const joined = stage === 'room';
  // 事前質問フォーム
  const [useForm, setUseForm] = useState(false);           // 面接官: フォームを使うか
  const [prepQuestions, setPrepQuestions] = useState<string[]>([]);
  const [form, setForm] = useState<PreFormData>({ enabled: false, questions: [], answers: [] });
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>({
    enabled: true, deviceId: '', background: 'none', brightness: 100, mirrored: true,
  });
  const [audioSettings, setAudioSettings] = useState<AudioSettings>({
    enabled: true, deviceId: '', outputId: '',
  });
  const [customTopic, setCustomTopic] = useState('');
  const [showReport, setShowReport] = useState(false);
  const [reportData, setReportData] = useState<ReportSummary | null>(null);
  const [reportComment, setReportComment] = useState<InterviewComment | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackSummary, setFeedbackSummary] = useState<ReportSummary | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [compareRows, setCompareRows] = useState<CompareRow[]>([]);
  const [endedTranscript, setEndedTranscript] = useState<TranscriptSegment[]>([]);
  const [endedRecord, setEndedRecord] = useState<InterviewRecord | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [showOrganize, setShowOrganize] = useState(false);
  const [organizeRows, setOrganizeRows] = useState<OrganizeRow[]>([]);
  const [history, setHistory] = useState<Record<string, Sample[]>>({});
  // 質問(話題)の時間区間ログ。レポートの質問別集計に使う。
  const [questionLog, setQuestionLog] = useState<ReportQuestion[]>([]);
  const sessionStartRef = useRef<number>(0);

  const canJoin = name.trim().length > 0 && roomId.trim().length > 0 && consent;
  const room = useVitalRoom({ roomId, role, name: name || '参加者', active: joined });
  const chat = useRoomChat({ roomId, role, name: name.trim().slice(0, 40), active: canJoin });

  const camera = useWebcam({
    active: (stage === 'setup' || stage === 'room') && cameraSettings.enabled,
    deviceId: cameraSettings.deviceId,
    transmitting: joined,
    onFrame: room.sendFrame, intervalMs: 40, quality: 0.6,
  });

  // 画面共有(資料/Word/PC画面をルームへ配信)
  const screenShare = useScreenShare({ onFrame: room.sendScreen, onStop: room.sendScreenStop });

  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCam, setSelectedCam] = useState('');
  const [bgMenuOpen, setBgMenuOpen] = useState(false);
  const [bgImageName, setBgImageName] = useState('');
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
  const bgMode = cameraSettings.background;
  const setBgMode = (background: CameraSettings['background']) => setCameraSettings((current) => ({ ...current, background }));
  useEffect(() => {
    if (!joined) { setCameras([]); return; }
    const refresh = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices();
        const cams = list.filter((d) => d.kind === 'videoinput');
        setCameras(cams);
        const track = camera.stream?.getVideoTracks?.()[0];
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
  }, [joined, camera.stream]);

  const onSelectCamera = async (id: string) => {
    setSelectedCam(id);
    setCameraSettings((current) => ({ ...current, deviceId: id }));
  };

  // マイク/スピーカー(選択・レベルメーター・テスト音)。マイクOFF中は開かない。
  const audio = useAudioDevices(joined && audioSettings.enabled);
  const setMicEnabled = (on: boolean) => setAudioSettings((c) => ({ ...c, enabled: on }));

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
  // 文字起こし(面接官がONにすると全員が自分の発話を認識してテキスト送信)
  const [sttLang, setSttLang] = useState('ja-JP');
  const { status: sttStatus } = useSpeechToText(
    joined && room.transcribe && audioSettings.enabled, sttLang, room.sendTranscript,
  );

  const onPickBgImage = (file: File | undefined) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { setBackgroundImage(img); URL.revokeObjectURL(url); };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    setBgImageName(file.name);
    setCameraSettings((current) => ({ ...current, background: 'image' }));
  };

  const { selectMic, selectSpeaker } = audio;
  useEffect(() => {
    selectMic(audioSettings.deviceId);
    selectSpeaker(audioSettings.outputId);
  }, [audioSettings.deviceId, audioSettings.outputId, selectMic, selectSpeaker]);

  // 参加前: 役割とフォーム有無で prep(事前質問) か setup(機器設定) へ分岐
  const proceed = async () => {
    if (!canJoin) return;
    const f = await fetchForm(roomId);
    if (role === 'interviewer') {
      if (useForm) { setPrepQuestions(f.questions); setStage('prep'); }
      else setStage('setup');
    } else if (f.questions.length > 0) {
      setPrepQuestions(f.questions); setStage('prep');
    } else {
      setStage('setup');
    }
  };
  const join = () => {
    if (!canJoin || (cameraSettings.enabled && (!camera.stream || camera.error || camera.loading))) return;
    setStage('room');
  };
  // 退出: その時点のデータでスナップショットを作り、終了画面へ(メディア/接続は停止)。
  // 併せて、この面接の記録(サマリー＋文字起こし＋事前質問＋フィードバック)を
  // サーバへ保存し、手元DL用に record を保持する。
  const endInterview = () => {
    const snap = computeSummary();
    const transcript = room.transcript.slice();
    if (screenShare.sharing) screenShare.stop();
    setEndedSummary(snap);
    setEndedTranscript(transcript); // 退出後の照合用に発言を保存
    setStage('ended');
    // 保存(非同期)。フィードバックは既に送信済みなら取り込む。
    setSaveState('saving');
    (async () => {
      const fb = await fetchFeedback(roomId);
      const record = buildRecord({ roomId, role, summary: snap, transcript, form, feedback: fb });
      setEndedRecord(record);
      const res = await saveRecordToServer(roomId, record);
      setSaveState(res.ok ? 'saved' : 'error');
    })();
  };
  // 手元DL(押した時点の最新フィードバックを取り込んで record を作り直す)
  const buildLatestRecord = async (): Promise<InterviewRecord> => {
    const snap = endedSummary ?? computeSummary();
    const fb = await fetchFeedback(roomId);
    const record = buildRecord({ roomId, role, summary: snap, transcript: endedTranscript, form, feedback: fb });
    setEndedRecord(record);
    return record;
  };
  const onDownloadJSON = async () => downloadRecordJSON(await buildLatestRecord());
  const onDownloadCSV = async () => downloadRecordCSV(await buildLatestRecord());
  const onResaveServer = async () => {
    setSaveState('saving');
    const record = await buildLatestRecord();
    const res = await saveRecordToServer(roomId, record);
    setSaveState(res.ok ? 'saved' : 'error');
  };
  // 終了画面からロビーへ(全リセット)
  const backToLobby = () => {
    setStage('lobby');
    setHistory({});
    setQuestionLog([]);
    setEndedSummary(null);
    setEndedTranscript([]);
    setEndedRecord(null);
    setSaveState('idle');
    setReportData(null);
    setReportComment(null);
    setFeedbackSummary(null);
    setShowReport(false);
    setShowFeedback(false);
    setShowCompare(false);
    setShowOrganize(false);
    sessionStartRef.current = 0;
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
          confidence: p.vitals?.confidence,
        });
        if (arr.length > 1200) arr.shift();
        next[p.client_id] = arr;
      }
      return next;
    });
  }, [room.participants, room.topic, joined]);

  // 質問(話題)の時間区間を記録(レポートの質問別集計に使う)
  useEffect(() => {
    if (!joined) { sessionStartRef.current = 0; setQuestionLog([]); return; }
    const now = Date.now();
    const topic = room.topic || '導入';
    setQuestionLog((prev) => {
      if (prev.length === 0) {
        sessionStartRef.current = now;
        return [{ id: 1, label: 'Q1', topic, startedAt: now, endedAt: now }];
      }
      const last = prev[prev.length - 1];
      if (last.topic === topic) return prev; // 話題変化なし
      return [
        ...prev.slice(0, -1),
        { ...last, endedAt: now },
        { id: prev.length + 1, label: `Q${prev.length + 1}`, topic, startedAt: now, endedAt: now },
      ];
    });
  }, [joined, room.topic]);

  // 入室中は事前質問フォーム(質問＋回答)を定期取得(相手の回答が後から届く場合に追従)
  useEffect(() => {
    if (!joined) return;
    let alive = true;
    const load = async () => { const f = await fetchForm(roomId); if (alive) setForm(f); };
    load();
    const t = setInterval(load, 8000);
    return () => { alive = false; clearInterval(t); };
  }, [joined, roomId]);

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

  // その時点までのデータで集計サマリーを構築(レポート/フィードバック共通)
  const computeSummary = (): ReportSummary => {
    const now = Date.now();
    const start = sessionStartRef.current || (now - 1);
    const base: ReportQuestion[] = questionLog.length
      ? questionLog
      : [{ id: 1, label: 'Q1', topic: '全体', startedAt: start, endedAt: now }];
    const questions = base.map((q, i) => (i === base.length - 1 ? { ...q, endedAt: now } : q));
    const parts = room.participants.length ? room.participants : [selfCard];
    return buildReportSummary({
      sessionId: `${roomId}-${start}`,
      startedAt: start, endedAt: now, questions, participants: parts, history,
    });
  };
  const openReport = () => {
    const snap = computeSummary();
    setReportData(snap);
    setReportComment(buildInterviewComment({ summary: snap, organizeRows: buildOrganizeRows(room.transcript), role }));
    setShowReport(true);
  };
  const openFeedback = () => { setFeedbackSummary(computeSummary()); setShowFeedback(true); };

  // ES(事前回答) × 面接発言 の照合行を構築(AIなし・話題区間で対応付け)
  const buildCompareRows = (transcript: TranscriptSegment[]): CompareRow[] => {
    const now = Date.now();
    const ql = questionLog.map((q, i) => (i === questionLog.length - 1 ? { ...q, endedAt: now } : q));
    const candAns = form.answers[0]?.answers ?? [];
    return form.questions.map((q, i) => {
      const intervals = ql.filter((x) => x.topic === q);
      const segments = transcript
        .filter((s) => s.role === 'candidate'
          && intervals.some((iv) => s.ts * 1000 >= iv.startedAt && s.ts * 1000 <= iv.endedAt))
        .map((s) => s.text);
      return { question: q, esAnswer: candAns[i] ?? '', segments };
    });
  };
  const openCompare = () => {
    const transcript = stage === 'ended' ? endedTranscript : room.transcript;
    setCompareRows(buildCompareRows(transcript));
    setShowCompare(true);
  };

  // 面接まとめ: 項目(質問/話題)ごとに発言を整理し、カバー状況を出す(AIなし)
  const buildOrganizeRows = (transcript: TranscriptSegment[]): OrganizeRow[] => {
    const now = Date.now();
    const ql = questionLog.map((q, i) => (i === questionLog.length - 1 ? { ...q, endedAt: now } : q));
    const planned = form.questions.length ? form.questions : TOPIC_PRESETS;
    const discussed = Array.from(new Set(ql.map((x) => x.topic)))
      .filter((t) => t && t !== '導入' && !planned.includes(t));
    const items = [...planned, ...discussed];
    return items.map((topic) => {
      const intervals = ql.filter((x) => x.topic === topic);
      const segments = transcript
        .filter((s) => intervals.some((iv) => s.ts * 1000 >= iv.startedAt && s.ts * 1000 <= iv.endedAt))
        .map((s) => ({ role: s.role, name: s.name, text: s.text }));
      return {
        item: topic,
        planned: planned.includes(topic),
        covered: segments.some((s) => s.role === 'candidate'),
        segments,
      };
    });
  };
  const openOrganize = () => {
    const transcript = stage === 'ended' ? endedTranscript : room.transcript;
    setOrganizeRows(buildOrganizeRows(transcript));
    setShowOrganize(true);
  };

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

  const chatPanel = (
    <header className={styles.toolbar} aria-label="ルーム操作">
      <Brand compact />
      <div className={styles.roomMeta}>
        <RoomChat chat={chat} roomId={roomId} />
        <span className={styles.roomCode} title={`ルーム ${roomId}`}>ルーム {roomId}</span>
        {joined ? (
          <>
            <button type="button" className={styles.reportBtn} onClick={openReport}>レポート</button>
            <button type="button" className={styles.reportBtn} onClick={openFeedback}>フィードバック</button>
            <button type="button" className={styles.leaveBtn} onClick={() => setConfirmLeave(true)}>退出</button>
          </>
        ) : (<><span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" /></>)}
      </div>
    </header>
  );

  if (stage === 'prep') {
    return (
      <>
        <PreFormStage
          mode={role === 'interviewer' ? 'edit' : 'answer'}
          roomId={roomId} name={name} questions={prepQuestions}
          onBack={() => setStage('lobby')}
          onDone={() => setStage('setup')} />
        {chatPanel}
      </>
    );
  }

  if (stage === 'setup') {
    return (
      <>
        <DeviceSetup name={name} camera={camera} settings={cameraSettings} audio={audioSettings}
          onCameraChange={setCameraSettings} onAudioChange={setAudioSettings}
          onBack={() => setStage('lobby')} onJoin={join} />
        {chatPanel}
      </>
    );
  }

  if (stage === 'ended') {
    return (
      <><div className={styles.lobbyWrap}>
        <div className={`${styles.lobby} ${styles.endedLg}`}>
          <div className={styles.endedGrid}>
            <div className={styles.endedMain}>
              <Brand />
              <p className={styles.lead}>面接を終了しました</p>
              <h1 className={styles.title}>お疲れさまでした</h1>
              <p className={styles.lead}>
                この面接の<b>レポート（データ分析）</b>と<b>フィードバック（評価・振り返り）</b>を確認できます。
              </p>
              <div className={styles.endedActions}>
                <button type="button" className={styles.joinBtn}
                  onClick={() => {
                    setReportData(endedSummary);
                    if (endedSummary) setReportComment(buildInterviewComment({ summary: endedSummary, organizeRows: buildOrganizeRows(endedTranscript), role }));
                    setShowReport(true);
                  }}>レポートを見る</button>
                <button type="button" className={styles.joinBtn}
                  onClick={() => { setFeedbackSummary(endedSummary); setShowFeedback(true); }}>フィードバックを見る</button>
              </div>
              <div className={styles.endedSecondary}>
                <button type="button" className={styles.ghostBtn} onClick={openOrganize}>面接まとめを見る</button>
                {role === 'interviewer' && form.questions.length > 0 && (
                  <button type="button" className={styles.ghostBtn} onClick={openCompare}>ES × 発言を照合</button>
                )}
                <button type="button" className={styles.ghostBtn} onClick={backToLobby}>ロビーに戻る</button>
              </div>
            </div>

            <section className={styles.saveBox}>
              <div className={styles.saveHead}>
                <span className={styles.saveTitle}>この面接の記録を保存</span>
                <span className={`${styles.saveStatus} ${
                  saveState === 'saved' ? styles.saveOk
                  : saveState === 'error' ? styles.saveErr
                  : saveState === 'saving' ? styles.saveWait : ''}`}>
                  {saveState === 'saving' ? 'サーバへ保存中…'
                    : saveState === 'saved' ? `サーバに保存しました${endedRecord ? `（${endedRecord.sessionId}）` : ''}`
                    : saveState === 'error' ? 'サーバ保存に失敗（手元DLは可能）'
                    : ''}
                </span>
              </div>
              <p className={styles.saveNote}>
                心拍・ストレス・質問内容・回答時間・文字起こし・事前質問・評価をまとめて保存します。
                JSONは全データ、CSVは質問別の指標（平均・最大・基準超過）です。
              </p>
              <div className={styles.saveBtns}>
                <button type="button" className={styles.saveBtnPrimary} onClick={onDownloadJSON}>JSONをダウンロード（全データ）</button>
                <button type="button" className={styles.saveBtnPrimary} onClick={onDownloadCSV}>CSVをダウンロード（質問別）</button>
                <button type="button" className={styles.ghostBtn} onClick={onResaveServer}
                  disabled={saveState === 'saving'}>サーバに再保存</button>
              </div>
            </section>
          </div>
        </div>
      </div>

      {showReport && reportData && (
        <Report summary={reportData} completed interviewComment={reportComment} onClose={() => setShowReport(false)} />
      )}
      {showFeedback && feedbackSummary && (
        <Feedback role={role === 'interviewer' ? 'interviewer' : 'candidate'}
          roomId={roomId} summary={feedbackSummary} onClose={() => setShowFeedback(false)} />
      )}
      {showCompare && (
        <Compare rows={compareRows} onClose={() => setShowCompare(false)} />
      )}
      {showOrganize && (
        <Organize rows={organizeRows} role={role === 'interviewer' ? 'interviewer' : 'candidate'}
          onClose={() => setShowOrganize(false)} />
      )}
      {chatPanel}</>
    );
  }

  if (stage === 'lobby') {
    return (
      <><div className={styles.lobbyWrap}>
        <div className={`${styles.lobby} ${styles.lobbyLg}`}>
          <div className={styles.lobbyGrid}>
            <div className={styles.lobbyHero}>
              <Brand />
              <p className={styles.lead}><Link href="/">面接の参加・作成に戻る</Link></p>
              <p className={styles.lead}>ステップ 1 / 3 · 名前と同意</p>
              <h1 className={styles.title}>本音マッチング面接</h1>
              <p className={styles.lead}>
                カメラ映像から自分の心拍・HRV・ストレスを推定し、同じルームの相手と
                <b>お互いに見える形で</b>共有します。緊張の高さは<b>嘘や善悪の判定ではなく</b>、
                率直に話すきっかけとして使います。全員の同意が前提の透明なモードです。
              </p>
              <div className={styles.lobbyFeatures}>
                <span className={styles.feat}>非接触で心拍を計測</span>
                <span className={styles.feat}>双方向で透明に共有</span>
                <span className={styles.feat}>チャット・画面共有</span>
              </div>
            </div>

            <div className={styles.lobbyForm}>
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

              {role === 'interviewer' && (
                <label className={styles.consentCheck} style={{ marginBottom: 16 }}>
                  <input type="checkbox" checked={useForm} onChange={(e) => setUseForm(e.target.checked)} />
                  <span>事前質問フォームを使う（ESを踏まえた深掘り質問を用意し、候補者に事前回答してもらう）</span>
                </label>
              )}

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

              <button type="button" className={styles.joinBtn} disabled={!canJoin} onClick={proceed}>
                {role === 'interviewer' && useForm ? '同意して事前質問の作成へ' : '同意して次へ'}
              </button>
            </div>
          </div>
        </div>
      </div>{chatPanel}</>
    );
  }

  const status =
    room.connection === 'open' ? '計測・共有中（全員が同意済み）'
      : room.connection === 'connecting' ? '接続中…'
      : room.connection === 'error' ? '接続エラー（バックエンド:8000を確認）'
      : '待機中';

  const bgModeLabel = { none: 'なし', blur: 'ぼかし', slate: 'スレート', cream: 'クリーム', image: '画像' }[bgMode];

  // ===== デバイス/センサーの状態ランプ =====
  const hv = selfCard.vitals || { current_bpm: 0, is_anomalous: false };
  const camState: LampState = !cameraSettings.enabled ? 'warn'
    : camera.loading ? 'warn'
      : (camera.stream && !camera.error) ? 'ok' : 'error';
  const micState: LampState = !audioSettings.enabled ? 'warn'
    : audio.micActive ? 'ok' : (audio.mics.length ? 'warn' : 'error');
  const spkState: LampState = !audioSettings.enabled ? 'warn'
    : audio.speakers.length === 0 ? 'error' : (audio.speakerSupported ? 'ok' : 'warn');
  const heartReliable = !!(hv.current_bpm && hv.current_bpm > 0 && (hv.confidence ?? 0) >= 0.4);
  const heartState: LampState = (!cameraSettings.enabled || !camera.stream) ? 'error'
    : heartReliable ? 'ok' : 'warn';
  const confPct = hv.confidence ? Math.round(hv.confidence * 100) : 0;

  const deviceLamps = (
    <div className={styles.lampRow}>
      <StatusLamp label="カメラ" state={camState}
        hint={!cameraSettings.enabled ? 'カメラオフ' : camState === 'ok' ? 'カメラ動作中' : 'カメラ準備中/停止'} />
      <StatusLamp label="マイク" state={micState}
        hint={!audioSettings.enabled ? 'ミュート中' : audio.micActive ? 'マイク入力中' : 'マイク準備中'} />
      <StatusLamp label="スピーカー" state={spkState}
        hint={!audioSettings.enabled ? 'マイク未使用' : spkState === 'ok' ? '出力デバイス選択可' : spkState === 'warn' ? '切替非対応(既定)' : 'スピーカーなし'} />
      <StatusLamp label="心拍センサー" state={heartState}
        hint={!cameraSettings.enabled ? 'カメラオフのため停止' : heartState === 'ok' ? `計測中 (信頼度${confPct}%)` : heartState === 'warn' ? '取得中… 明るい正面光で顔を映してください' : '停止中'} />
    </div>
  );

  // Zoom風のメディア操作バー(ミュート/カメラ/画面共有)
  const mediaButtons = (
    <div className={styles.mediaBtns}>
      <button type="button"
        className={`${styles.mediaBtn} ${!audioSettings.enabled ? styles.mediaBtnOff : ''}`}
        onClick={() => setMicEnabled(!audioSettings.enabled)}
        title={audioSettings.enabled ? 'ミュート' : 'ミュート解除'}>
        <span className={styles.mediaBtnIcon}>{audioSettings.enabled ? '🎤' : '🔇'}</span>
        {audioSettings.enabled ? 'マイク' : 'ミュート中'}
      </button>
      <button type="button"
        className={`${styles.mediaBtn} ${!cameraSettings.enabled ? styles.mediaBtnOff : ''}`}
        onClick={() => setCameraSettings((c) => ({ ...c, enabled: !c.enabled }))}
        title={cameraSettings.enabled ? 'カメラをオフ' : 'カメラをオン'}>
        <span className={styles.mediaBtnIcon}>{cameraSettings.enabled ? '📷' : '🚫'}</span>
        {cameraSettings.enabled ? 'カメラ' : 'カメラオフ'}
      </button>
      <button type="button"
        className={`${styles.mediaBtn} ${screenShare.sharing ? styles.mediaBtnActive : ''}`}
        onClick={() => (screenShare.sharing ? screenShare.stop() : screenShare.start())}
        title={screenShare.sharing ? '画面共有を停止' : '画面を共有'}>
        <span className={styles.mediaBtnIcon}>🖥</span>
        {screenShare.sharing ? '共有を停止' : '画面共有'}
      </button>
    </div>
  );

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

      {bgMode === 'image' && bgImageName && <span className={styles.bgNote}>{bgImageName}</span>}
    </div>
    </>
  );

  return (
    <><div className={styles.roomWrap}>
      <header className={styles.roomBar}>
        <div className={styles.barLeft}>
          <span className={`${styles.statusPill} ${styles['conn_' + room.connection]}`}>
            <span className={styles.liveDot} aria-hidden="true" />{status}
          </span>
          {room.transcribe && <span className={styles.recBadge}>● 文字起こし中</span>}
        </div>
      </header>

      {/* トピックバー */}
      <div className={styles.topicBar}>
        <span className={styles.topicLabel}>現在の話題</span>
        <span className={styles.topicNow}>{room.topic || '未設定'}</span>
        {role === 'interviewer' && (
          <div className={styles.topicControls}>
            {(form.questions.length ? form.questions : TOPIC_PRESETS).map((t, i) => (
              <button key={i} type="button" title={t}
                className={`${styles.topicChip} ${room.topic === t ? styles.topicChipOn : ''}`}
                onClick={() => room.sendTopic(t)}>
                {form.questions.length ? `Q${i + 1}: ${t.length > 12 ? t.slice(0, 12) + '…' : t}` : t}
              </button>
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

      {/* 事前質問と回答(面接官が参照) */}
      {role === 'interviewer' && form.questions.length > 0 && (
        <AnswersPanel questions={form.questions} answers={form.answers} />
      )}
      {/* まとめ・照合ツール */}
      <div className={styles.compareBar}>
        <button type="button" className={styles.reportBtn} onClick={openOrganize}>面接まとめ</button>
        {role === 'interviewer' && form.questions.length > 0 && (
          <button type="button" className={styles.reportBtn} onClick={openCompare}>ES × 発言を照合</button>
        )}
      </div>

      {/* 画面共有ステージ */}
      {(screenShare.sharing || room.presenter) && (
        <section className={styles.stage}>
          <div className={styles.stageHead}>
            <span className={styles.stageDot} aria-hidden="true" />
            <span className={styles.stageTitle}>
              {screenShare.sharing
                ? 'あなたが画面を共有中'
                : `${room.presenter?.name || '参加者'} さんが画面を共有中`}
            </span>
            {screenShare.sharing && (
              <button type="button" className={styles.stageStop} onClick={screenShare.stop}>
                共有を停止
              </button>
            )}
          </div>
          <div className={styles.stageBody}>
            {screenShare.sharing
              ? <ScreenSelfPreview stream={screenShare.stream} />
              : <ScreenView frameRef={room.screenFrameRef} />}
          </div>
        </section>
      )}

      <main className={styles.cards}>
        <VitalCard p={selfCard} isSelf
          preview={<>
            <CameraPreview stream={camera.stream} settings={cameraSettings} backgroundImage={backgroundImage} className={styles.selfPreview} />
            {mediaButtons}
            {deviceLamps}
            {bgControls}
            {camera.error && <p role="alert">{camera.error}<button type="button" onClick={camera.retry}>カメラを再試行</button></p>}
            {!cameraSettings.enabled && <p className={styles.bgNote}>カメラがオフのため、バイタルの計測は停止しています。</p>}
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

      {showReport && reportData && (
        <Report summary={reportData} completed interviewComment={reportComment} onClose={() => setShowReport(false)} />
      )}

      {showFeedback && feedbackSummary && (
        <Feedback role={role === 'interviewer' ? 'interviewer' : 'candidate'}
          roomId={roomId} summary={feedbackSummary} onClose={() => setShowFeedback(false)} />
      )}
      {showCompare && (
        <Compare rows={compareRows} onClose={() => setShowCompare(false)} />
      )}
      {showOrganize && (
        <Organize rows={organizeRows} role={role === 'interviewer' ? 'interviewer' : 'candidate'}
          onClose={() => setShowOrganize(false)} />
      )}
      {confirmLeave && (
        <div className={styles.confirmOverlay} onClick={() => setConfirmLeave(false)}>
          <div className={styles.confirmCard} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <p className={styles.confirmTitle}>ミーティングを退出しますか？</p>
            <p className={styles.confirmText}>
              退出すると計測・共有は停止します。退出後もレポートとフィードバックは確認できます。
            </p>
            <div className={styles.confirmBtns}>
              <button type="button" className={styles.reportBtn} onClick={() => setConfirmLeave(false)}>キャンセル</button>
              <button type="button" className={styles.leaveBtn} onClick={() => { setConfirmLeave(false); endInterview(); }}>退出する</button>
            </div>
          </div>
        </div>
      )}
    </div>{chatPanel}</>
  );
}
