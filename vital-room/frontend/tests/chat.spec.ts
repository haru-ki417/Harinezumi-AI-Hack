import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function mockInterview(page: Page) {
  await page.routeWebSocket('ws://localhost:8000/ws/room/**', (ws) => {
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).type === 'join') {
        ws.send(JSON.stringify({ type: 'joined', client_id: 'vital-self' }));
      }
    });
  });
}

async function turnCameraOff(page: Page) {
  const camera = page.getByRole('button', { name: 'カメラ', exact: true });
  if (await camera.getAttribute('aria-pressed') === 'true') await camera.click();
}

test('面接の入室完了までチャットを接続せず、退出すると閉じて次の入室完了を待つ', async ({ page }) => {
  const errors: string[] = [];
  const pendingJoins: WebSocketRoute[] = [];
  let chatConnections = 0;
  let chatClosures = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('websocket', (socket) => {
    if (!new URL(socket.url()).pathname.startsWith('/ws/chat/')) return;
    chatConnections++;
    socket.on('close', () => { chatClosures++; });
  });
  await page.routeWebSocket('ws://localhost:8000/ws/room/**', (ws) => {
    ws.onMessage((data) => {
      if (JSON.parse(String(data)).type === 'join') pendingJoins.push(ws);
    });
  });
  await page.goto('/');
  const toggle = page.getByRole('button', { name: 'チャット', exact: true });
  await expect(toggle).toHaveCount(0);
  const code = page.getByLabel('ルームコード（相手と同じ値にする）');
  await expect(code).toHaveValue(/^[A-Z0-9]{6}$/);
  const current = await code.inputValue();
  await expect(page.getByRole('banner', { name: 'ルーム操作' }).getByText(`ルーム ${current}`, { exact: true })).toBeVisible();
  await page.getByLabel('表示名').fill('初期表示確認');
  await page.getByRole('checkbox').check();
  await expect(toggle).toHaveCount(0);
  expect(chatConnections).toBe(0);
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await expect(page.getByRole('heading', { name: 'カメラ・音声・背景の設定' })).toBeVisible();
  await expect(toggle).toHaveCount(0);
  expect(chatConnections).toBe(0);
  await turnCameraOff(page);
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect.poll(() => pendingJoins.length).toBe(1);
  // WebSocketが開いても、入室応答を受け取るまでは利用できない。
  await page.waitForTimeout(500);
  await expect(toggle).toHaveCount(0);
  expect(chatConnections).toBe(0);
  pendingJoins[0].send(JSON.stringify({ type: 'joined', client_id: 'vital-self' }));
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByText('接続済み · 面接中の参加者と送受信できます')).toBeVisible();
  expect(chatConnections).toBe(1);

  await page.getByRole('button', { name: 'チャットを閉じる' }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(code).toBeVisible();
  await expect(toggle).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'メッセージ', exact: true })).toHaveCount(0);
  await expect.poll(() => chatClosures).toBe(1);
  await page.waitForTimeout(1200);
  expect(chatConnections).toBe(1);
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await expect(toggle).toHaveCount(0);
  expect(chatConnections).toBe(1);
  await turnCameraOff(page);
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect.poll(() => pendingJoins.length).toBe(2);
  await page.waitForTimeout(500);
  await expect(toggle).toHaveCount(0);
  expect(chatConnections).toBe(1);
  pendingJoins[1].send(JSON.stringify({ type: 'joined', client_id: 'vital-self-again' }));
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.getByText('接続済み · 面接中の参加者と送受信できます')).toBeVisible();
  expect(chatConnections).toBe(2);
  expect(errors).toEqual([]);
});

