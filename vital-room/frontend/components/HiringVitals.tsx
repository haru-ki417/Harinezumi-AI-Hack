'use client';

import { LineChart } from './LineChart';
import type { HiringVitalPeer, HiringVitalRecord, useHiringVitals } from '@/hooks/useHiringVitals';
import { getVitalAlert, VITAL_ALERT_THRESHOLDS } from '@/lib/vitalAlerts';
import styles from './Hiring.module.css';
import view from './HiringVitals.module.css';

const COLORS = ['#59c9d6', '#b496ff'];
function VitalCard({ participant, record, self, enabled, color }: { participant: HiringVitalPeer; record?: HiringVitalRecord; self: boolean; enabled: boolean; color: string }) {
  const vitals = enabled ? record?.vitals : undefined;
  const alert = getVitalAlert(vitals, enabled);
  const bpm = alert.bpm === null ? null : Math.round(alert.bpm * 10) / 10;
  const stress = alert.stress;
  const progress = vitals?.measurement_status;
  const holding = bpm !== null && vitals?.display_fresh === false;
  const provisional = vitals?.display_source === 'heart_rate' || vitals?.display_source === 'hrv';
  const confidence = vitals?.display_confidence ?? vitals?.confidence;
  const waiting = progress === 'no_face' ? '顔を検出できません。顔全体を明るく映してください。'
    : progress === 'low_fps' ? '計測画像が不足しています。通信状況とカメラを確認してください。'
    : progress === 'unstable_signal' || progress === 'unstable_hrv' ? '脈波が安定していません。顔を明るく映し、動きを少なくしてください。'
    : progress === 'warming_up' ? `心拍を計測中です（${Math.floor(vitals?.signal_seconds ?? 0)}秒分の画像を取得）。`
    : progress === 'calibrating' ? '心拍を取得しました。ストレスの基準値を計測しています（通常30〜60秒）。'
    : '';
  const notice = !enabled ? '計測・共有は停止中です' : !record ? '計測データを待っています' : holding ? `直近の推定値を表示しています。${waiting}` : waiting || (alert.active ? `⚠ ${alert.message}` : bpm === null ? '心拍を計測中です。顔を明るく映してください' : '設定値を超えた項目はありません');
  return <section aria-label={self ? '自分のバイタル' : '相手のバイタル'} className={`${view.card} ${self ? view.cardSelf : ''} ${alert.active ? view.cardAlert : ''}`}>
    <div className={view.head}><span className={styles.badge}>{participant.role === 'interviewer' ? '面接官' : '応募者'}</span><strong>{participant.name}{self ? '（あなた）' : ''}</strong>{vitals?.is_anomalous && <span className={styles.badge}>変化あり</span>}</div>
    <div className={view.bpm}><svg className={`${view.heart} ${bpm !== null ? view.heartOn : ''}`} viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 21s-7.5-4.9-10-9.6C.6 8.6 2 5.5 5 5.1c1.9-.3 3.6.7 4.6 2.1C10.4 5.8 12.1 4.8 14 5.1c3 .4 4.4 3.5 3 6.3C19.5 16.1 12 21 12 21z" fill="currentColor" /></svg><span className={`${view.number} ${alert.bpmHigh ? view.alertMetric : ''}`} aria-label="心拍数">{bpm ?? '--'}</span><span className={styles.muted}>bpm</span></div>
    <div className={view.meterHead}><span>ストレス</span><strong className={alert.stressHigh ? view.alertMetric : ''}>{stress === null ? '--' : Math.round(stress * 10) / 10}</strong></div>
    <div className={view.meterTrack} role="meter" aria-label="ストレス" aria-valuemin={0} aria-valuemax={100} aria-valuenow={stress ?? undefined} aria-valuetext={stress === null ? '未計測' : undefined}><div className={view.meterFill} style={{ width: `${stress ?? 0}%`, background: alert.stressHigh ? '#ef5555' : `hsl(${120 - (stress ?? 0) * 1.2} 60% 45%)` }} /></div>
    <div className={view.spark}><LineChart series={[{ name: 'stress', color, values: enabled ? record?.history.slice(-80) || [] : [] }]} yMin={0} yMax={100} height={48} yLabel="ストレス推移" /></div>
    <div className={view.subMetrics}><span>HRV(RMSSD) {vitals?.hrv_rmssd ? `${Math.round(vitals.hrv_rmssd)} ms` : '--'}</span><span>信頼度 {typeof confidence === 'number' ? `${Math.round(confidence * 100)}%` : '--'}</span></div>
    {provisional && <p className={view.thresholds}>{vitals?.display_source === 'heart_rate' ? 'ストレスは計測開始時からの心拍変化による参考値です。' : 'ストレスは基準値の確定前の参考値です。'}</p>}
    <div className={`${view.alert} ${alert.active ? view.alertActive : ''}`} role="status" aria-label="バイタル通知" aria-live="polite" aria-atomic="true">{notice}</div><p className={view.thresholds}>通知設定：ストレス &gt; {VITAL_ALERT_THRESHOLDS.stress} ／ BPM &gt; {VITAL_ALERT_THRESHOLDS.bpm}</p>
  </section>;
}

