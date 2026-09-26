// 面接後フィードバック(面接官の評価)のAPIクライアント。
const API_BASE = 'http://localhost:8000';

export interface FeedbackNote { questionId: number; note: string }
export interface FeedbackData {
  rating: number;
  strengths: string;
  improvements: string;
  notes: FeedbackNote[];
  shared: boolean;
  submitted: boolean;
}

const EMPTY: FeedbackData = {
  rating: 0, strengths: '', improvements: '', notes: [], shared: false, submitted: false,
};

export async function fetchFeedback(roomId: string): Promise<FeedbackData> {
  try {
    const r = await fetch(`${API_BASE}/api/feedback/${encodeURIComponent(roomId)}`);
    if (!r.ok) return EMPTY;
    const j = await r.json();
    return {
      rating: Number(j.rating) || 0,
      strengths: typeof j.strengths === 'string' ? j.strengths : '',
      improvements: typeof j.improvements === 'string' ? j.improvements : '',
      notes: Array.isArray(j.notes) ? j.notes : [],
      shared: !!j.shared,
      submitted: !!j.submitted,
    };
  } catch {
    return EMPTY;
  }
}

export async function saveFeedback(roomId: string, data: Omit<FeedbackData, 'submitted'>): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/feedback/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.ok;
  } catch {
    return false;
  }
}
