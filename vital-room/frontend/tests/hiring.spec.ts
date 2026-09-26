import { expect, test, type Page, type APIRequestContext, type WebSocketRoute } from '@playwright/test';

type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type TestRecognition = {
  onstart?: () => void; onend?: () => void;
  onerror?: (event: { error: string }) => void;
  onresult?: (event: { resultIndex: number; results: RecognitionResult[] }) => void;
  start: () => void; stop: () => void; abort: () => void;
};
declare global {
  interface Window {
    hiringTestTracks: MediaStreamTrack[];
    releaseHiringPermission?: () => void;
    hiringDeviceRequests: number;
    hiringSpeechLines: SpeechSynthesisUtterance[];
    hiringSpeechCancels: number;
    hiringAudioPlayers: HTMLMediaElement[];
    hiringAudioPaused: number;
    hiringCopiedText: string;
    hiringRecognizers: TestRecognition[];
    hiringRecognitionActive: boolean;
    hiringRecognitionStops: number;
    hiringRecognitionAborts: number;
    hiringRecognitionTail: string;
  }
}

let voiceCompany: Promise<{ token: string }> | undefined;
async function voiceSession(page: Page, request: APIRequestContext, provider = false) {
  voiceCompany ??= account(request);
  const company = await voiceCompany;
  const invitation = await invite(request, company.token);
  const claim = await post(request, '/join/start', { code: invitation.code, name: '応募者テスト', consent: true });
  await page.addInitScript(({ id, token }) => {
    sessionStorage.setItem(`hiring_candidate_${id}`, token);
    window.hiringSpeechLines = [];
    window.hiringSpeechCancels = 0;
    window.hiringAudioPlayers = [];
    window.hiringAudioPaused = 0;
    window.hiringRecognizers = [];
    window.hiringRecognitionActive = false;
    window.hiringRecognitionStops = 0;
    window.hiringRecognitionAborts = 0;
    window.hiringRecognitionTail = '';
    class TestSpeechRecognition {
      onstart?: () => void; onend?: () => void;
      onerror?: (event: { error: string }) => void;
      onresult?: (event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void;
      start() {
        window.hiringRecognizers.push(this);
        window.hiringRecognitionActive = true;
        this.onstart?.();
      }
      stop() {
        window.hiringRecognitionStops++;
        window.hiringRecognitionActive = false;
        // Recognition commonly delivers the final words asynchronously after stop().
        setTimeout(() => {
          if (window.hiringRecognitionTail) {
            this.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: window.hiringRecognitionTail } }] });
            window.hiringRecognitionTail = '';
          }
          this.onend?.();
        }, 40);
      }
      abort() { window.hiringRecognitionAborts++; window.hiringRecognitionActive = false; this.onend?.(); }
    }
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: TestSpeechRecognition });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: TestSpeechRecognition });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [{ lang: 'ja-JP', name: 'Test Japanese', default: true, localService: true, voiceURI: 'test-ja' }],
      addEventListener: () => {}, removeEventListener: () => {},
      cancel: () => { window.hiringSpeechCancels++; },
      speak: (line: SpeechSynthesisUtterance) => { window.hiringSpeechLines.push(line); },
    } });
    // Keep speech completion under test control without playing sound.
    class TestUtterance {
      text: string;
      onstart?: () => void;
      onend?: () => void;
      constructor(text: string) { this.text = text; }
    }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: TestUtterance });
    Object.defineProperty(window, 'Audio', { configurable: true, value: function TestAudio() { return document.createElement('audio'); } });
    HTMLMediaElement.prototype.play = function () { window.hiringAudioPlayers.push(this); return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () { window.hiringAudioPaused++; };
    HTMLMediaElement.prototype.load = function () {};
  }, { id: invitation.id, token: claim.token });
  if (provider) {
    await page.route(`**/api/hiring/session/${invitation.id}`, async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), ai_available: true } });
    });
  }
  await page.goto(`/interviews/session?id=${invitation.id}`);
  await expect(page.getByTestId('ai-interviewer')).toHaveAttribute('data-state', 'ready');
  return invitation;
}

