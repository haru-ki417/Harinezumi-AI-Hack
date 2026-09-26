// Read-only smoke check through the actual public HTTPS tunnel.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const origin = readFileSync(new URL('../../.sharing/url.txt', import.meta.url), 'utf8').trim();
if (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin)) throw new Error('Unexpected sharing URL');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const localRequests = [];
  const failures = [];
  const assets = new Set();
  page.on('response', response => {
    if (new URL(response.url()).pathname.startsWith('/_next/static/')) {
      assets.add(response.url());
      if (!response.ok() || (response.headers()['content-type'] || '').includes('text/html')) failures.push(response.url());
    }
  });
  page.on('requestfailed', request => { if (request.url().includes('/_next/static/')) failures.push(request.url()); });
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { if (/https?:\/\/(localhost|127\.0\.0\.1)/.test(request.url())) localRequests.push(request.url()); });
  await page.goto(`${origin}/interviews/join`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.getByLabel('招待コード', { exact: true }).waitFor();
  // Visible server-rendered HTML alone does not prove that the form is working.
  await page.getByLabel('招待コード', { exact: true }).fill('CHECK');
  await page.getByRole('button', { name: '面接を確認', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '招待コードを確認してください' }).waitFor();
  await page.getByLabel('招待コード', { exact: true }).fill('');
  const result = await page.evaluate(async () => {
    const health = await fetch('/api/health').then(response => response.json());
    const auth = await fetch('/api/hiring/auth/me');
    const socket = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Public WebSocket timed out')), 15000);
      const ws = new WebSocket(`${location.origin.replace('https:', 'wss:')}/ws/hiring/connection-check`);
      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', token: 'invalid-connection-check-token' }));
      ws.onmessage = event => { const message = JSON.parse(event.data); if (message.type === 'error') { clearTimeout(timeout); ws.close(); resolve(message.status); } };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('Public WebSocket failed')); };
    });
    const styled = getComputedStyle(document.querySelector('main')).backgroundImage.includes('radial-gradient');
    const fitsMobile = document.documentElement.scrollWidth <= window.innerWidth;
    return { secure: isSecureContext, health, authStatus: auth.status, socketAuthStatus: socket, styled, fitsMobile };
  });
  if (!result.secure || !result.styled || !result.fitsMobile || result.health.status !== 'ok' || result.authStatus !== 401 || ![401, 403].includes(result.socketAuthStatus) || localRequests.length || failures.length || assets.size < 2) throw new Error(JSON.stringify({ result, localRequests, failures, assets: assets.size }));
  console.log(JSON.stringify({ origin, ...result, localRequests: localRequests.length, assetCount: assets.size, interactiveForm: true }));
  await page.screenshot({ path: '../.sharing/mobile-join.png', fullPage: true });
  await page.setViewportSize({ width: 1365, height: 900 });
  await page.screenshot({ path: '../.sharing/desktop-join.png', fullPage: true });
} finally {
  await browser.close();
}
