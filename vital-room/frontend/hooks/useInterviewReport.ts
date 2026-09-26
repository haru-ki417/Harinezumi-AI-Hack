import { useCallback, useRef } from 'react';
import type { InterviewQuestion, Participant, Sample } from '@/types';
import { buildReportSummary, type ReportSummary } from '@/lib/reportAnalysis';

interface Recording {
  sessionId: string;
  startedAt: number;
  participants: Map<string, Participant>;
  history: Record<string, Sample[]>;
  questions: InterviewQuestion[];
  lastSample: Map<string, number>;
  lastTopic: string;
  clockOffset: number;
  serverAligned: boolean;
}

/** Keep the complete interview independently of the rolling live chart. */
export function useInterviewReport() {
  const recording = useRef<Recording | null>(null);
  const start = useCallback(() => {
    recording.current = {
      sessionId: crypto.randomUUID(), startedAt: Date.now(), participants: new Map(),
      history: {}, questions: [], lastSample: new Map(), lastTopic: '', clockOffset: 0, serverAligned: false,
    };
  }, []);

  const record = useCallback((participants: Participant[], questions: InterviewQuestion[], topic: string, joinedAt?: number | null) => {
    const session = recording.current;
    if (!session) return;
    if (!session.serverAligned && typeof joinedAt === 'number' && Number.isFinite(joinedAt)) {
      session.startedAt = joinedAt;
      session.clockOffset = joinedAt - Date.now();
      session.serverAligned = true;
    }
    const now = Date.now() + session.clockOffset;
    if (questions.length) session.questions = questions.map((q) => ({ ...q }));
    else if (topic && topic !== session.lastTopic) {
      session.questions.push({ id: session.questions.length + 1, topic, started_at: now });
    }
    session.lastTopic = topic;
    for (const participant of participants) {
      session.participants.set(participant.client_id, participant);
      const t = participant.vitals_updated_at ?? now;
      // A topic change broadcasts cached values. Count each measurement only once.
      if (!Number.isFinite(t) || t < session.startedAt || t <= (session.lastSample.get(participant.client_id) ?? 0)) continue;
      session.lastSample.set(participant.client_id, t);
      const vitals = participant.vitals;
      const sample: Sample = {
        t, bpm: vitals?.current_bpm ?? Number.NaN,
        stress: vitals?.stress_valid === false ? Number.NaN : vitals?.stress ?? Number.NaN,
        confidence: vitals?.measurement_valid === false ? 0 : vitals?.confidence, topic,
        questionId: participant.vitals_question_id ?? session.questions.at(-1)?.id ?? 0,
      };
      (session.history[participant.client_id] ??= []).push(sample);
    }
  }, []);

  const snapshot = useCallback((finishedAt?: number): ReportSummary | null => {
    const session = recording.current;
    if (!session) return null;
    const endedAt = Math.max(session.startedAt, finishedAt ?? Date.now() + session.clockOffset, ...session.lastSample.values(),
      ...session.questions.map((q) => q.started_at));
    const source = session.questions.length ? session.questions : [{ id: 1, topic: '質問未設定', started_at: session.startedAt }];
    const questions = source.map((question, i) => {
      const startedAt = Math.max(session.startedAt, question.started_at);
      return {
        id: question.id, label: `Q${question.id}`, topic: question.topic,
        startedAt, endedAt: Math.max(startedAt, Math.min(endedAt, source[i + 1]?.started_at ?? endedAt)),
      };
    });
    const history = session.questions.length ? session.history : Object.fromEntries(
      Object.entries(session.history).map(([id, samples]) => [id, samples.map((sample) => ({ ...sample, questionId: 1 }))]),
    );
    return buildReportSummary({
      sessionId: session.sessionId, startedAt: session.startedAt, endedAt,
      participants: [...session.participants.values()], history, questions,
    });
  }, []);

  return { start, record, snapshot };
}
