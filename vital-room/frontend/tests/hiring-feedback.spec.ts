import { expect, test, type Page } from '@playwright/test';
import type { InterviewFeedback, InterviewSession } from '../lib/hiring';

const sessionId = 'feedback-ui-session';
const generatedAt = '2026-09-26T04:00:00Z';
const quote = '締め切りから逆算してタスクを整理し、担当を分担しました。';
const evidence = [{ turn_id: 'answer-1', quote }];
const feedback: InterviewFeedback = {
  version: 1, source: 'local', generated_at: generatedAt,
  summary: '役割分担の工夫が伝わりました。次は判断の理由と結果を具体的に伝えましょう。',
  strengths: [{ title: '自分が取った行動が具体的', observation: 'タスクを整理した手順について説明しています。', evidence, suggestion: '取り組みの目的を一言添えて伝えましょう。' }],
  improvements: [{ title: '成果を示す情報を補う', observation: '今回の回答では、取り組み後の変化までは確認できません。', evidence, suggestion: '期日前後で何が変わったかを振り返り、説明しましょう。' }],
  question_reviews: [{ question_index: 0, question: 'チームでの取り組みを教えてください。', summary: '締め切りを基準にタスクを整理し、分担した経験を話しました。', evidence, strengths: ['担当した行動が分かります。'], improvements: ['その分担に決めた理由を加えると伝わります。'], answer_outline: ['取り組みの目的を説明する。', '自分が行ったことと理由を伝える。', '実際に確認できた結果を伝える。'] }],
  practice_plan: ['取り組み前後の変化をメモする。', '目的・行動・結果の順に1分で話してみる。'],
};

function completedSession(): InterviewSession {
  return {
    invitation: { id: sessionId, template_id: 'feedback-template', code: 'FEEDBACK1234567890000', candidate_name: '応募者テスト', opens_at: null, expires_at: '2099-01-01T00:00:00Z', status: 'completed', created_at: generatedAt, title: '開発職の面接', job_title: '開発職', mode: 'ai', duration_minutes: 15, decision: 'pending' },
    template: { id: 'feedback-template', title: '開発職の面接', job_title: '開発職', mode: 'ai', duration_minutes: 15, questions: ['チームでの取り組みを教えてください。'], criteria: ['具体的な経験'], created_at: generatedAt },
    transcript: [
      { id: 'question-1', role: 'ai', text: 'チームでの取り組みを教えてください。', question_index: 0, created_at: generatedAt, source: 'local' },
      { id: 'answer-1', role: 'candidate', text: quote, question_index: 0, created_at: generatedAt },
    ],
    report: null, review: { decision: 'pending', notes: '' }, started_at: generatedAt, ended_at: generatedAt, deadline_at: generatedAt, ai_available: false, processing: false, feedback, feedback_processing: false,
  };
}

async function candidateAccess(page: Page) {
  await page.addInitScript(id => sessionStorage.setItem(`hiring_candidate_${id}`, 'candidate-feedback-token'), sessionId);
}

