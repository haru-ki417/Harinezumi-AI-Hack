import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import chatConfig from './playwright.chat.config';

const database = path.join(mkdtempSync(path.join(tmpdir(), 'vital-hiring-e2e-')), 'interviews.sqlite3');

export default defineConfig({
  ...chatConfig,
  timeout: 90000,
  testMatch: '**/hiring*.spec.ts',
  webServer: (Array.isArray(chatConfig.webServer) ? chatConfig.webServer : []).map((server) => ({
    ...server,
    env: {
      ...server.env, OPENAI_API_KEY: '', HIRING_DB_PATH: database,
      NEXT_PUBLIC_API_URL: '', BACKEND_INTERNAL_URL: 'http://127.0.0.1:8100',
      HIRING_PUBLIC_URL: '', HIRING_SHARING_URL_FILE: '',
    },
  })),
});