test('AI面接は開始と回答完了だけで質問・音声回答を進め、最後の発話も保存する', async ({ page, request }) => {
  const invitation = await voiceSession(page, request);
  const interviewer = page.getByTestId('ai-interviewer');
  expect(await page.evaluate(() => window.hiringSpeechLines.length)).toBe(0);
  await page.getByRole('button', { name: '面接を開始', exact: true }).click();
  await expect(interviewer).toHaveAttribute('data-state', 'loading');
  await expect(page.getByRole('button', { name: '音声で回答', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.hiringRecognitionActive)).toBe(false);
  expect(await page.evaluate(() => window.hiringSpeechLines[0].text)).toBe('チームでの取り組みを教えてください。');
  await page.evaluate(() => window.hiringSpeechLines[0].onstart?.call(window.hiringSpeechLines[0], new Event('start') as SpeechSynthesisEvent));
  await expect(interviewer).toHaveAttribute('data-state', 'speaking');
  await expect(interviewer.getByText('質問中', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/ai-interviewer-speaking.png', fullPage: true });
  await page.evaluate(() => window.hiringSpeechLines[0].onend?.call(window.hiringSpeechLines[0], new Event('end') as SpeechSynthesisEvent));
  await expect(interviewer).toHaveAttribute('data-state', 'listening');
  await expect.poll(() => page.evaluate(() => window.hiringRecognitionActive)).toBe(true);
  await page.evaluate(() => {
    window.hiringRecognizers.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'チームで課題を分担' } }] });
    window.hiringRecognitionTail = 'チームで課題を分担して実装しました。';
  });
  await expect(page.getByTestId('ai-answer-interim')).toContainText('チームで課題を分担');
  await page.getByRole('button', { name: '回答を完了', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.hiringSpeechLines.length)).toBe(2);
  expect(await page.evaluate(() => window.hiringRecognitionActive)).toBe(false);
  await expect(page.getByText('チームで課題を分担して実装しました。', { exact: true })).toBeVisible();
  const nextQuestion = await interviewer.locator('h2 + p').innerText();
  expect(await page.evaluate(() => window.hiringSpeechLines[1].text)).toBe(nextQuestion);
  await page.evaluate(() => window.hiringSpeechLines[1].onstart?.call(window.hiringSpeechLines[1], new Event('start') as SpeechSynthesisEvent));
  await expect(interviewer).toHaveAttribute('data-state', 'speaking');
  await page.evaluate(() => window.hiringSpeechLines[1].onend?.call(window.hiringSpeechLines[1], new Event('end') as SpeechSynthesisEvent));
  await expect(interviewer).toHaveAttribute('data-state', 'listening');
  const recognizers = await page.evaluate(() => window.hiringRecognizers.length);
  await page.evaluate(() => {
    const rec = window.hiringRecognizers.at(-1);
    rec?.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'チームの進捗を整理しました。' } }] });
    window.hiringRecognitionActive = false;
    rec?.onend?.();
  });
  // A browser ending recognition mid-answer must resume without another click.
  await expect.poll(() => page.evaluate(() => window.hiringRecognizers.length)).toBe(recognizers + 1);
  await page.evaluate(() => window.hiringRecognizers.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: '期日までに完成させました。' } }] }));
  await page.getByRole('button', { name: '回答を完了', exact: true }).click();
  const laterAnswers = [
    '作業記録を確認し、遅延が減ったことを確かめました。',
    '自分が担当した進捗共有が、相談を早めるきっかけになりました。',
  ];
  for (const [offset, text] of laterAnswers.entries()) {
    const index = offset + 2;
    await expect.poll(() => page.evaluate(() => window.hiringSpeechLines.length)).toBe(index + 1);
    await expect(page.getByLabel('面接の進行状況')).toContainText(`深掘り ${index} / 3`);
    await expect(page.getByRole('button', { name: '面接を開始', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => window.hiringRecognitionActive)).toBe(false);
    await page.evaluate(n => {
      const line = window.hiringSpeechLines[n];
      line.onstart?.call(line, new Event('start') as SpeechSynthesisEvent);
    }, index);
    await expect(interviewer).toHaveAttribute('data-state', 'speaking');
    await page.evaluate(n => {
      const line = window.hiringSpeechLines[n];
      line.onend?.call(line, new Event('end') as SpeechSynthesisEvent);
    }, index);
    await expect(interviewer).toHaveAttribute('data-state', 'listening');
    await expect.poll(() => page.evaluate(() => window.hiringRecognitionActive)).toBe(true);
    await page.evaluate(value => {
      window.hiringRecognizers.at(-1)?.onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: value.slice(0, -5) } }] });
      window.hiringRecognitionTail = value;
    }, text);
    await page.getByRole('button', { name: '回答を完了', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '面接が終了しました' })).toBeVisible();
  const feedback = page.getByRole('region', { name: '面接のフィードバック', exact: true });
  await expect(feedback.getByText('回答内容の整理（AI未使用）', { exact: true })).toBeVisible();
  await expect(feedback.getByRole('region', { name: '次に改善できる点', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.hiringRecognitionActive)).toBe(false);
  const spokenQuestions = await page.evaluate(() => window.hiringSpeechLines.map(line => line.text));
  expect(spokenQuestions).toHaveLength(4);
  expect(new Set(spokenQuestions).size).toBe(4);
  const token = await page.evaluate(id => sessionStorage.getItem(`hiring_candidate_${id}`), invitation.id);
  const result = await request.get(`${api}/session/${invitation.id}`, { headers: { Authorization: `Bearer ${token}` } });
  const savedSession = await result.json();
  const answers = savedSession.transcript.filter((turn: { role: string }) => turn.role === 'candidate');
  expect(answers).toHaveLength(4);
  expect(answers[0].text).toBe('チームで課題を分担して実装しました。');
  expect(answers[1].text).toContain('チームの進捗を整理しました。');
  expect(answers[1].text).toContain('期日までに完成させました。');
  expect(answers.slice(2).map((turn: { text: string }) => turn.text)).toEqual(laterAnswers);
  expect(new Set(answers.map((turn: { id: string }) => turn.id)).size).toBe(4);
  expect(savedSession.feedback.question_reviews).toHaveLength(1);
});

test('AI生成音声は再生イベントに合わせて表示し、停止と接続失敗時の読み上げに対応する', async ({ page, request }) => {
  let speechRequests = 0;
  let fail = false;
  await page.route('**/api/hiring/session/*/speech', async route => {
    speechRequests++;
    expect(Object.keys(route.request().postDataJSON())).toEqual(['turn_id']);
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    await route.fulfill(fail ? { status: 503, json: { detail: '音声を取得できませんでした' } } : { status: 200, contentType: 'audio/mpeg', body: Buffer.from('mock-mp3') });
  });
  await voiceSession(page, request, true);
  const interviewer = page.getByTestId('ai-interviewer');
  await page.getByRole('button', { name: '面接を開始', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.hiringAudioPlayers.length)).toBe(1);
  await expect(interviewer).toHaveAttribute('data-state', 'loading');
  expect(await page.evaluate(() => window.hiringSpeechLines.length)).toBe(0);
  await page.evaluate(() => window.hiringAudioPlayers[0].dispatchEvent(new Event('playing')));
  await expect(interviewer).toHaveAttribute('data-state', 'speaking');
  await expect(interviewer).toContainText('AIによる合成音声');
  await page.evaluate(() => window.hiringAudioPlayers[0].dispatchEvent(new Event('waiting')));
  await expect(interviewer).toHaveAttribute('data-state', 'loading');
  await page.evaluate(() => window.hiringAudioPlayers[0].dispatchEvent(new Event('playing')));
  await expect(interviewer).toHaveAttribute('data-state', 'speaking');
  await page.getByRole('button', { name: '読み上げを停止', exact: true }).click();
  await expect(interviewer).toHaveAttribute('data-state', 'waiting');
  expect(await page.evaluate(() => window.hiringAudioPaused)).toBeGreaterThan(0);
  fail = true;
  await page.getByRole('button', { name: 'もう一度聞く', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.hiringSpeechLines.length)).toBe(1);
  await expect(interviewer).toContainText('AI音声に接続できないため');
  await expect(interviewer).toHaveAttribute('data-state', 'loading');
  await page.evaluate(() => window.hiringSpeechLines[0].onstart?.call(window.hiringSpeechLines[0], new Event('start') as SpeechSynthesisEvent));
  await expect(interviewer).toHaveAttribute('data-state', 'speaking');
  const cancels = await page.evaluate(() => window.hiringSpeechCancels);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '面接を終了', exact: true }).click();
  await expect(page.getByRole('heading', { name: '面接が終了しました' })).toBeVisible();
  await expect(interviewer).toHaveCount(0);
  expect(await page.evaluate(() => window.hiringSpeechCancels)).toBeGreaterThan(cancels);
  expect(speechRequests).toBe(2);
});

