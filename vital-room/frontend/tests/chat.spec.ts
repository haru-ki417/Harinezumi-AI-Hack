import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

test('初期表示で描画エラーを出さず、生成したルームコードを上部バーと共有する', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  const code = page.getByLabel('ルームコード（相手と同じ値にする）');
  await expect(code).toHaveValue(/^[A-Z0-9]{6}$/);
  const current = await code.inputValue();
  await expect(page.getByRole('banner', { name: 'ルーム操作' }).getByText(`ルーム ${current}`, { exact: true })).toBeVisible();
  await page.getByLabel('表示名').fill('初期表示確認');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await expect(page.getByRole('heading', { name: 'カメラ・音声・背景の設定' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('上部バーがルーム情報や設定スクロールに重ならず、画面間で位置を維持する', async ({ page }) => {
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'チャット', exact: true });
    const initial = await toggle.boundingBox();
    expect(initial).not.toBeNull();
    await page.getByLabel('表示名').fill('レイアウト確認');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
    const settings = page.getByRole('region', { name: '設定項目', exact: true });
    const toolbar = page.getByRole('banner', { name: 'ルーム操作' });
    const bar = await toolbar.boundingBox();
    const bounds = await settings.boundingBox();
    expect(bounds!.y).toBeGreaterThan(bar!.y + bar!.height);
    await settings.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await toggle.boundingBox()).toEqual(initial);
    await page.screenshot({ path: test.info().outputPath(`settings-toolbar-${width}.png`) });
    await page.getByRole('button', { name: 'カメラ', exact: true }).click();
    await page.getByRole('button', { name: '面接に接続', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
    expect(await toggle.boundingBox()).toEqual(initial);
    const elements = [toggle, toolbar.locator('[title^="ルーム "]'),
      page.getByRole('button', { name: 'レポート', exact: true }), page.getByRole('button', { name: '退出', exact: true })];
    const boxes = await Promise.all(elements.map((element) => element.boundingBox()));
    for (let i = 1; i < boxes.length; i++) {
      expect(boxes[i]!.x - (boxes[i - 1]!.x + boxes[i - 1]!.width)).toBeGreaterThanOrEqual(8);
    }
    await page.screenshot({ path: test.info().outputPath(`room-toolbar-${width}.png`) });
  }
});

async function setup(page: Page, name: string, room: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'チャット', exact: true }).click();
  await expect(page.getByText('表示名とルームコードを入力し、同意にチェックするとチャットを利用できます。')).toBeVisible();
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'チャットを閉じる' }).click();
  await page.getByLabel('表示名').fill(name);
  await page.getByLabel('ルームコード（相手と同じ値にする）').fill(room);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await page.getByRole('button', { name: 'チャット', exact: true }).click();
  await expect(page.getByText('接続済み · 面接前も送受信できます')).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'メッセージ', exact: true }).fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'メッセージ', exact: true })).toHaveValue('');
}

test('実バックエンドで面接前・面接中の双方向チャットを引き継ぎ、別ルームと分離する', async ({ page, context }) => {
  const second = await context.newPage();
  const separate = await context.newPage();
  const code = `CHAT-${Date.now()}`;
  let vitalConnections = 0;
  // バイタルはスタブにし、チャットのみ実サーバーへ接続する。
  for (const target of [page, second, separate]) {
    await target.routeWebSocket('ws://localhost:8000/ws/room/**', (ws) => {
      vitalConnections++;
      ws.onMessage((data) => {
        if (JSON.parse(String(data)).type === 'join') ws.send(JSON.stringify({ type: 'joined', client_id: 'vital-self' }));
      });
    });
  }
  await setup(page, '面接官', code);
  await setup(second, '応募者', code);
  await setup(separate, '別室', `${code}-OTHER`);
  expect(vitalConnections).toBe(0);
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
  const greeting = '準備できたら教えてください。';
  await send(page, greeting);
  await expect(second.getByRole('log').getByText(greeting, { exact: true })).toBeVisible();
  await expect(separate.getByRole('log').getByText(greeting, { exact: true })).toHaveCount(0);
  await send(second, '準備できました。');
  await expect(page.getByRole('log').getByText('準備できました。', { exact: true })).toBeVisible();

  // IME変換中のEnterでは送信しない。
  const input = page.getByRole('textbox', { name: 'メッセージ', exact: true });
  await input.fill('変換中');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(input).toHaveValue('変換中');
  await expect(second.getByRole('log').getByText('変換中', { exact: true })).toHaveCount(0);
  await input.fill('面接中に送る下書き');
  await page.getByRole('button', { name: 'チャットを閉じる' }).click();
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
  expect(vitalConnections).toBe(1);
  await page.getByRole('button', { name: 'チャット', exact: true }).click();
  await expect(input).toHaveValue('面接中に送る下書き');
  await expect(page.getByRole('log').getByText(greeting, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(second.getByRole('log').getByText('面接中に送る下書き', { exact: true })).toBeVisible();
  await second.getByRole('button', { name: 'チャットを閉じる' }).click();
  await second.getByRole('button', { name: '面接に接続', exact: true }).click();
  await second.getByRole('button', { name: 'チャット', exact: true }).click();
  await send(second, '<img src=x onerror=alert(1)>\n複数行のメッセージ');
  await expect(page.getByRole('log').getByText('<img src=x onerror=alert(1)>\n複数行のメッセージ', { exact: true })).toBeVisible();
  await expect(page.getByRole('log').locator('img')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('chat-during-interview.png'), fullPage: true });
});

test('未読・途中参加履歴・再接続・文字数制限・小画面表示を確認する', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const connection: { socket?: WebSocketRoute } = {};
  await page.routeWebSocket('ws://127.0.0.1:8100/ws/chat/**', (ws) => {
    connection.socket = ws;
    ws.connectToServer();
  });
  const code = `CHAT-${Date.now()}`;
  const second = await context.newPage();
  await setup(page, '先着', code);
  await send(page, '履歴に残すメッセージ');
  await setup(second, '後着', code);
  await expect(second.getByRole('log').getByText('履歴に残すメッセージ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'チャットを閉じる' }).click();
  await send(second, '新しいメッセージ');
  await expect(page.getByLabel('未読1件')).toBeVisible();
  await page.getByRole('button', { name: /チャット/ }).click();
  await expect(page.getByRole('log').getByText('新しいメッセージ', { exact: true })).toBeVisible();
  await expect(page.getByLabel('未読1件')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole('textbox', { name: 'メッセージ', exact: true })).toBeInViewport();
  const input = page.getByRole('textbox', { name: 'メッセージ', exact: true });
  await input.fill('x'.repeat(2001));
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeDisabled();
  await input.fill('再接続後に送る下書き');
  connection.socket?.close();
  await expect(page.getByRole('button', { name: '再接続', exact: true })).toBeVisible();
  await expect(input).toHaveValue('再接続後に送る下書き');
  await page.getByRole('button', { name: '再接続', exact: true }).click();
  await expect(page.getByText('接続済み · 面接前も送受信できます')).toBeVisible();
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'チャットを閉じる' }).click();
  await page.getByRole('button', { name: '前の画面に戻る' }).click();
  await expect(page.getByRole('button', { name: 'チャット', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'チャット', exact: true }).click();
  await send(page, '名前と同意の画面から送信');
  await expect(second.getByRole('log').getByText('名前と同意の画面から送信', { exact: true })).toBeVisible();
});
