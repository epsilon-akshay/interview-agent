import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 45_000,
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    headless: true
  },
  webServer: {
    command: "npm run build -- --outDir /tmp/interview-agent-browser-build && npx vite preview --host 127.0.0.1 --port 5174 --outDir /tmp/interview-agent-browser-build",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false
  }
});
