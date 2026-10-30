import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 180000,
  expect: { timeout: 20000 },
  use: {
    actionTimeout: 20000,
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  reporter: "list",
});
