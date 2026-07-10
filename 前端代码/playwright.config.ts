import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60000,
  reporter: [
    ['html', { outputFolder: 'e2e-report' }],
    ['list'],
  ],
  use: {
    baseURL: 'http://localhost:8080',
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
          : process.env.CI
            ? undefined
            : { executablePath: 'C:\\Users\\86185\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe' },
      },
    },
  ],

  // 同时启动后端 API 和前端 dev server，解决 E2E 测试因后端未启动导致的超时
  webServer: [
    {
      command: 'cd ../后端代码/server && npx tsx src/app.ts',
      url: 'http://localhost:3001/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
      // E2E 后端须以 development 运行：既落 app.listen（NODE_ENV!=='test'），又启用夹具账号种子
      // （安全止血后 fail-closed：仅显式 dev/test 才种 admin/admin123 等，E2E 登录依赖它）。
      env: { ...process.env, NODE_ENV: 'development' },
    },
    {
      command: 'npx vite --host',
      url: 'http://localhost:8080',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  ],
})
