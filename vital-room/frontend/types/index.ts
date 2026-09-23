// API / ルームの型定義

export interface VitalRequest {
  image_base64: string;
}

/** 単体レスポンス / 参加者のバイタル */
export interface Vitals {
  current_bpm: number;
  is_anomalous: boolean;
  confidence?: number;
  snr_db?: number;
  hrv_rmssd?: number;
  hrv_sdnn?: number;
  stress?: number;
  eff_fps?: number;
}

export type VitalResponse = Vitals;

export type Role = 'interviewer' | 'candidate';

/** ルームの参加者(全員に配信される公開情報) */
export interface Participant {
  client_id: string;
  role: Role | string;
  name: string;
  vitals: Vitals;
}

export type RoomConnection = 'idle' | 'connecting' | 'open' | 'error';
