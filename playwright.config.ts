import { defineConfig } from "@playwright/test";

/**
 * Integration tests drive the **bridge**, never the page (plan §8): Playwright's
 * only job is to launch Chromium with the built extension loaded and to read the
 * bridge's HTTP surface. No CDP calls from the test side, so a passing test
 * proves the extension path itself works.
 */
export default defineConfig({
  testDir: "./tests/integration",
  globalSetup: "./tests/integration/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 120_000,
  projects: [
    {
      name: "integration",
      testMatch: /.*\.spec\.ts/,
      testIgnore: /keepalive\.spec\.ts/,
    },
    {
      name: "keepalive",
      testMatch: /keepalive\.spec\.ts/,
      timeout: 8 * 60_000,
      retries: 0,
    },
  ],
});
