// 事前質問フォームのAPIクライアント(バックエンドのRESTを叩く)。
const API_BASE = 'http://localhost:8000';

export interface AnswerSet { name: string; answers: string[] }
export interface PreFormData {
  enabled: boolean;
  questions: string[];
  answers: AnswerSet[];
}

const EMPTY: PreFormData = { enabled: false, questions: [], answers: [] };

export async function fetchForm(roomId: string): Promise<PreFormData> {
  try {
    const r = await fetch(`${API_BASE}/api/form/${encodeURIComponent(roomId)}`);
    if (!r.ok) return EMPTY;
    const j = await r.json();
    return {
      enabled: !!j.enabled,
      questions: Array.isArray(j.questions) ? j.questions : [],
      answers: Array.isArray(j.answers) ? j.answers : [],
    };
  } catch {
    return EMPTY;
  }
}

export async function saveQuestions(roomId: string, questions: string[]): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/form/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questions }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function submitAnswers(roomId: string, name: string, answers: string[]): Promise<boolean> {
  try {
    const r = await fetch(`${API_BASE}/api/form/${encodeURIComponent(roomId)}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, answers }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