test('面接フィードバックは根拠と質問別の改善方法を確認でき、応募者自身が更新できる', async ({ page }) => {
  const session = completedSession();
  let refreshCount = 0;
  await candidateAccess(page);
  await page.route(`**/api/hiring/session/${sessionId}`, route => route.fulfill({ json: session }));
  await page.route(`**/api/hiring/session/${sessionId}/feedback`, async route => {
    refreshCount++;
    expect(route.request().headers().authorization).toBe('Bearer candidate-feedback-token');
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual({});
    await route.fulfill({ json: { ...session, feedback: { ...feedback, source: 'ai', summary: '更新した振り返り：判断した理由まで伝えてみましょう。' } } });
  });
  await page.goto(`/interviews/session?id=${sessionId}`);
  const panel = page.getByRole('region', { name: '面接のフィードバック', exact: true });
  await expect(panel.getByText('回答内容の整理（AI未使用）', { exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { name: '自分が取った行動が具体的' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: '成果を示す情報を補う' })).toBeVisible();
  await panel.locator('summary').click();
  await expect(panel.getByRole('heading', { name: '次に話すときの組み立て方' })).toBeVisible();
  await expect(panel.getByText('自分が行ったことと理由を伝える。', { exact: true })).toBeVisible();
  await panel.getByRole('link', { name: /この発言を会話で確認する/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`#turn-answer-1$`));
  await expect(page.locator('#turn-answer-1')).toBeVisible();
  await panel.getByRole('button', { name: 'フィードバックを更新', exact: true }).click();
  await expect(panel.getByText('AIによる回答の振り返り', { exact: true })).toBeVisible();
  await expect(panel.getByText('更新した振り返り：判断した理由まで伝えてみましょう。', { exact: true })).toBeVisible();
  expect(refreshCount).toBe(1);
  await expect(page.getByRole('heading', { name: '担当者の判断', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/interview-feedback-mobile.png', fullPage: true });
});

test('面接終了後もフィードバック作成中は自動で読み込み、完了すると表示する', async ({ page }) => {
  const session = completedSession();
  let reads = 0;
  let processing = true;
  await candidateAccess(page);
  await page.route(`**/api/hiring/session/${sessionId}`, async route => {
    reads++;
    await route.fulfill({ json: processing ? { ...session, feedback: null, feedback_processing: true } : session });
  });
  await page.goto(`/interviews/session?id=${sessionId}`);
  const panel = page.getByRole('region', { name: '面接のフィードバック', exact: true });
  await expect(panel.getByRole('status')).toContainText('完了すると自動で表示します');
  await expect(panel.getByRole('button', { name: 'フィードバックを作成', exact: true })).toBeDisabled();
  const pendingReads = reads;
  processing = false;
  await expect(panel.getByText(feedback.summary, { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toHaveCount(0);
  expect(reads).toBeGreaterThan(pendingReads);
});

test('既存の面接記録にフィードバックがなくても応募者が作成できる', async ({ page }) => {
  const session = completedSession();
  await candidateAccess(page);
  await page.route(`**/api/hiring/session/${sessionId}`, route => route.fulfill({ json: { ...session, feedback: undefined, feedback_processing: undefined } }));
  await page.route(`**/api/hiring/session/${sessionId}/feedback`, route => route.fulfill({ json: session }));
  await page.goto(`/interviews/session?id=${sessionId}`);
  const panel = page.getByRole('region', { name: '面接のフィードバック', exact: true });
  await expect(panel).toContainText('フィードバックはまだ作成されていません');
  await panel.getByRole('button', { name: 'フィードバックを作成', exact: true }).click();
  await expect(panel.getByText(feedback.summary, { exact: true })).toBeVisible();
});

test('企業は共有する回答の振り返りと企業専用の集計・判断を個別に確認できる', async ({ page }) => {
  const session = completedSession();
  session.review = { decision: 'hold', notes: '企業専用の面接メモ' };
  session.report = { source: 'local', summary: '具体的な経験を確認するための企業向け集計です。', generated_at: generatedAt, items: [{ criterion: '具体的な経験', summary: '分担した経験を確認できました。', evidence, follow_up: 'どのように分担を決めたか確認します。' }] };
  await page.addInitScript(() => sessionStorage.setItem('hiring_employer_token', 'employer-feedback-token'));
  await page.route(`**/api/hiring/invitations/${sessionId}`, route => route.fulfill({ json: session }));
  await page.route(`**/api/hiring/invitations/${sessionId}/report`, route => route.fulfill({ json: { ...session, feedback: { ...feedback, summary: '企業側でも新しい振り返りに更新されました。' } } }));
  await page.goto(`/company/report?id=${sessionId}`);
  await expect(page.getByRole('heading', { name: '根拠付きの面接集計', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^担当者メモ/ })).toHaveValue('企業専用の面接メモ');
  const panel = page.getByRole('region', { name: '回答の振り返り', exact: true });
  await expect(panel).toContainText('応募者にも共有する振り返りです');
  await expect(panel.getByText(feedback.summary, { exact: true })).toBeVisible();
  await panel.getByRole('link', { name: /この発言を会話で確認する/ }).first().click();
  await expect(page).toHaveURL(new RegExp(`#turn-answer-1$`));
  await page.getByRole('button', { name: '集計を再作成', exact: true }).click();
  await expect(panel.getByText('企業側でも新しい振り返りに更新されました。', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^担当者メモ/ })).toHaveValue('企業専用の面接メモ');
});
