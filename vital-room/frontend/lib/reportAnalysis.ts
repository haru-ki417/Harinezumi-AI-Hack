import type { Participant, Sample } from '@/types';
import { VITAL_ALERT_THRESHOLDS } from './vitalAlerts';

export interface ReportQuestion {
  id: number;
  label: string;
  topic: string;
  startedAt: number;
  endedAt: number;
}

export interface MetricStats {
  count: number;
  avg: number | null;
  peak: number | null;
  firstExceededAt: number | null;
  peakAt: number | null;
  exceededCount: number;
}

export interface ReportSummary {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  thresholds: { stress: number; bpm: number };
  questions: ReportQuestion[];
  participants: {
    id: string;
    name: string;
    role: string;
    excludedSamples: number;
    questions: { questionId: number; stress: MetricStats; bpm: MetricStats }[];
  }[];
}

interface ReportInput {
  sessionId: string;
  startedAt: number;
  endedAt: number;
  questions: ReportQuestion[];
  participants: Participant[];
  history: Record<string, Sample[]>;
}

const emptyMetric = (): MetricStats => ({
  count: 0, avg: null, peak: null, firstExceededAt: null, peakAt: null, exceededCount: 0,
});

function addValue(stats: MetricStats, value: number, t: number, threshold: number) {
  stats.avg = stats.avg === null ? value : stats.avg + (value - stats.avg) / (stats.count + 1);
  stats.count += 1;
  if (stats.peak === null || value > stats.peak || (value === stats.peak && (stats.peakAt === null || t < stats.peakAt))) {
    stats.peak = value;
    stats.peakAt = t;
  }
  if (value > threshold) {
    stats.exceededCount += 1;
    stats.firstExceededAt = stats.firstExceededAt === null ? t : Math.min(t, stats.firstExceededAt);
  }
}

/** Every participant uses the same question timeline, including missing measurements. */
export function buildReportSummary(input: ReportInput): ReportSummary {
  const { sessionId, startedAt, endedAt, participants, history } = input;
  const questions = input.questions.map((question) => ({ ...question }));
  const thresholds = { ...VITAL_ALERT_THRESHOLDS };
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const reversedQuestions = [...questions].reverse();
  return {
    sessionId, startedAt, endedAt, thresholds, questions,
    participants: participants.map((participant) => {
      let excludedSamples = 0;
      const results = questions.map((question) => ({ questionId: question.id, stress: emptyMetric(), bpm: emptyMetric() }));
      const resultById = new Map(results.map((result) => [result.questionId, result]));
      for (const sample of history[participant.client_id] ?? []) {
        const reliable = sample.confidence === undefined || (Number.isFinite(sample.confidence) && sample.confidence >= 0.5 && sample.confidence <= 1);
        if (!reliable || !Number.isFinite(sample.t) || sample.t < startedAt || sample.t > endedAt
          || !Number.isFinite(sample.bpm) || sample.bpm <= 0 || sample.bpm > 300) {
          excludedSamples += 1;
          continue;
        }
        const inInterval = (question: ReportQuestion) => sample.t >= question.startedAt
          && (sample.t < question.endedAt || (question.endedAt === endedAt && sample.t === endedAt));
        // Unknown explicit ids must never be reassigned to another question.
        const question = sample.questionId === undefined
          ? reversedQuestions.find(inInterval)
          : questionById.get(sample.questionId);
        const matchesInterval = question && (sample.questionId === undefined ? inInterval(question)
          : sample.t >= question.startedAt && sample.t <= question.endedAt);
        const result = question && matchesInterval ? resultById.get(question.id) : undefined;
        if (!result) {
          excludedSamples += 1;
          continue;
        }
        addValue(result.bpm, sample.bpm, sample.t, thresholds.bpm);
        if (Number.isFinite(sample.stress) && sample.stress >= 0 && sample.stress <= 100) {
          addValue(result.stress, sample.stress, sample.t, thresholds.stress);
        } else {
          excludedSamples += 1;
        }
      }
      return { id: participant.client_id, name: participant.name, role: participant.role, excludedSamples, questions: results };
    }),
  };
}

export function formatReportElapsed(t: number | null, startedAt: number): string {
  if (t === null) return '—';
  const seconds = Math.max(0, Math.floor((t - startedAt) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

export function numericalReportComment(summary: ReportSummary): string {
  const usable = summary.participants.flatMap((participant) => participant.questions)
    .filter((question) => question.bpm.count > 0 || question.stress.count > 0);
  if (usable.length === 0) return '十分なデータがありません。有効な計測データがないため、ストレス指標・心拍数の変化を分析できません。欠測の質問はグラフと表に表示しています。';
  const stress = usable.filter((question) => question.stress.exceededCount > 0).length;
  const bpm = usable.filter((question) => question.bpm.exceededCount > 0).length;
  return `参加者ごとの質問区間のうち、ストレス指標が基準値 ${summary.thresholds.stress} を超えた区間は ${stress} 件、心拍数が ${summary.thresholds.bpm} BPM を超えた区間は ${bpm} 件です。赤い棒と「基準超過」の表示で該当する質問を確認できます。時刻は面接開始からの経過時間です。`;
}