export function HiringVitals({ vital, host, active, connected }: { vital: ReturnType<typeof useHiringVitals>; host: boolean; active: boolean; connected: boolean }) {
  const ownRole = host ? 'interviewer' : 'candidate';
  const otherRole = host ? 'candidate' : 'interviewer';
  const participants: HiringVitalPeer[] = [ownRole, otherRole].map(role => vital.participants.find(p => p.role === role) || { client_id: role, role: role as HiringVitalPeer['role'], name: role === 'interviewer' ? '面接官' : '応募者', vital_consent: false });
  const enabled = (p: HiringVitalPeer) => active && connected && p.vital_consent && (p.role !== ownRole || vital.measuring);
  return <section className={view.panel} aria-label="心拍・ストレスの共有">
    <h3>心拍・ストレス</h3><p className={styles.muted}>同意するとカメラ画像から推定した数値を相手に共有し、面接後の振り返り用に保存します。画像は保存しません。企業は両者の数値、応募者は自分の数値を確認できます。計測せずに面接を続けることもできます。</p>
    <p className={styles.muted}>心拍が算出されると、信頼度が低い場合も心拍・ストレスの参考値を表示します。計測が途切れた間は直近の値を保持します。ストレスは初めに心拍の変化から算出し、脈波と基準値がそろうと更新します。心理状態や採用適性を判断する数値ではありません。</p>
    <label className={styles.check}><input type="checkbox" checked={vital.consent} disabled={!active || !connected} onChange={e => vital.setConsent(e.target.checked)} />心拍・ストレスの計測と相手への共有に同意する</label>
    {!active ? <p className={styles.muted}>入室許可後に計測・共有を選択できます。</p> : !connected ? <p className={styles.muted}>接続後に計測・共有を選択できます。</p> : vital.consent && !vital.liveCamera ? <p className={styles.muted}>計測にはカメラが必要です。カメラ設定から接続してください。</p> : vital.consent && <p className={styles.muted}>{vital.measuring ? '自分のカメラ画像を計測に使用し、結果を相手に共有しています。' : '計測・共有の開始を確認しています…'}</p>}
    {vital.error && <p className={styles.error} role="alert">{vital.error}</p>}
    <div className={view.cards}>{participants.map((p, index) => <VitalCard key={p.client_id} participant={p} record={vital.records[p.client_id]} self={index === 0} enabled={enabled(p)} color={COLORS[index]} />)}</div>
    <div className={view.timeline}><h4>ストレスの推移</h4><LineChart series={participants.map((p, index) => ({ name: `${p.name}${index === 0 ? '（あなた）' : ''}`, color: COLORS[index], values: enabled(p) ? vital.records[p.client_id]?.history || [] : [] }))} yMin={0} yMax={100} height={100} showLegend yLabel="参加者のストレス推移" /><p className={view.thresholds}>直近300回の計測。共有の停止・切断時には表示を消去します。</p></div>
  </section>;
}
