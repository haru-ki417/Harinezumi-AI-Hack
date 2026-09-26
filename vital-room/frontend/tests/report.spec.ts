import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import type { ReportSummary } from '../lib/reportAnalysis';
import { buildReportSummary } from '../lib/reportAnalysis';
import type { Vitals } from '../types';

test('質問番号を参加者間で固定し、欠測・低信頼度・基準値の境界を正しく集計する', () => {
  const report = buildReportSummary({
    sessionId: 'aggregation', startedAt: 1000, endedAt: 6000,
    questions: [
      { id: 1, label: 'Q1', topic: '同じ質問', startedAt: 1000, endedAt: 3000 },
      { id: 2, label: 'Q2', topic: '同じ質問', startedAt: 3000, endedAt: 6000 },
    ],
    participants: [
      { client_id: 'early', name: '先着', role: 'candidate', vitals: { current_bpm: 90, is_anomalous: false } },
      { client_id: 'late', name: '後着', role: 'interviewer', vitals: { current_bpm: 0, is_anomalous: false } },
    ],
    history: {
      early: [
        ...Array.from({ length: 1201 }, (_, i) => ({ t: 1001 + i, bpm: 90, stress: 40, topic: '同じ質問', questionId: 1 })),
        { t: 3000, bpm: 110, stress: 80, topic: '同じ質問', questionId: 1, confidence: 0.9 },
        { t: 3001, bpm: 100, stress: 70, topic: '同じ質問', questionId: 2, confidence: 0.9 },
        { t: 3100, bpm: 180, stress: 98, topic: '同じ質問', questionId: 2, confidence: 0.2 },
        { t: 3200, bpm: 180, stress: 98, topic: '同じ質問', questionId: 2, confidence: 2 },
        { t: 3300, bpm: 0, stress: 90, topic: '同じ質問', questionId: 2 },
        { t: 3400, bpm: 120, stress: 90, topic: '同じ質問', questionId: 99 },
      ],
      late: [{ t: 4000, bpm: 105, stress: Number.NaN, topic: '同じ質問', questionId: 2 }],
    },
  });
  expect(report.participants[0].questions[0].bpm.count).toBe(1202);
  expect(report.participants[0].questions[0].stress.firstExceededAt).toBe(3000);
  expect(report.participants[0].questions[1].bpm).toMatchObject({ count: 1, peak: 100, exceededCount: 0 });
  expect(report.participants[0].questions[1].stress.exceededCount).toBe(0);
  expect(report.participants[1].questions[0].bpm).toMatchObject({ count: 0, avg: null, peak: null });
  expect(report.participants[1].questions[1].bpm.peak).toBe(105);
  expect(report.participants[1].questions[1].stress.peak).toBeNull();
});