test('マイク許可の待機中や回答中に音声をオフにすると、自動入力を開始・継続しない', async ({ page, request }) => {
  await voiceSession(page, request);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => new Promise<MediaStream>(resolve => {
      window.releaseHiringPermission = () => resolve(new MediaStream());
    });
  });
  const interviewer = page.getByTestId('ai-interviewer');
  await page.getByRole('button', { name: '面接を開始', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean(window.releaseHiringPermission))).toBe(true);
  await page.evaluate(() => {
    const line = window.hiringSpeechLines[0];
    line.onstart?.call(line, new Event('start') as SpeechSynthesisEvent);
    line.onend?.call(line, new Event('end') as SpeechSynthesisEvent);
  });
  await page.getByRole('button', { name: '音声をオフ', exact: true }).click();
  await page.evaluate(() => window.releaseHiringPermission?.());
  await expect(interviewer).toHaveAttribute('data-state', 'muted');
  await expect(page.getByText('マイクの利用許可を確認しています。', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => window.hiringRecognizers.length)).toBe(0);
  await page.getByRole('button', { name: '音声をオン', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.hiringSpeechLines.length)).toBe(2);
  await page.evaluate(() => {
    const line = window.hiringSpeechLines[1];
    line.onstart?.call(line, new Event('start') as SpeechSynthesisEvent);
    line.onend?.call(line, new Event('end') as SpeechSynthesisEvent);
  });
  await expect(interviewer).toHaveAttribute('data-state', 'listening');
  await page.getByRole('button', { name: '音声をオフ', exact: true }).click();
  await expect(interviewer).toHaveAttribute('data-state', 'muted');
  expect(await page.evaluate(() => window.hiringRecognitionActive)).toBe(false);
  expect(await page.evaluate(() => window.hiringRecognitionAborts)).toBeGreaterThan(0);
});