test('上部バーがルーム情報や設定スクロールに重ならず、画面間で位置を維持する', async ({ page }) => {
  await mockInterview(page);
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'チャット', exact: true });
    await expect(toggle).toHaveCount(0);
    const toolbar = page.getByRole('banner', { name: 'ルーム操作' });
    const initial = await toolbar.boundingBox();
    expect(initial).not.toBeNull();
    await page.getByLabel('表示名').fill('レイアウト確認');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
    const settings = page.getByRole('region', { name: '設定項目', exact: true });
    const bar = await toolbar.boundingBox();
    const bounds = await settings.boundingBox();
    expect(bounds!.y).toBeGreaterThan(bar!.y + bar!.height);
    await settings.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await toolbar.boundingBox()).toEqual(initial);
    await expect(toggle).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath(`settings-toolbar-${width}.png`) });
    await turnCameraOff(page);
    await page.getByRole('button', { name: '面接に接続', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
    await expect(toggle).toBeVisible();
    expect(await toolbar.boundingBox()).toEqual(initial);
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
  await mockInterview(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'チャット', exact: true })).toHaveCount(0);
  await page.getByLabel('表示名').fill(name);
  await page.getByLabel('ルームコード（相手と同じ値にする）').fill(room);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  await expect(page.getByRole('button', { name: 'チャット', exact: true })).toHaveCount(0);
  await turnCameraOff(page);
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await page.getByRole('button', { name: 'チャット', exact: true }).click();
  await expect(page.getByText('接続済み · 面接中の参加者と送受信できます')).toBeVisible();
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'メッセージ', exact: true }).fill(text);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'メッセージ', exact: true })).toHaveValue('');
}

test('実バックエンドで面接中の双方向チャットと下書きを保持し、別ルームと分離する', async ({ page, context }) => {
  const second = await context.newPage();
  const separate = await context.newPage();
  const code = `CHAT-${Date.now()}`;
  await setup(page, '面接官', code);
  await setup(second, '応募者', code);
  await setup(separate, '別室', `${code}-OTHER`);
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
  await expect(page.getByRole('button', { name: '退出', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'チャット', exact: true }).click();
  await expect(input).toHaveValue('面接中に送る下書き');
  await expect(page.getByRole('log').getByText(greeting, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(second.getByRole('log').getByText('面接中に送る下書き', { exact: true })).toBeVisible();
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
  await expect(page.getByText('接続済み · 面接中の参加者と送受信できます')).toBeVisible();
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'チャットを閉じる' }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(page.getByRole('button', { name: 'チャット', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'メッセージ', exact: true })).toHaveCount(0);
});

const pdfAttachment = {
  name: '面接資料.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'),
};
const photoAttachment = {
  name: 'プロフィール写真.png',
  mimeType: 'image/png',
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'),
};

async function expectAttachmentDownload(page: Page, file: typeof pdfAttachment) {
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('log').getByRole('button', { name: `${file.name}をダウンロード`, exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe(file.name);
  const savedPath = test.info().outputPath(file.name);
  await download.saveAs(savedPath);
  expect(await readFile(savedPath)).toEqual(file.buffer);
}

async function addTransferredFile(page: Page, event: 'paste' | 'drop', file: typeof pdfAttachment) {
  const target = event === 'paste'
    ? page.getByRole('textbox', { name: 'メッセージ', exact: true })
    : page.getByRole('form', { name: 'メッセージを作成', exact: true });
  await target.evaluate((element, payload) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload.bytes)], payload.name, { type: payload.mimeType }));
    const event = payload.event === 'paste'
      ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
  }, { event, name: file.name, mimeType: file.mimeType, bytes: Array.from(file.buffer) });
}

test('PDFと写真を同じルームで共有し、途中参加者も表示・ダウンロードできる', async ({ page, context }) => {
  test.setTimeout(90000);
  const receiver = await context.newPage();
  const separate = await context.newPage();
  const room = `FILES-${Date.now()}`;
  await setup(page, '資料を送る人', room);
  await setup(receiver, '資料を受け取る人', room);
  await setup(separate, '別のルーム', `${room}-OTHER`);

  await page.getByLabel('添付ファイルを選択', { exact: true }).setInputFiles([pdfAttachment, photoAttachment]);
  const pending = page.getByLabel('送信する添付ファイル', { exact: true });
  await expect(pending.getByText(pdfAttachment.name)).toBeVisible();
  await expect(pending.getByText(photoAttachment.name)).toBeVisible();
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(pending).toHaveCount(0);

  const photo = receiver.getByRole('log').getByRole('img', { name: photoAttachment.name, exact: true });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expectAttachmentDownload(receiver, pdfAttachment);
  await expectAttachmentDownload(receiver, photoAttachment);
  await expect(separate.getByRole('log').getByRole('button', { name: `${pdfAttachment.name}をダウンロード`, exact: true })).toHaveCount(0);
  await expect(separate.getByRole('log').getByRole('img')).toHaveCount(0);

  const late = await context.newPage();
  await setup(late, '途中参加', room);
  await expect(late.getByRole('log').getByRole('img', { name: photoAttachment.name, exact: true })).toBeVisible();
  await expectAttachmentDownload(late, pdfAttachment);

  const replyFile = { ...pdfAttachment, name: '返信資料.pdf' };
  await receiver.getByLabel('添付ファイルを選択', { exact: true }).setInputFiles(replyFile);
  await send(receiver, '確認した資料を返します');
  await expect(page.getByRole('log').getByText('確認した資料を返します', { exact: true })).toBeVisible();
  await expectAttachmentDownload(page, replyFile);
});

