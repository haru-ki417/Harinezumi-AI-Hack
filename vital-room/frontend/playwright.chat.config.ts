import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import base from './playwright.config';

const backend = path.resolve(__dirname, '../backend');
const venvPython = path.join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.BACKEND_PYTHON || (existsSync(venvPython) ? venvPython : 'python');

export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: '**/chat.spec.ts',
  webServer: [
    {
      command: `"${python}" -m uvicorn app:app --host 127.0.0.1 --port 8100`,
      cwd: backend,
      url: 'http://127.0.0.1:8100/health',
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'npm run dev -- --port 3100',
      url: 'http://localhost:3100',
      env: { NEXT_DIST_DIR: '.next-test', NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_WS_BASE_URL: 'ws://127.0.0.1:8100' },
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