test('マイクの権限を拒否した場合も、質問を聞いて文字で回答を完了できる', async ({ page, request }) => {
  await voiceSession(page, request);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  await page.getByRole('button', { name: '面接を開始', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('マイクを利用できません');
  for (const [index, answer] of [
    'チームで課題を分担しました。',
    '私は進捗の確認を担当しました。',
    '遅れを早く見つけるために、毎週確認する方法を選びました。',
    '結果として、予定通りに完成させました。',
  ].entries()) {
    await expect.poll(() => page.evaluate(() => window.hiringSpeechLines.length)).toBe(index + 1);
    await page.evaluate(n => {
      const line = window.hiringSpeechLines[n];
      line.onstart?.call(line, new Event('start') as SpeechSynthesisEvent);
      line.onend?.call(line, new Event('end') as SpeechSynthesisEvent);
    }, index);
    await page.getByLabel('あなたの回答').fill(answer);
    await page.getByRole('button', { name: '回答を完了', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '面接が終了しました' })).toBeVisible();
  await expect(page.getByRole('region', { name: '面接のフィードバック', exact: true })).toContainText('回答内容の整理（AI未使用）');
  expect(await page.evaluate(() => window.hiringRecognizers.length)).toBe(0);
});

const api = 'http://127.0.0.1:8100/api/hiring';
const password = 'Managed-Interview-123!';
async function post(request: APIRequestContext, path: string, data: unknown, token?: string) {
  const response = await request.post(`${api}${path}`, { data, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  expect(response.ok(), await response.text()).toBeTruthy();
  return response.json();
}
async function account(request: APIRequestContext) {
  return post(request, '/auth/register', { company_name: '動作確認企業', email: `${crypto.randomUUID()}@example.test`, password });
}
async function invite(request: APIRequestContext, token: string, mode = 'ai') {
  const template = await post(request, '/templates', {
    title: 'エンジニア面接', job_title: 'エンジニア', mode, duration_minutes: 15,
    questions: ['チームでの取り組みを教えてください。'], criteria: ['チーム'],
  }, token);
  return post(request, `/templates/${template.id}/invitations`, {
    candidate_name: '応募者テスト', opens_at: null,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  }, token);
}
async function employerPage(page: Page, token: string) {
  await page.goto('/company');
  await page.evaluate(value => sessionStorage.setItem('hiring_employer_token', value), token);
  await page.reload();
  await expect(page.getByRole('heading', { name: '1. 面接を設定する' })).toBeVisible();
}

test('通常の管理画面で別端末用URLを取得し、接続停止後に古いURLをコピーさせない', async ({ page, request }) => {
  voiceCompany ??= account(request);
  const company = await voiceCompany;
  const invitation = await invite(request, company.token);
  let ready = false;
  let origin = 'https://first-interview.trycloudflare.com';
  await page.route('**/api/hiring/sharing', route => route.fulfill({ json: {
    public_origin: ready ? origin : null, reachable: ready, temporary: true, reason: ready ? null : 'unreachable',
  } }));
  await page.addInitScript(token => sessionStorage.setItem('hiring_employer_token', token), company.token);
  await page.goto(`/company/invitation?id=${invitation.id}`);
  const link = page.getByLabel('招待URL', { exact: true });
  const copyButton = page.getByRole('button', { name: '招待URLをコピー', exact: true });
  await expect(page.getByTestId('invitation-sharing-status')).toContainText('別端末からの接続を確認できません');
  await expect(link).toHaveValue('');
  await expect(copyButton).toBeDisabled();
  await expect(page.getByLabel('招待コード', { exact: true })).toHaveValue(invitation.code);
  ready = true;
  await page.getByRole('button', { name: '接続を再確認', exact: true }).click();
  await expect(link).toHaveValue(`${origin}/interviews/join?code=${invitation.code}`);
  await expect(copyButton).toBeEnabled();
  expect(new URL(page.url()).hostname).toBe('localhost');
  origin = 'https://second-interview.trycloudflare.com';
  await page.getByRole('button', { name: '接続を再確認', exact: true }).click();
  await expect(link).toHaveValue(`${origin}/interviews/join?code=${invitation.code}`);
  await expect(page.getByLabel('コード入力用URL', { exact: true })).toHaveValue(`${origin}/interviews/join`);
  ready = false;
  await page.getByRole('button', { name: '接続を再確認', exact: true }).click();
  await expect(link).toHaveValue('');
  await expect(copyButton).toBeDisabled();
  await expect(page.getByRole('button', { name: 'コード入力用URLをコピー', exact: true })).toBeDisabled();
  ready = true;
  await page.reload();
  await expect(link).toHaveValue(`${origin}/interviews/join?code=${invitation.code}`);
  await expect(page.getByLabel('招待コード', { exact: true })).toHaveValue(invitation.code);
});

test('就活生は参加を選んだ次の画面で招待コードを入力する', async ({ page }) => {
  await page.addInitScript(() => {
    window.hiringDeviceRequests = 0;
    navigator.mediaDevices.getUserMedia = async () => { window.hiringDeviceRequests++; throw new Error('招待確認前に機器を開始してはいけません'); };
  });
  const sockets: string[] = [];
  page.on('websocket', socket => { if (new URL(socket.url()).pathname.startsWith('/ws/')) sockets.push(socket.url()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '面接をはじめる' })).toBeVisible();
  await page.getByRole('button', { name: '就活生', exact: true }).click();
  await expect(page.getByLabel('招待コード', { exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: '就活生として面接に参加', exact: true }).click();
  await expect(page).toHaveURL('/interviews/join');
  await expect(page.getByRole('heading', { name: '招待コードを入力' })).toBeVisible();
  await expect(page.getByLabel('招待コード', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '機器を接続・確認' })).toHaveCount(0);
  expect(sockets).toEqual([]);
  expect(await page.evaluate(() => window.hiringDeviceRequests)).toBe(0);
});

for (const [mode, label] of [['human', '対人面接'], ['ai', 'AI面接']] as const) {
  test(`面接官が機器設定前に${label}を選び、ログイン後の面接設定に引き継ぐ`, async ({ page, request }) => {
    const company = await account(request);
    await page.addInitScript(() => {
      window.hiringDeviceRequests = 0;
      navigator.mediaDevices.getUserMedia = async () => { window.hiringDeviceRequests++; throw new Error('面接方式の設定前に機器を開始してはいけません'); };
    });
    await page.goto('/');
    await page.getByRole('button', { name: '面接官', exact: true }).click();
    const choice = page.getByRole('button', { name: new RegExp(`^${label}`) });
    await choice.click();
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('link', { name: 'この方式で面接を設定' }).click();
    await expect(page).toHaveURL(`/company?mode=${mode}`);
    await page.getByLabel('メールアドレス').fill(company.company.email);
    await page.getByLabel('パスワード', { exact: true }).fill(password);
    await page.locator('form').getByRole('button', { name: 'ログイン', exact: true }).click();
    await expect(page.getByRole('radio', { name: label, exact: true })).toBeChecked();
    await page.getByLabel('面接名', { exact: true }).fill(`入口からの${label}`);
    await page.getByLabel('募集職種').fill('エンジニア');
    await page.getByLabel('質問（1行に1問）').fill('取り組んだことを教えてください。');
    await page.getByLabel('確認したい項目', { exact: false }).fill('取り組み');
    await page.getByRole('button', { name: '面接設定を保存', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('面接設定を保存しました');
    const templates = await request.get(`${api}/templates`, { headers: { Authorization: `Bearer ${company.token}` } });
    expect((await templates.json()).templates[0].mode).toBe(mode);
    await expect(page.locator('video')).toHaveCount(0);
    expect(await page.evaluate(() => window.hiringDeviceRequests)).toBe(0);
  });
}

test('企業が面接設定と応募者別の招待を作り、回答の根拠と人の判断を保存する', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  const sharedOrigin = 'https://interviews.example.test';
  await page.route('**/api/hiring/sharing', route => route.fulfill({ json: { public_origin: sharedOrigin, reachable: true, temporary: true, reason: null } }));
  await page.goto('/company');
  await page.getByRole('button', { name: '企業アカウントを作成', exact: true }).click();
  await page.getByLabel('企業名', { exact: true }).fill('ブラウザー確認企業');
  await page.getByLabel('メールアドレス').fill(`${crypto.randomUUID()}@example.test`);
  await page.getByLabel('パスワード', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'アカウントを作成', exact: true }).click();
  await page.getByLabel('面接名', { exact: true }).fill('新卒エンジニア面接');
  await page.getByLabel('募集職種').fill('エンジニア');
  await page.getByRole('radio', { name: 'AI面接', exact: true }).check();
  await page.getByLabel('質問（1行に1問）').fill('チームでの取り組みを教えてください。');
  await page.getByLabel('確認したい項目', { exact: false }).fill('チーム');
  await page.getByRole('button', { name: '面接設定を保存', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('面接設定を保存しました');
  await expect(page.getByLabel('面接名', { exact: true })).toHaveValue('新卒エンジニア面接');
  await expect(page.getByLabel('質問（1行に1問）')).toHaveValue('チームでの取り組みを教えてください。');
  await expect(page.getByLabel('確認したい項目', { exact: false })).toHaveValue('チーム');
  await page.getByLabel('応募者名', { exact: true }).fill('応募者テスト');
  await page.getByRole('button', { name: '招待URL・コードを発行' }).click();
  await expect(page).toHaveURL(/\/company\/invitation\?id=/);
  await expect(page.getByRole('heading', { name: '招待URL・コードを確認', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('招待を発行しました');
  const token = await page.evaluate(() => sessionStorage.getItem('hiring_employer_token'));
  const response = await request.get(`${api}/invitations`, { headers: { Authorization: `Bearer ${token}` } });
  const invitation = (await response.json()).invitations[0];
  await expect(page.getByLabel('招待コード', { exact: true })).toHaveValue(invitation.code);
  await expect(page.getByLabel('招待URL', { exact: true })).toHaveValue(`${sharedOrigin}/interviews/join?code=${invitation.code}`);
  await expect(page.getByLabel('コード入力用URL', { exact: true })).toHaveValue(`${sharedOrigin}/interviews/join`);
  await expect(page.getByTestId('invitation-sharing-status')).toContainText('別端末から参加できます');
  expect(new URL(page.url()).hostname).toBe('localhost');
  await expect(page.getByText('このURLは現在のPC専用です。', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '招待URLをコピー', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'コードをコピー', exact: true })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { window.hiringCopiedText = text; },
  } }));
  await page.getByRole('button', { name: 'コードをコピー', exact: true }).click();
  expect(await page.evaluate(() => window.hiringCopiedText)).toBe(invitation.code);
  await page.getByRole('button', { name: '招待URLをコピー', exact: true }).click();
  expect(await page.evaluate(() => window.hiringCopiedText)).toBe(await page.getByLabel('招待URL', { exact: true }).inputValue());
  await page.getByRole('button', { name: 'コード入力用URLをコピー', exact: true }).click();
  expect(await page.evaluate(() => window.hiringCopiedText)).toBe(`${sharedOrigin}/interviews/join`);
  await page.screenshot({ path: 'test-results/company-invitation.png', fullPage: true });
  await expect(page.getByLabel('質問（1行に1問）')).toHaveCount(0);
  await page.getByRole('link', { name: '面接設定に戻る', exact: true }).click();
  await expect(page).toHaveURL(/\/company$/);
  await page.reload();
  await expect(page.getByLabel('面接名', { exact: true })).toHaveValue('新卒エンジニア面接');
  await expect(page.getByLabel('募集職種')).toHaveValue('エンジニア');
  await expect(page.getByRole('radio', { name: 'AI面接', exact: true })).toBeChecked();
  await expect(page.getByLabel('質問（1行に1問）')).toHaveValue('チームでの取り組みを教えてください。');
  await expect(page.getByLabel('確認したい項目', { exact: false })).toHaveValue('チーム');
  // Edits must be saved before an invitation can use them; never silently use the old template.
  await page.getByLabel('質問（1行に1問）').fill('変更後の質問です。');
  await expect(page.getByRole('button', { name: '招待URL・コードを発行' })).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('質問（1行に1問）')).toHaveValue('変更後の質問です。');
  await page.getByLabel('質問（1行に1問）').fill('チームでの取り組みを教えてください。');
  const claim = await post(request, '/join/start', { code: invitation.code, name: '応募者テスト', consent: true });
  let session = claim.session;
  const fixtureAnswers = [
    'チームで課題を分担して実装しました。',
    '私は進捗の確認を担当しました。',
    '遅れを早く見つけるために、毎週確認する方法を選びました。',
    '結果として、予定通りに完成させました。',
  ];
  let answerCount = 0;
  while (session.invitation.status === 'in_progress' && answerCount < fixtureAnswers.length) {
    session = await post(request, `/session/${invitation.id}/answer`, {
      text: fixtureAnswers[answerCount], request_id: crypto.randomUUID(), expected_turn_id: session.transcript.at(-1).id,
    }, claim.token);
    answerCount++;
  }
  expect(answerCount).toBeGreaterThanOrEqual(3);
  expect(session.invitation.status).toBe('completed');
  await page.getByRole('button', { name: '更新', exact: true }).click();
  await page.getByRole('link', { name: '集計・判断を開く', exact: true }).click();
  await expect(page).toHaveURL(`/company/report?id=${invitation.id}`);
  await expect(page.getByLabel('質問（1行に1問）')).toHaveCount(0);
  const record = page.getByRole('region', { name: '面接記録と判断' });
  await expect(record.getByText('チームで課題を分担して実装しました。', { exact: false }).first()).toBeVisible();
  const evidence = record.locator('a[href^="#turn-"]').first();
  await expect(evidence).toBeVisible();
  await page.screenshot({ path: 'test-results/company-report.png', fullPage: true });
  const target = await evidence.getAttribute('href');
  await evidence.click();
  await expect(page.locator(target!)).toBeVisible();
  await record.getByRole('combobox').selectOption('advance');
  await record.getByRole('textbox').fill('次の面接で実装の詳細を確認する');
  await record.getByRole('button', { name: '記録を更新', exact: true }).click();
  await expect(record.getByRole('button', { name: '記録を更新', exact: true })).toBeEnabled();
  await expect(record.getByRole('combobox')).toHaveValue('advance');
  await expect(record.getByRole('textbox')).toHaveValue('次の面接で実装の詳細を確認する');
  await record.getByRole('button', { name: '判断を保存' }).click();
  await expect(page.getByRole('status')).toContainText('判断を保存しました');
  await page.reload();
  await expect(page.getByRole('region', { name: '面接記録と判断' }).getByRole('textbox')).toHaveValue('次の面接で実装の詳細を確認する');
  const privateResult = await request.get(`${api}/session/${invitation.id}`, { headers: { Authorization: `Bearer ${claim.token}` } });
  const privateSession = await privateResult.json();
  expect(privateSession.report).toBeNull();
  expect(privateSession.review.notes).toBe('');
  // A new choice at the entry screen changes only the mode, preserving the saved draft.
  await page.goto('/');
  await page.getByRole('button', { name: '面接官', exact: true }).click();
  await page.getByRole('button', { name: /^対人面接/ }).click();
  await page.getByRole('link', { name: 'この方式で面接を設定' }).click();
  await expect(page.getByRole('radio', { name: '対人面接', exact: true })).toBeChecked();
  await expect(page.getByLabel('面接名', { exact: true })).toHaveValue('新卒エンジニア面接');
  await expect(page.getByLabel('質問（1行に1問）')).toHaveValue('チームでの取り組みを教えてください。');
  await page.getByRole('radio', { name: 'AI面接', exact: true }).check();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'AI面接', exact: true })).toBeChecked();
  expect(errors).toEqual([]);
});

test('別企業は応募者の面接記録を閲覧できず、取り消した招待では開始できない', async ({ request, page }) => {
  const owner = await account(request);
  const other = await account(request);
  const invitation = await invite(request, owner.token);
  const denied = await request.get(`${api}/invitations/${invitation.id}`, { headers: { Authorization: `Bearer ${other.token}` } });
  expect([403, 404]).toContain(denied.status());
  await employerPage(page, other.token);
  for (const destination of ['invitation', 'report']) {
    await page.goto(`/company/${destination}?id=${invitation.id}`);
    await expect(page.getByRole('main').getByRole('alert')).toContainText('面接が見つかりません');
    await expect(page.getByLabel('招待コード', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: '面接記録と判断' })).toHaveCount(0);
    await expect(page.getByText('応募者テスト', { exact: true })).toHaveCount(0);
  }
  await employerPage(page, owner.token);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '招待を取り消す' }).click();
  await expect(page.getByText('招待取消', { exact: true })).toBeVisible();
  const claim = await request.post(`${api}/join/start`, { data: { code: invitation.code, name: '応募者テスト', consent: true } });
  expect(claim.ok()).toBeFalsy();
});

