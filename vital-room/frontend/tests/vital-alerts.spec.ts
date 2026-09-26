import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

type Sample = { current_bpm?: unknown; stress?: unknown; is_anomalous?: boolean };

async function openRoom(page: Page, cameraOff = false) {
  let socket: WebSocketRoute | undefined;
  let self: Sample = { current_bpm: 72, stress: 24 };
  let other: Sample = { current_bpm: 75, stress: 30 };
  const publish = () => socket?.send(JSON.stringify({
    type: 'room', topic: '', participants: [
      { client_id: 'self', name: '自分', role: 'candidate', vitals: { is_anomalous: false, ...self } },
      { client_id: 'other', name: '相手', role: 'interviewer', vitals: { is_anomalous: false, ...other } },
    ],
  }));
  await page.routeWebSocket('ws://localhost:8000/ws/room/**', (ws) => {
    socket = ws;
    ws.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type === 'join') {
        ws.send(JSON.stringify({ type: 'joined', client_id: 'self' }));
        publish();
      }
      if (message.type === 'frame') publish();
    });
  });
  await page.goto('/vital');
  await page.getByLabel('表示名').fill('自分');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '同意して機器の設定へ' }).click();
  if (cameraOff) await page.getByRole('button', { name: 'カメラ', exact: true }).click();
  await page.getByRole('button', { name: '面接に接続', exact: true }).click();
  await expect(page.getByRole('region', { name: '相手のバイタル' })).toBeVisible();
  return {
    update(selfSample: Sample, otherSample = other) {
      self = selfSample;
      other = otherSample;
      publish();
    },
    close() { socket?.close(); },
  };
}

test('ストレス・BPMの超過を個別に表示し、境界値と回復時には解除する', async ({ page }) => {
  const room = await openRoom(page);
  const self = page.getByRole('region', { name: '自分のバイタル' });
  const other = page.getByRole('region', { name: '相手のバイタル' });
  const preview = self.getByLabel('カメラプレビュー', { exact: true });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toHaveText('設定値を超えた項目はありません');

  room.update({ current_bpm: 72, stress: 70.1 });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toContainText('ストレスが設定値を超えています');
  await expect(preview).toHaveCSS('outline-color', 'rgb(236, 95, 95)');
  await expect(preview).toHaveCSS('outline-style', 'solid');
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toHaveCSS('background-color', 'rgba(236, 95, 95, 0.18)');
  await expect(self.getByRole('meter', { name: 'ストレス' }).locator('div')).toHaveCSS('background-color', 'rgb(239, 85, 85)');
  await expect(other.getByRole('status', { name: 'バイタル通知' })).toHaveText('設定値を超えた項目はありません');

  room.update({ current_bpm: 100, stress: 70 });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toHaveText('設定値を超えた項目はありません');
  await expect(preview).toHaveCSS('outline-style', 'none');

  room.update({ current_bpm: 100.1, stress: 24 });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toContainText('BPMが設定値を超えています');
  await expect(self.getByText('100.1', { exact: true })).toHaveCSS('color', 'rgb(255, 146, 146)');
  await expect(preview).toHaveCSS('outline-style', 'solid');

  room.update({ current_bpm: 110, stress: 80 }, { current_bpm: 105, stress: 40 });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toContainText('ストレス・BPMが設定値を超えています');
  await expect(other.getByRole('status', { name: 'バイタル通知' })).toContainText('BPMが設定値を超えています');
  await expect(other).toHaveCSS('border-top-color', 'rgb(236, 95, 95)');
  await page.screenshot({ path: test.info().outputPath('vital-alerts.png'), fullPage: true });

  room.update({ current_bpm: 80, stress: 30 }, { current_bpm: 85, stress: 40 });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toHaveText('設定値を超えた項目はありません');
  await expect(other.getByRole('status', { name: 'バイタル通知' })).toHaveText('設定値を超えた項目はありません');
  await expect(preview).toHaveCSS('outline-style', 'none');

  // 既存のベースライン変化の通知は、絶対値のアラートと混同しない。
  room.update({ current_bpm: 80, stress: 60, is_anomalous: true });
  await expect(self.getByText('変化あり')).toBeVisible();
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toHaveText('設定値を超えた項目はありません');
});

test('欠測・不正値・機器停止・接続切断では古い値によるアラートを表示しない', async ({ page }) => {
  const room = await openRoom(page);
  const self = page.getByRole('region', { name: '自分のバイタル' });
  const other = page.getByRole('region', { name: '相手のバイタル' });
  for (const sample of [
    { current_bpm: 0 },
    { current_bpm: null, stress: null },
    { current_bpm: '120', stress: '90' },
    { current_bpm: -1, stress: -1 },
    { current_bpm: 0, stress: 101 },
  ]) {
    room.update(sample);
    await expect(self.getByRole('status', { name: 'バイタル通知' })).toHaveText('計測データを待っています');
    await expect(self.getByLabel('カメラプレビュー', { exact: true })).toHaveCSS('outline-style', 'none');
  }
  room.update({ current_bpm: 110, stress: 80 }, { current_bpm: 110, stress: 80 });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toContainText('ストレス・BPMが設定値を超えています');
  await self.locator('video').evaluate((video) => {
    ((video as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0].dispatchEvent(new Event('ended'));
  });
  await expect(self.getByRole('status', { name: 'バイタル通知' })).toHaveText('計測停止中');
  await expect(self.getByLabel('カメラプレビュー', { exact: true })).toHaveCSS('outline-style', 'none');
  await expect(other.getByRole('status', { name: 'バイタル通知' })).toContainText('ストレス・BPMが設定値を超えています');
  room.close();
  await expect(other.getByRole('status', { name: 'バイタル通知' })).toHaveText('計測停止中');
  await expect(other).not.toHaveCSS('border-top-color', 'rgb(236, 95, 95)');
});

test('カメラオフで参加したときは自分のアラートを表示しない', async ({ page }) => {
  const room = await openRoom(page, true);
  room.update({ current_bpm: 110, stress: 80 }, { current_bpm: 72, stress: 80 });
  await expect(page.getByRole('region', { name: '自分のバイタル' }).getByRole('status', { name: 'バイタル通知' })).toHaveText('計測停止中');
  await expect(page.getByRole('region', { name: '相手のバイタル' }).getByRole('status', { name: 'バイタル通知' })).toContainText('ストレスが設定値を超えています');
});
