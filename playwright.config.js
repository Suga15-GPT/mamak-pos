const fs = require('fs');
const { defineConfig } = require('@playwright/test');

const PORT = process.env.E2E_PORT || 3100;
const BASE_URL = `http://localhost:${PORT}`;
const DATABASE_URL = process.env.E2E_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/mamak_e2e';

// Some sandboxed dev environments pre-install a Chromium build outside
// Playwright's own managed cache, at this fixed path, instead of letting
// `npx playwright install` fetch one. Use it when present; otherwise fall
// back to Playwright's normal browser resolution.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium';
const launchOptions = fs.existsSync(SANDBOX_CHROMIUM) ? { executablePath: SANDBOX_CHROMIUM } : {};

module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    launchOptions,
  },
  webServer: {
    command: 'node test/e2e/reset-db.js && node src/server.js',
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      DATABASE_URL,
      ADMIN_PIN: '1234',
      BASE_URL,
      PORT: String(PORT),
    },
  },
});
