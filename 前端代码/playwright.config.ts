import { defineConfig, devices } from '@playwright/test'

const backendPort = process.env.E2E_BACKEND_PORT || '3001'
const frontendPort = process.env.E2E_FRONTEND_PORT || '8080'
const apiBaseURL = process.env.E2E_API_BASE_URL || `http://127.0.0.1:${backendPort}/api/v1`

process.env.E2E_API_BASE_URL = apiBaseURL

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  timeout: 60000,
  reporter: [
    ['html', { outputFolder: 'e2e-report', open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: `http://localhost:${frontendPort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
          : undefined,
      },
    },
  ],

  // 同时启动后端 API 和前端 dev server，解决 E2E 测试因后端未启动导致的超时
  webServer: [
    {
      command: 'cd ../后端代码/server && npx tsx src/app.ts',
      url: `http://localhost:${backendPort}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
      // E2E 后端须以 development 运行：既落 app.listen（NODE_ENV!=='test'），又启用夹具账号种子
      // （安全止血后 fail-closed：仅显式 dev/test 才种 admin/admin123 等，E2E 登录依赖它）。
      env: { ...process.env, NODE_ENV: 'development', PORT: backendPort },
    },
    {
      command: `npx vite --host --port ${frontendPort}`,
      url: `http://localhost:${frontendPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
      env: {
        ...process.env,
        VITE_API_BASE_URL: apiBaseURL,
      },
    },
  ],
})
