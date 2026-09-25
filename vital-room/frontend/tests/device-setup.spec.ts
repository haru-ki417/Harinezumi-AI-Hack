import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    testTracks: MediaStreamTrack[];
    releaseCamera?: () => void;
  }
}

async function trackDevices(page: Page, delayed = false) {
  await page.addInitScript((delay) => {
    window.testTracks = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      window.testTracks.push(...stream.getTracks());
      // Only hold the camera permission request; the microphone starts independently.
      if (delay && constraints?.video) await new Promise<void>((resolve) => { window.releaseCamera = resolve; });
      return stream;
    };
  }, delayed);
}

async function enterSetup(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '同意して機器の設定へ' })).toBeDisabled();
  await page.getByLabel('表示名').fill('テスト参加者');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await expect(page.getByRole('heading', { name: 'カメラ・音声・背景の設定' })).toBeVisible();
}

async function mockRoom(page: Page) {
  const messages: { type: string; image_base64?: string }[] = [];
  const sockets: string[] = [];
  await page.routeWebSocket('ws://localhost:8000/ws/room/**', (ws) => {
    sockets.push(ws.url());
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      messages.push(message);
      if (message.type === 'join') ws.send(JSON.stringify({ type: 'joined', client_id: 'test-self' }));
      if (message.type === 'join' || message.type === 'frame') ws.send(JSON.stringify({
        type: 'room', topic: '', participants: [{
          client_id: 'test-self', role: 'candidate', name: 'テスト参加者',
          vitals: { current_bpm: 72, stress: 24, is_anomalous: false },
        }],
      }));
    });
  });
  return { messages, sockets };
}

test('設定が済むまで接続せず、参加後に映像を送信し、退出で機器を停止する', async ({ page }) => {
  await page.route('**/api/reports/analyze', (route) => route.fulfill({ json: {
    source: 'local', reason: 'not_configured',
    summary: '質問ごとの集計結果を表示しています。', observations: [],
  } }));
  await trackDevices(page);
  const room = await mockRoom(page);
  await enterSetup(page);
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  expect(room.sockets).toHaveLength(0);
  await page.getByLabel('明るさ').fill('115');
  await page.getByLabel('左右を反転して表示').uncheck();
  await expect(page.getByRole('button', { name: 'マイク', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.testTracks.some((t) => t.kind === 'audio' && t.readyState === 'live'))).toBe(true);
  await page.getByRole('button', { name: 'スピーカーをテスト' }).click();
  await expect(page.getByRole('button', { name: 'スピーカーをテスト' })).toBeEnabled();
  await expect(page.getByText('テスト音を再生できません。', { exact: false })).toHaveCount(0);
  expect(room.sockets).toHaveLength(0);
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
  await expect.poll(() => room.messages.filter((m) => m.type === 'frame').length).toBeGreaterThan(0);
  await expect(page.locator('video:visible')).toHaveCSS('filter', 'brightness(1.15)');
  await expect(page.locator('video:visible')).toHaveCSS('transform', 'none');
  await expect.poll(() => page.evaluate(() => window.testTracks.some((t) => t.kind === 'audio' && t.readyState === 'ended'))).toBe(true);
  await expect.poll(() => page.evaluate(() => window.testTracks.some((t) => t.kind === 'audio' && t.readyState === 'live'))).toBe(true);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '面接レポート' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.testTracks.every((t) => t.readyState === 'ended'))).toBe(true);
});

