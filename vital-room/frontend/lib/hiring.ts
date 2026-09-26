import type { VitalSummary } from '@/components/HiringVitalSummary';
// Same-origin by default: a shared invitation must never call the applicant's localhost.
export const HIRING_API = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
export function hiringSocketUrl(id: string) {
  const url = new URL(`${HIRING_API}/ws/hiring/${encodeURIComponent(id)}`, window.location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
export const EMPLOYER_TOKEN = 'hiring_employer_token';
export const candidateKey = (id: string) => `hiring_candidate_${id}`;
export type InterviewMode = 'human' | 'ai';
export type Decision = 'pending' | 'advance' | 'hold' | 'reject';
export interface Company { id: string; name: string; email: string }
export interface InterviewTemplate { id: string; title: string; job_title: string; mode: InterviewMode; duration_minutes: number; questions: string[]; criteria: string[]; created_at: string }
export interface Invitation { id: string; template_id: string; code: string; candidate_name: string; opens_at: string | null; expires_at: string; status: string; created_at: string; title: string; job_title: string; mode: InterviewMode; duration_minutes: number; decision: Decision }
export interface Turn { id: string; role: 'interviewer' | 'candidate' | 'ai'; text: string; created_at: string; question_index: number; source?: 'ai' | 'local' | 'human' }
export interface InterviewReport { source: 'ai' | 'local'; summary: string; generated_at: string; items: { criterion: string; summary: string; evidence: { turn_id: string; quote: string }[]; follow_up: string }[] }
export interface FeedbackEvidence { turn_id: string; quote: string }
export interface FeedbackPoint { title: string; observation: string; evidence: FeedbackEvidence[]; suggestion: string }
export interface QuestionReview { question_index: number; question: string; summary: string; evidence: FeedbackEvidence[]; strengths: string[]; improvements: string[]; answer_outline: string[] }
export interface InterviewFeedback { version: 1; source: 'ai' | 'local'; generated_at: string; summary: string; strengths: FeedbackPoint[]; improvements: FeedbackPoint[]; question_reviews: QuestionReview[]; practice_plan: string[] }
export interface InterviewProgress { question_index: number; question_count: number; follow_up_depth: number; max_follow_ups: number; answered_questions: number }
export interface InterviewSession { invitation: Invitation; template: InterviewTemplate; transcript: Turn[]; report: InterviewReport | null; review: { decision: Decision; notes: string }; started_at: string | null; ended_at: string | null; deadline_at: string | null; ai_available: boolean; ai_source?: 'ai' | 'local'; processing?: boolean; vital_summary?: VitalSummary | null; feedback?: InterviewFeedback | null; feedback_processing?: boolean; interview_progress?: InterviewProgress }
export interface InvitationLookup { id: string; company_name: string; title: string; job_title: string; mode: InterviewMode; duration_minutes: number; opens_at: string | null; expires_at: string; status: string; ai_available: boolean }
export class HiringError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function hiringApi<T>(path: string, token?: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${HIRING_API}/api/hiring${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), cache: 'no-store' });
  } catch { throw new HiringError('サーバーに接続できません。接続を確認して、もう一度お試しください。', 0); }
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== 'object') throw new HiringError('サーバーから正しい応答を受け取れませんでした。画面を再読み込みして、もう一度お試しください。', response.status);
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : '入力内容またはログイン状態を確認してください。';
    throw new HiringError(detail, response.status);
  }
  return payload as T;
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : '処理に失敗しました。もう一度お試しください。';
export const modeLabel = (mode: InterviewMode) => mode === 'ai' ? 'AI面接' : '対人面接';
export const decisionLabel: Record<Decision, string> = { pending: '未判断', advance: '次の選考へ', hold: '保留', reject: '見送り' };
export function statusLabel(invitation: Pick<Invitation, 'status' | 'expires_at'>) {
  if (invitation.status === 'invited' && Date.parse(invitation.expires_at) < Date.now()) return '期限切れ';
  return ({ invited: '招待済み', waiting: '入室待ち', in_progress: '面接中', completed: '実施済み', revoked: '招待取消', expired: '期限切れ' } as Record<string, string>)[invitation.status] || invitation.status;
}
export const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString('ja-JP') : '制限なし';
export const newRequestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
