import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: process.env.LARGE_E2E === "1" ? [] : ["**/*.large.spec.ts"],
  timeout: 30000,
  retries: 0,
  // In parallel: the stack's server runs with raised rate limits
  // (RATE_LIMIT_MULTIPLIER), and every test makes its own secrets.
  fullyParallel: true,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:8080",
    headless: true,
    acceptDownloads: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
});
