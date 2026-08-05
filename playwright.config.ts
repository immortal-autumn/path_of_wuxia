import { defineConfig } from "@playwright/test";

const port = 3200;
const databasePath = process.env.PLAYWRIGHT_DATABASE_PATH ?? `/tmp/path-of-wuxia-playwright-${process.pid}.db`;
process.env.PLAYWRIGHT_DATABASE_PATH = databasePath;
process.env.NPC_RUNNER_SECRET = "playwright-gameplay-secret";
process.env.NPC_TRADE_RUNNER_SECRET = "playwright-trade-secret";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run build && PORT=${port} GAME_HOST=127.0.0.1 PUBLIC_ORIGIN=http://127.0.0.1:${port} DATABASE_PATH=${databasePath} TRUST_PROXY=true EDITOR_ALLOW_ALL=true ANONYMOUS_ECONOMY=true NPC_RUNNER_SECRET=playwright-gameplay-secret NPC_TRADE_RUNNER_SECRET=playwright-trade-secret npm start`,
    url: `http://127.0.0.1:${port}/favicon.ico`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
