import type { Vitals } from '@/types';

// 表示確認用の初期値。医学的な異常・診断の基準ではない。
export const VITAL_ALERT_THRESHOLDS = { stress: 70, bpm: 100 } as const;

export function getVitalAlert(vitals: Vitals | null | undefined, enabled = true) {
  const rawBpm = vitals?.current_bpm;
  const rawStress = vitals?.stress;
  const bpm = typeof rawBpm === 'number' && Number.isFinite(rawBpm) && rawBpm > 0 ? rawBpm : null;
  const stress = typeof rawStress === 'number' && Number.isFinite(rawStress) && rawStress >= 0 && rawStress <= 100
    ? rawStress : null;
  const bpmHigh = enabled && bpm !== null && bpm > VITAL_ALERT_THRESHOLDS.bpm;
  const stressHigh = enabled && stress !== null && stress > VITAL_ALERT_THRESHOLDS.stress;
  const reasons = [stressHigh ? 'ストレス' : '', bpmHigh ? 'BPM' : ''].filter(Boolean);
  return {
    bpm, stress, bpmHigh, stressHigh,
    active: bpmHigh || stressHigh,
    // 数値更新のたびに読み上げないよう、通知文は超えた項目が変わったときだけ変更する。
    message: reasons.length ? `${reasons.join('・')}が設定値を超えています` : '',
  };
}
