import { defineConfig } from '@playwright/test';
import chatConfig from './playwright.chat.config';

export default defineConfig({
  ...chatConfig,
  testMatch: '**/report.spec.ts',
  webServer: (Array.isArray(chatConfig.webServer) ? chatConfig.webServer : []).map((server) => ({
    ...server,
    env: { ...server.env, OPENAI_API_KEY: '' },
  })),
});
