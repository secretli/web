import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: process.env.LARGE_E2E === "1" ? [] : ["**/*.large.spec.ts"],
  timeout: 30000,
  retries: 0,
  // One test at a time: the server allows 10 new secrets a minute per client
  // address, all of these tests come from one address, and run in parallel
  // they create more than that within seconds.
  workers: 1,
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
