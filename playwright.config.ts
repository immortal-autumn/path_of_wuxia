import { defineConfig } from "@playwright/test";

const port = 3200;
const databasePath = process.env.PLAYWRIGHT_DATABASE_PATH ?? `/tmp/path-of-wuxia-playwright-${process.pid}.db`;
process.env.PLAYWRIGHT_DATABASE_PATH = databasePath;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run build && PORT=${port} GAME_HOST=127.0.0.1 DATABASE_PATH=${databasePath} npm start`,
    url: `http://127.0.0.1:${port}/favicon.ico`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