test('写真の貼り付けとファイルのドロップに対応し、送信前に取り消せる', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, '添付操作', `PASTE-${Date.now()}`);
  await addTransferredFile(page, 'paste', photoAttachment);
  await addTransferredFile(page, 'drop', pdfAttachment);
  const pending = page.getByLabel('送信する添付ファイル', { exact: true });
  await expect(pending.getByText(photoAttachment.name)).toBeVisible();
  await expect(pending.getByText(pdfAttachment.name)).toBeVisible();
  await page.getByRole('button', { name: `${pdfAttachment.name}を取り消す`, exact: true }).click();
  await expect(pending.getByText(pdfAttachment.name)).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('chat-attachment-mobile.png') });
  await expect(page.getByRole('button', { name: '送信', exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(page.getByRole('log').getByRole('img', { name: photoAttachment.name, exact: true })).toBeVisible();
  await expect(page.getByRole('log').getByRole('button', { name: `${pdfAttachment.name}をダウンロード`, exact: true })).toHaveCount(0);
  await expectAttachmentDownload(page, photoAttachment);
});

test('添付のサイズと件数を制限し、アップロード失敗後も下書きを保持して再送できる', async ({ page }) => {
  await setup(page, '再送確認', `RETRY-FILE-${Date.now()}`);
  await page.getByLabel('添付ファイルを選択', { exact: true }).setInputFiles(pdfAttachment);
  const input = page.getByRole('textbox', { name: 'メッセージ', exact: true });
  const pending = page.getByLabel('送信する添付ファイル', { exact: true });
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(10 * 1024 * 1024 + 1)], '大きすぎる.pdf', { type: 'application/pdf' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('alert').filter({ hasText: /10\s*(?:MB|MiB)/ })).toBeVisible();
  await expect(pending.getByText('大きすぎる.pdf')).toHaveCount(0);
  await input.evaluate((element) => {
    const transfer = new DataTransfer();
    for (let i = 0; i < 6; i++) transfer.items.add(new File(['%PDF-1.4'], `追加${i}.pdf`, { type: 'application/pdf' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByRole('alert').filter({ hasText: /5/ })).toBeVisible();
  await expect(pending.getByText(pdfAttachment.name)).toBeVisible();
  await expect(pending.getByRole('button')).toHaveCount(1);

  let failUpload = true;
  await page.route(/\/api\/chat\/[^/]+\/attachments(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'POST' && failUpload) {
      failUpload = false;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '一時的にアップロードできません。もう一度お試しください。' }) });
    } else {
      await route.continue();
    }
  });
  await input.fill('添付を含む下書き');
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect.poll(() => failUpload).toBe(false);
  await expect(page.getByRole('alert').filter({ hasText: 'ファイルを送信できませんでした。接続を確認して再送してください。' })).toBeVisible();
  await expect(input).toHaveValue('添付を含む下書き');
  await expect(pending.getByText(pdfAttachment.name)).toBeVisible();
  await expect(page.getByRole('log').getByRole('button', { name: `${pdfAttachment.name}をダウンロード`, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '送信', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(pending).toHaveCount(0);
  await expect(page.getByRole('log').getByText('添付を含む下書き', { exact: true })).toHaveCount(1);
  await expectAttachmentDownload(page, pdfAttachment);
});