test('応募者は招待URLからAI面接に参加し、再読み込み後も回答を再開できる', async ({ request, page }) => {
  const company = await account(request);
  const invitation = await invite(request, company.token);
  await page.goto(`/interviews/join?code=${invitation.code}`);
  await expect(page.getByRole('heading', { name: 'エンジニア面接', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '準備完了・面接を開始' })).toBeDisabled();
  await page.getByLabel('カメラを使用', { exact: true }).uncheck();
  await page.getByLabel('マイクを使用', { exact: true }).uncheck();
  await page.getByRole('button', { name: '機器を接続・確認' }).click();
  await page.getByLabel('お名前', { exact: true }).fill('応募者テスト');
  await page.getByRole('checkbox', { name: '面接方式と記録の利用目的', exact: false }).check();
  await page.getByRole('button', { name: '準備完了・面接を開始' }).click();
  await expect(page).toHaveURL(new RegExp(`/interviews/session\\?id=${invitation.id}`));
  await expect(page.getByText('回答に応じた質問（AI未使用）', { exact: true })).toBeVisible();
  const first = 'チームで課題を分担して実装しました。';
  await page.getByLabel('あなたの回答').fill(first);
  await page.getByRole('button', { name: '回答を完了', exact: true }).click();
  await expect(page.getByLabel('あなたの回答')).toHaveValue('');
  await page.reload();
  await expect(page.getByText(first, { exact: true })).toBeVisible();
  for (const [index, answer] of [
    '私は進捗の確認を担当しました。',
    '遅れを早く見つけるために、毎週確認する方法を選びました。',
    '結果として、予定通りに完成させました。',
  ].entries()) {
    await expect(page.getByLabel('面接の進行状況')).toContainText(`深掘り ${index + 1} / 3`);
    await page.getByLabel('あなたの回答').fill(answer);
    await page.getByRole('button', { name: '回答を完了', exact: true }).click();
    if (index < 2) await expect(page.getByLabel('あなたの回答')).toHaveValue('');
  }
  await expect(page.getByRole('heading', { name: '面接が終了しました' })).toBeVisible();
  await expect(page.getByRole('region', { name: '面接のフィードバック', exact: true })).toContainText('回答内容の整理（AI未使用）');
  await expect(page.getByLabel('あなたの回答')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '判断を保存' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: '面接が終了しました' })).toBeVisible();
  const record = await request.get(`${api}/invitations/${invitation.id}`, { headers: { Authorization: `Bearer ${company.token}` } });
  expect((await record.json()).report.items[0].evidence.length).toBeGreaterThan(0);
});

