import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // These are run as plain Node programs, not as test files.
  testIgnore: ['**/auto-demo.ts', '**/verify-real-speech.ts', '**/check-tunnel.ts', '**/measure-call.ts'],
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // Annotations can be read without a token, unlike the raw job log.
  reporter: process.env.GITHUB_ACTIONS ? [['list'], ['github']] : 'list',
  outputDir: '.tmp/browser-results',
  globalSetup: './scripts/dev.mjs',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
    trace: 'retain-on-failure',
  },
});