test('戻ると入力を保持してカメラを停止し、再びプレビューを開ける', async ({ page }) => {
  await trackDevices(page);
  const room = await mockRoom(page);
  await enterSetup(page);
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'カメラ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'カメラ', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'カメラ', exact: true })).toHaveText('カメラ オフ');
  await expect.poll(() => page.evaluate(() => {
    const videoTracks = window.testTracks.filter((track) => track.kind === 'video');
    return videoTracks.length > 0 && videoTracks.every((track) => track.readyState === 'ended');
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => window.testTracks.some((track) => track.kind === 'audio' && track.readyState === 'live'))).toBe(true);
  await page.getByRole('button', { name: 'カメラ', exact: true }).click();
  await expect(page.getByRole('button', { name: 'カメラ', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '前の画面に戻る' }).click();
  await expect(page.getByLabel('表示名')).toHaveValue('テスト参加者');
  await expect(page.getByRole('checkbox')).toBeChecked();
  await expect.poll(() => page.evaluate(() => window.testTracks.every((t) => t.readyState === 'ended'))).toBe(true);
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  expect(room.sockets).toHaveLength(0);
});

test('権限拒否を表示し、カメラオフを選ぶと画像を送信せず参加できる', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); };
  });
  const room = await mockRoom(page);
  await enterSetup(page);
  const cameraError = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'カメラを再試行' }) });
  await expect(cameraError).toBeVisible();
  await expect(cameraError).toContainText('アクセスが許可されていません');
  await expect(page.getByRole('group', { name: '音声の確認' }).getByRole('alert')).toContainText('アクセスが許可されていません');
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeDisabled();
  expect(room.sockets).toHaveLength(0);
  await page.getByRole('button', { name: 'カメラ', exact: true }).click();
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect(page.getByText('カメラがオフのため、バイタルの計測は停止しています。')).toBeVisible();
  await expect.poll(() => room.messages.some((m) => m.type === 'join')).toBe(true);
  expect(room.messages.filter((m) => m.type === 'frame')).toHaveLength(0);
});

test('許可待ちの途中で戻っても、遅れて取得したカメラを停止する', async ({ page }) => {
  await trackDevices(page, true);
  await enterSetup(page);
  await expect.poll(() => page.evaluate(() => !!window.releaseCamera)).toBe(true);
  await page.getByRole('button', { name: '前の画面に戻る' }).click();
  await page.evaluate(() => window.releaseCamera?.());
  await expect.poll(() => page.evaluate(() => window.testTracks.every((t) => t.readyState === 'ended'))).toBe(true);
});

test('選択したカメラ・マイクに切り替え、前の機器とオフにしたマイクを停止する', async ({ page }) => {
  await trackDevices(page);
  await enterSetup(page);
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  const cameraSelect = page.getByRole('combobox', { name: '使用するカメラ', exact: true });
  const cameraId = await cameraSelect.locator('option').nth(1).getAttribute('value');
  await cameraSelect.selectOption(cameraId!);
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate((id) => {
    const tracks = window.testTracks.filter((t) => t.kind === 'video');
    return tracks.length > 1 && tracks[0].readyState === 'ended'
      && tracks.some((t) => t.readyState === 'live' && t.getSettings().deviceId === id);
  }, cameraId)).toBe(true);
  await expect(page.getByRole('button', { name: 'マイク', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.testTracks.some((t) => t.kind === 'audio' && t.readyState === 'live'))).toBe(true);
  const previousAudioTrackCount = await page.evaluate(() => window.testTracks.filter((track) => track.kind === 'audio').length);
  const micSelect = page.getByRole('combobox', { name: 'マイク', exact: true });
  const micId = await micSelect.locator('option').last().getAttribute('value');
  await micSelect.selectOption(micId!);
  await expect.poll(() => page.evaluate(({ id, previousCount }) => {
    const tracks = window.testTracks.filter((track) => track.kind === 'audio');
    return tracks.length > previousCount
      && tracks.slice(0, previousCount).every((track) => track.readyState === 'ended')
      && tracks.some((track) => track.readyState === 'live' && track.getSettings().deviceId === id);
  }, { id: micId, previousCount: previousAudioTrackCount })).toBe(true);
  await page.getByRole('button', { name: 'マイク', exact: true }).click();
  await expect(page.getByRole('button', { name: 'マイク', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'マイク', exact: true })).toHaveText('マイク オフ');
  await expect.poll(() => page.evaluate(() => window.testTracks.filter((t) => t.kind === 'audio').every((t) => t.readyState === 'ended'))).toBe(true);
});