test('招待参加の改善: 全角コードと区切り文字から確認して対人面接へ入室できる', async ({ page, request }) => {
  voiceCompany ??= account(request);
  const company = await voiceCompany;
  const invitation = await invite(request, company.token, 'human');
  const fullWidth = Array.from(String(invitation.code).toLowerCase(), character => String.fromCharCode(character.charCodeAt(0) + 0xfee0)).join('');
  const entered = '\ufeff' + fullWidth.match(/.{1,4}/g)!.join('\u200b\u2011\u3000') + '\u2060';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/interviews/join');
  await page.getByLabel('招待コード', { exact: true }).fill(entered);
  await page.getByRole('button', { name: '面接を確認', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'エンジニア面接', exact: true })).toBeVisible();
  await expect(page.getByLabel('招待コード', { exact: true })).toHaveValue(invitation.code);
  await page.getByLabel('カメラを使用', { exact: true }).uncheck();
  await page.getByLabel('マイクを使用', { exact: true }).uncheck();
  await page.getByRole('button', { name: '機器を接続・確認' }).click();
  await page.getByLabel('お名前', { exact: true }).fill('別端末の応募者');
  await page.getByRole('checkbox', { name: '面接方式と記録の利用目的', exact: false }).check();
  const started = page.waitForRequest('**/api/hiring/join/start');
  await page.getByRole('button', { name: '準備完了・待機室へ' }).click();
  expect((await started).postDataJSON().code).toBe(invitation.code);
  await expect(page).toHaveURL(new RegExp(`/interviews/session\\?id=${invitation.id}`));
  await expect(page.getByText('企業の担当者による入室許可を待っています。この画面でお待ちください。')).toBeVisible();
  await expect(page.getByLabel('発言内容')).toBeDisabled();
  await post(request, `/invitations/${invitation.id}/admit`, {}, company.token);
  await expect(page.getByLabel('発言内容')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('招待参加の改善: 招待URL全体を貼り付けて面接を確認できる', async ({ page, request }) => {
  voiceCompany ??= account(request);
  const company = await voiceCompany;
  const invitation = await invite(request, company.token);
  await page.goto('/interviews/join');
  const url = new URL('/interviews/join', page.url());
  url.searchParams.set('code', invitation.code);
  await page.getByLabel('招待コード', { exact: true }).fill(url.toString());
  await page.getByRole('button', { name: '面接を確認', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'エンジニア面接', exact: true })).toBeVisible();
  await expect(page.getByLabel('招待コード', { exact: true })).toHaveValue(invitation.code);
  await expect(page.getByRole('button', { name: '準備完了・面接を開始' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
});

test('招待参加の改善: 確認中にコードを変更しても遅い応答が新しい確認結果を上書きしない', async ({ page, request }) => {
  voiceCompany ??= account(request);
  const company = await voiceCompany;
  const previous = await invite(request, company.token);
  const current = await invite(request, company.token, 'human');
  let releasePrevious!: () => void;
  const held = new Promise<void>(resolve => { releasePrevious = resolve; });
  let markIntercepted!: () => void;
  const intercepted = new Promise<void>(resolve => { markIntercepted = resolve; });
  await page.route('**/api/hiring/join/lookup', async route => {
    if (route.request().postDataJSON().code !== previous.code) { await route.continue(); return; }
    const response = await route.fetch();
    const payload = await response.json();
    markIntercepted();
    await held;
    await route.fulfill({ response, json: { ...payload, title: '古いコードの確認結果' } });
  });
  try {
    await page.goto('/interviews/join');
    await page.getByLabel('招待コード', { exact: true }).fill(previous.code);
    await page.getByRole('button', { name: '面接を確認', exact: true }).click();
    await intercepted;
    await expect(page.getByRole('button', { name: '確認中…', exact: true })).toBeDisabled();
    await page.getByLabel('招待コード', { exact: true }).fill(current.code);
    await expect(page.getByRole('heading', { name: 'エンジニア面接', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '面接を確認', exact: true }).click();
    await expect(page.getByRole('button', { name: '準備完了・待機室へ' })).toBeVisible();
    const delayedResponse = page.waitForResponse(response => response.url().endsWith('/join/lookup') && response.request().postDataJSON().code === previous.code);
    releasePrevious();
    await (await delayedResponse).finished();
    // Allow pending fetch handlers and their React render to commit.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('heading', { name: '古いコードの確認結果', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'エンジニア面接', exact: true })).toBeVisible();
    await expect(page.getByLabel('招待コード', { exact: true })).toHaveValue(current.code);
    await expect(page.getByRole('button', { name: '準備完了・待機室へ' })).toBeVisible();
    await expect(page.getByRole('button', { name: '準備完了・面接を開始' })).toHaveCount(0);
  } finally {
    releasePrevious();
  }
});

test('招待参加の改善: 保存が拒否されても画面は動作し、入室前に案内して招待を消費しない', async ({ page, request }) => {
  voiceCompany ??= account(request);
  const company = await voiceCompany;
  const invitation = await invite(request, company.token);
  const errors: string[] = [];
  const starts: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().endsWith('/api/hiring/join/start')) starts.push(request.url()); });
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === window.sessionStorage) throw new DOMException('Site storage is blocked', 'SecurityError');
      return original.call(this, key, value);
    };
  });
  await page.goto(`/interviews/join?code=${invitation.code}`);
  await expect(page.getByRole('heading', { name: 'エンジニア面接', exact: true })).toBeVisible();
  await page.getByLabel('カメラを使用', { exact: true }).uncheck();
  await page.getByLabel('マイクを使用', { exact: true }).uncheck();
  await page.getByRole('button', { name: '機器を接続・確認' }).click();
  await expect(page.getByText('確認済み', { exact: true })).toBeVisible();
  await page.getByLabel('お名前', { exact: true }).fill('保存制限のある応募者');
  await page.getByRole('checkbox', { name: '面接方式と記録の利用目的', exact: false }).check();
  await page.getByRole('button', { name: '準備完了・面接を開始' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('参加情報を保存できません');
  await expect(page).toHaveURL(new RegExp(`/interviews/join\\?code=${invitation.code}`));
  expect(starts).toEqual([]);
  expect(errors).toEqual([]);
  const state = await post(request, '/join/lookup', { code: invitation.code });
  expect(state.status).toBe('invited');
  // A subsequent browser can still use the invitation because no claim occurred.
  const claim = await post(request, '/join/start', { code: invitation.code, name: '応募者テスト', consent: true });
  expect(claim.session.invitation.id).toBe(invitation.id);
});