async function interview(page: Page, source: 'ai' | 'local' | 'server' = 'ai', serverOffset = 0) {
  const serverNow = () => Date.now() + serverOffset;
  let socket: WebSocketRoute | undefined;
  const questions: { id: number; topic: string; started_at: number }[] = [];
  const requests: ReportSummary[] = [];
  let vitals: Vitals = { current_bpm: 0, stress: 0, confidence: 0, is_anomalous: false };
  let measuredAt = 0;
  let measuredQuestion = 0;
  const publish = () => socket?.send(JSON.stringify({
    type: 'room', topic: questions.at(-1)?.topic ?? '', question_id: questions.length,
    questions, participants: [{ client_id: 'self', name: '面接担当', role: 'interviewer', vitals,
      vitals_updated_at: measuredAt, vitals_question_id: measuredQuestion }],
  }));
  await page.routeWebSocket('ws://localhost:8000/ws/room/**', (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'join') { ws.send(JSON.stringify({ type: 'joined', client_id: 'self', joined_at: serverNow() })); publish(); }
      if (message.type === 'topic') {
        questions.push({ id: questions.length + 1, topic: message.topic, started_at: serverNow() });
        publish();
      }
      if (message.type === 'end_session') {
        publish();
        ws.send(JSON.stringify({ type: 'session_ended', ended_at: serverNow() }));
      }
    });
  });
  await page.routeWebSocket('**/ws/chat/**', (ws) => ws.onMessage((raw) => {
    if (JSON.parse(String(raw)).type === 'join') ws.send(JSON.stringify({ type: 'chat_joined', client_id: 'chat-self', messages: [] }));
  }));
  if (source !== 'server') await page.route('**/api/reports/analyze', async (route) => {
    requests.push(route.request().postDataJSON() as ReportSummary);
    await route.fulfill({ json: {
      source, reason: source === 'local' ? 'not_configured' : undefined,
      summary: source === 'ai' ? 'Q1とQ3で設定した基準値を超えました。数値の推移を振り返れます。' : 'AIは未接続です。集計した値を表示しています。',
      observations: [{ participantId: 'self', questionId: 1, comment: 'Q1では心拍110 bpm、ストレス80を記録しました。' }],
    } });
  });
  await page.goto('/vital');
  await page.getByLabel('表示名').fill('面接担当');
  await page.getByRole('button', { name: '面接官', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await page.getByRole('button', { name: 'カメラ', exact: true }).click();
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect(page.getByRole('button', { name: '面接を終了', exact: true })).toBeEnabled();
  return {
    requests,
    async sample(bpm: number, stress: number, confidence = 0.9, validity: Pick<Vitals, 'measurement_valid' | 'stress_valid'> = {}) {
      // Distinct server timestamps permit deduplication of unchanged room broadcasts.
      await page.waitForTimeout(10);
      measuredAt = serverNow();
      measuredQuestion = questions.length;
      vitals = { current_bpm: bpm, stress, confidence, is_anomalous: false, ...validity };
      publish();
      await expect(page.getByRole('region', { name: '自分のバイタル' }).locator('[role="meter"]')).toHaveAttribute('aria-valuenow', String(stress));
    },
    async question(topic: string) {
      const previous = questions.length;
      await page.getByRole('button', { name: topic, exact: true }).click();
      await expect.poll(() => questions.length).toBe(previous + 1);
      await expect(page.getByText(`Q${questions.length} · ${topic}`, { exact: true })).toBeVisible();
    },
  };
}

test('面接終了で質問別の心拍・ストレスとAIコメントを自動表示し、繰り返した質問も区別する', async ({ page }) => {
  const session = await interview(page);
  await session.question('自己紹介');
  await session.sample(90, 40);
  await session.sample(110, 80);
  await session.question('志望動機');
  await session.sample(100, 70);
  await session.sample(99, 99, 0.9, { measurement_valid: true, stress_valid: false });
  await session.question('自己紹介');
  await session.sample(180, 98, 0.2);
  await session.sample(190, 99, 0.9, { measurement_valid: false, stress_valid: false });
  await session.sample(102, 72);

  await page.getByRole('button', { name: 'レポート', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '面接レポート' })).toBeVisible();
  expect(session.requests).toHaveLength(0);
  await page.getByRole('button', { name: 'レポートを閉じる' }).click();
  await page.getByRole('button', { name: '面接を終了', exact: true }).click();
  const report = page.getByRole('dialog', { name: '面接レポート' });
  await expect(report).toBeVisible();
  await expect(report.getByRole('img', { name: /質問別ストレス/ })).toBeVisible();
  await expect(report.getByRole('img', { name: /質問別心拍/ })).toBeVisible();
  await expect(report.getByText('Q1では心拍110 bpm、ストレス80を記録しました。')).toBeVisible();
  await expect.poll(() => session.requests.length).toBe(1);
  const summary = session.requests[0];
  expect(summary.questions.map((q) => q.label)).toEqual(['Q1', 'Q2', 'Q3']);
  expect(summary.questions.map((q) => q.topic)).toEqual(['自己紹介', '志望動機', '自己紹介']);
  const measured = summary.participants[0].questions;
  expect(measured[0].bpm).toMatchObject({ count: 2, avg: 100, peak: 110, exceededCount: 1 });
  expect(measured[0].stress).toMatchObject({ count: 2, avg: 60, peak: 80, exceededCount: 1 });
  expect(measured[0].bpm.firstExceededAt).not.toBeNull();
  expect(measured[1].bpm.exceededCount).toBe(0);
  expect(measured[1].stress.exceededCount).toBe(0);
  expect(measured[2].bpm.peak).toBe(102);
  expect(summary.participants[0].excludedSamples).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'チャット', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('completed-report.png'), fullPage: true });
  await page.getByRole('button', { name: 'レポートを閉じる' }).click();
  await page.getByRole('button', { name: '前回のレポート' }).click();
  await expect(report).toBeVisible();
  expect(session.requests).toHaveLength(1);
});

test('時計がずれていても退出時に計測を保持し、AI未接続とデータ不足を区別する', async ({ page }) => {
  const session = await interview(page, 'local', -10000);
  await session.question('自己紹介');
  await session.sample(92, 45);
  await session.question('志望動機');
  await page.getByRole('button', { name: '退出', exact: true }).click();
  const report = page.getByRole('dialog', { name: '面接レポート' });
  await expect(report).toBeVisible();
  await expect.poll(() => session.requests.length).toBe(1);
  expect(session.requests[0].participants[0].questions[0].bpm.peak).toBe(92);
  expect(session.requests[0].startedAt).toBeLessThan(Date.now() - 9000);
  expect(session.requests[0].participants[0].questions[1].bpm.count).toBe(0);
  expect(session.requests[0].participants[0].questions[1].stress.peak).toBeNull();
  await expect(report.getByText(/AI.*未接続/).first()).toBeVisible();
  await expect(report.getByRole('cell', { name: '欠測', exact: true }).first()).toBeVisible();
});

test('AIサービスで失敗しても質問別グラフと数値分析を残す', async ({ page }) => {
  const session = await interview(page);
  await page.route('**/api/reports/analyze', (route) => route.fulfill({ status: 503, json: { detail: 'unavailable' } }));
  await session.question('自己紹介');
  await session.sample(115, 82);
  await page.getByRole('button', { name: '面接を終了', exact: true }).click();
  const report = page.getByRole('dialog', { name: '面接レポート' });
  await expect(report.getByRole('img', { name: /質問別心拍/ })).toBeVisible();
  await expect(report.getByText(/失敗|取得でき|生成でき|接続でき/).first()).toBeVisible();
});

test('実バックエンドで終了時の集計を検証し、APIキー未設定なら数値コメントを返す', async ({ page }) => {
  const session = await interview(page, 'server');
  await session.question('自己紹介');
  await session.sample(105, 78);
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/reports/analyze'));
  await page.getByRole('button', { name: '面接を終了', exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.source).toBe('local');
  expect(result.reason).toBe('not_configured');
  expect(result.observations[0].comment).toContain('Q1');
  expect(result.observations[0].comment).toContain('105');
  const report = page.getByRole('dialog', { name: '面接レポート' });
  await expect(report.getByText(result.observations[0].comment)).toBeVisible();
});