test('マイクの権限拒否はカメラのプレビューと参加を妨げない', async ({ page }) => {
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.audio) throw new DOMException('Denied', 'NotAllowedError');
      return getUserMedia(constraints);
    };
  });
  await enterSetup(page);
  await expect(page.getByRole('button', { name: 'マイク', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: '音声の確認' }).getByRole('alert')).toContainText('アクセスが許可されていません');
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  await expect(page.locator('video:visible')).toBeVisible();
});

test('背景モデルの読み込み失敗を表示し、加工なしに戻せる', async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/**', (route) => route.abort());
  const room = await mockRoom(page);
  await enterSetup(page);
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: '背景', exact: true }).selectOption('blur');
  await expect(page.getByText('プレビューを表示できません。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeDisabled();
  expect(room.sockets).toHaveLength(0);
  await page.getByRole('combobox', { name: '背景', exact: true }).selectOption('none');
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
});

test('PC・スマートフォンでプレビューと切り替えボタンを固定して設定だけスクロールできる', async ({ page }) => {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await enterSetup(page);
    await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
    const preview = page.getByLabel('カメラプレビュー', { exact: true });
    const camera = page.getByRole('button', { name: 'カメラ', exact: true });
    const mic = page.getByRole('button', { name: 'マイク', exact: true });
    const back = page.getByRole('button', { name: '前の画面に戻る' });
    const join = page.getByRole('button', { name: '面接に接続', exact: true });
    const before = await Promise.all([preview.boundingBox(), camera.boundingBox(), mic.boundingBox(), back.boundingBox(), join.boundingBox()]);
    await expect(back).toBeInViewport();
    await expect(join).toBeInViewport();
    expect(before[3]!.y).toBeGreaterThanOrEqual(before[1]!.y + before[1]!.height);
    expect(before[4]!.y).toBeGreaterThanOrEqual(before[2]!.y + before[2]!.height);
    const settings = page.getByRole('region', { name: '設定項目', exact: true });
    await settings.hover();
    await page.mouse.wheel(0, 2000);
    await expect.poll(() => settings.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '前の画面に戻る' })).toBeInViewport();
    await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeInViewport();
    expect(await Promise.all([preview.boundingBox(), camera.boundingBox(), mic.boundingBox(), back.boundingBox(), join.boundingBox()])).toEqual(before);
    await expect(camera).toBeInViewport();
    await expect(mic).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && window.scrollY === 0)).toBe(true);
  }
});

test('実モデルで背景色・ぼかしを描画し、設定を面接画面に引き継ぐ', async ({ page }) => {
  test.skip(!process.env.TEST_BACKGROUND, '外部モデルを使うテストは TEST_BACKGROUND=1 で実行');
  test.setTimeout(120000);
  await mockRoom(page);
  await enterSetup(page);
  await expect(page.getByRole('button', { name: '面接に接続', exact: true })).toBeEnabled();
  await page.getByRole('combobox', { name: '背景', exact: true }).selectOption('slate');
  const processed = page.getByLabel('背景加工済みのカメラ映像');
  await expect(processed).toBeVisible({ timeout: 60000 });
  // 仮想カメラのテストパターンには人物がいないので背景色に置き換わる。
  await expect.poll(() => processed.evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    return Array.from(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data);
  })).toEqual([51, 65, 85, 255]);
  await page.getByRole('combobox', { name: '背景', exact: true }).selectOption('blur');
  await expect(processed).toBeVisible({ timeout: 60000 });
  await page.screenshot({ path: test.info().outputPath('setup-preview.png'), fullPage: true });
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
  await expect(page.getByLabel('背景加工済みのカメラ映像')).toBeVisible({ timeout: 60000 });
});