test('対人面接で心拍数とストレス推移を表示し、共有停止後に古い値を残さない', async ({ page, request }) => {
  const company = await account(request);
  const invitation = await invite(request, company.token, 'human');
  await post(request, '/join/start', { code: invitation.code, name: '応募者テスト', consent: true });
  const session = await post(request, `/invitations/${invitation.id}/admit`, {}, company.token);
  let socket: WebSocketRoute | undefined;
  let sharing = false;
  let frames = 0;
  const state = () => socket?.send(JSON.stringify({ type: 'state', session, peers: [
    { client_id: 'interviewer', role: 'interviewer', name: '面接官', vital_consent: sharing },
    { client_id: 'candidate', role: 'candidate', name: '応募者テスト', vital_consent: true },
  ] }));
  const sample = (role: string, bpm: number, stress: number) => socket?.send(JSON.stringify({
    type: 'vitals', client_id: role, role, name: role === 'candidate' ? '応募者テスト' : '面接官',
    vitals: { current_bpm: bpm, stress, hrv_rmssd: 42, confidence: 0.9, is_anomalous: false, measurement_valid: true, stress_valid: true },
  }));
  await page.routeWebSocket(`**/ws/hiring/${invitation.id}`, ws => {
    socket = ws;
    sharing = false;
    ws.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'join') state();
      if (message.type === 'vital_consent') {
        sharing = message.enabled;
        if (!sharing) ws.send(JSON.stringify({ type: 'vitals_clear', client_id: 'interviewer', role: 'interviewer' }));
        state();
      }
      if (message.type === 'frame') { expect(sharing).toBe(true); frames++; }
    });
  });
  await page.addInitScript(token => sessionStorage.setItem('hiring_employer_token', token), company.token);
  await page.goto(`/interviews/session?id=${invitation.id}&host=1`);
  const self = page.getByRole('region', { name: '自分のバイタル', exact: true });
  const other = page.getByRole('region', { name: '相手のバイタル', exact: true });
  const consent = page.getByRole('checkbox', { name: '心拍・ストレスの計測と相手への共有に同意する', exact: true });
  await expect(self).toBeVisible();
  await expect(consent).not.toBeChecked();
  expect(frames).toBe(0);
  await expect.poll(() => page.locator('video').evaluateAll(videos => videos.some(video => ((video as HTMLVideoElement).srcObject as MediaStream | null)?.getVideoTracks().some(track => track.readyState === 'live')))).toBe(true);
  await consent.check();
  await expect.poll(() => frames).toBeGreaterThan(0);
  sample('interviewer', 72, 24); sample('candidate', 83, 45);
  await expect(self.getByLabel('心拍数', { exact: true })).toContainText('72');
  await expect(other.getByLabel('心拍数', { exact: true })).toContainText('83');
  await expect(self.getByRole('meter', { name: 'ストレス', exact: true })).toHaveAttribute('aria-valuenow', '24');
  const chart = self.getByRole('img', { name: 'ストレス推移', exact: true }).locator('path');
  await expect(chart).toHaveAttribute('d', /M/);
  const previous = await chart.getAttribute('d');
  sample('interviewer', 90, 65);
  await expect(chart).not.toHaveAttribute('d', previous!);
  await expect(page.getByRole('img', { name: '参加者のストレス推移', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/human-interview-vitals.png', fullPage: true });
  await consent.uncheck();
  await expect.poll(() => sharing).toBe(false);
  sample('interviewer', 120, 90); // A delayed packet must not revive withdrawn measurements.
  await expect(self.getByLabel('心拍数', { exact: true })).toContainText('--');
  await expect(self.getByRole('meter', { name: 'ストレス', exact: true })).not.toHaveAttribute('aria-valuenow');
  await expect(other.getByLabel('心拍数', { exact: true })).toContainText('83');
  await consent.check();
  await expect.poll(() => sharing).toBe(true);
  sample('interviewer', 76, 25);
  await expect(self.getByLabel('心拍数', { exact: true })).toContainText('76');
  await page.locator('video').evaluateAll(videos => videos.forEach(video => {
    ((video as HTMLVideoElement).srcObject as MediaStream | null)?.getVideoTracks().forEach(track => track.stop());
  }));
  await expect(consent).not.toBeChecked();
  await expect.poll(() => sharing).toBe(false);
  await expect(self.getByLabel('心拍数', { exact: true })).toContainText('--');
  socket?.close();
  await expect(other.getByLabel('心拍数', { exact: true })).toContainText('--');
});

test('対人面接はコードで待機し、企業の許可後に通話と記録を開始して終了する', async ({ request, browser, page }) => {
  const company = await account(request);
  const invitation = await invite(request, company.token, 'human');
  await employerPage(page, company.token);
  await page.getByRole('link', { name: '面接ルームへ' }).click();
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const candidate = await context.newPage();
  try {
    await candidate.addInitScript(() => {
      window.hiringRecognizers = [];
      class Recognition {
        onstart?: () => void; onend?: () => void;
        onresult?: (event: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void;
        start() { window.hiringRecognizers.push(this); this.onstart?.(); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      }
      Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    });
    await candidate.goto('/interviews/join');
    await candidate.getByLabel('招待コード', { exact: true }).fill(invitation.code);
    await candidate.getByRole('button', { name: '面接を確認', exact: true }).click();
    await candidate.getByRole('button', { name: '機器を接続・確認' }).click();
    await expect(candidate.getByText('確認済み', { exact: true })).toBeVisible();
    await candidate.getByLabel('お名前', { exact: true }).fill('応募者テスト');
    await candidate.getByRole('checkbox', { name: '面接方式と記録の利用目的', exact: false }).check();
    await candidate.getByRole('button', { name: '準備完了・待機室へ' }).click();
    await expect(candidate.getByText('企業の担当者による入室許可を待っています。この画面でお待ちください。')).toBeVisible();
    await expect(candidate.getByLabel('発言内容')).toBeDisabled();
    await page.getByRole('button', { name: '応募者の入室を許可' }).click();
    await expect(candidate.getByText('通話接続済み', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('通話接続済み', { exact: true })).toBeVisible({ timeout: 30000 });
    await candidate.getByRole('button', { name: '文字起こしを開始', exact: true }).click();
    await expect.poll(() => candidate.evaluate(() => window.hiringRecognizers.length)).toBe(1);
    await candidate.evaluate(() => window.hiringRecognizers[0].onresult?.({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: '自動で記録する発言です。' } }] }));
    await expect(candidate.getByTestId('human-transcription-interim')).toContainText('自動で記録する発言です。');
    await candidate.evaluate(() => window.hiringRecognizers[0].onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '自動で記録する発言です。' } }] }));
    await expect(page.getByText('自動で記録する発言です。', { exact: true })).toBeVisible();
    await expect(candidate.getByTestId('human-transcript-queue')).toContainText('未保存データはありません');
    await candidate.getByRole('button', { name: '文字起こしを停止', exact: true }).click();
    await candidate.getByLabel('発言内容').fill('チームで開発した経験を説明します。');
    await candidate.getByRole('button', { name: '発言を保存', exact: true }).click();
    await expect(page.getByText('チームで開発した経験を説明します。', { exact: true })).toBeVisible();
    await candidate.reload();
    await expect(candidate.getByText('通話接続済み', { exact: true })).toBeVisible({ timeout: 30000 });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '面接を終了', exact: true }).click();
    await expect(candidate.getByRole('heading', { name: '面接が終了しました' })).toBeVisible();
    await expect(candidate.getByRole('region', { name: '心拍・ストレスの振り返り' })).toContainText('保存された計測値はありません');
    await expect(candidate.getByLabel('発言内容')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const held of ['video', 'audio'] as const) {
  test(`機器の${held}権限が保留中でも、オフや画面移動後にカメラを動かさない`, async ({ page, request }) => {
    const company = await account(request);
    const invitation = await invite(request, company.token);
    await page.addInitScript(kind => {
      window.hiringTestTracks = [];
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await original(constraints);
        window.hiringTestTracks.push(...stream.getTracks());
        if (constraints?.[kind]) await new Promise<void>(resolve => { window.releaseHiringPermission = resolve; });
        return stream;
      };
    }, held);
    await page.goto(`/interviews/join?code=${invitation.code}`);
    await page.getByRole('button', { name: '機器を接続・確認' }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.releaseHiringPermission))).toBeTruthy();
    if (held === 'video') {
      await page.getByLabel('カメラを使用', { exact: true }).uncheck();
      await page.evaluate(() => window.releaseHiringPermission?.());
      await expect.poll(() => page.evaluate(() => window.hiringTestTracks.filter(t => t.kind === 'video').every(t => t.readyState === 'ended'))).toBeTruthy();
    } else {
      await expect.poll(() => page.evaluate(() => window.hiringTestTracks.some(t => t.kind === 'video' && t.readyState === 'live'))).toBeTruthy();
      await page.getByRole('link', { name: '企業の方はこちら' }).click();
      await expect.poll(() => page.evaluate(() => window.hiringTestTracks.filter(t => t.kind === 'video').every(t => t.readyState === 'ended'))).toBeTruthy();
      await page.evaluate(() => window.releaseHiringPermission?.());
      await expect.poll(() => page.evaluate(() => window.hiringTestTracks.every(t => t.readyState === 'ended'))).toBeTruthy();
    }
  });
}
