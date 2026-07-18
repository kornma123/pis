import { randomBytes } from 'node:crypto'
import { devNull, tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const frontendDir = dirname(fileURLToPath(import.meta.url))
const backendDir = resolve(frontendDir, '..', '后端代码', 'server')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const childEnvironmentKeys = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL',
])
const safeChildEnvironment: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && childEnvironmentKeys.has(key.toUpperCase())) {
    safeChildEnvironment[key] = value
  }
}
Object.assign(safeChildEnvironment, {
  NPM_CONFIG_OFFLINE: 'true',
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  NPM_CONFIG_USERCONFIG: devNull,
  NPM_CONFIG_GLOBALCONFIG: resolve(
    tmpdir(),
    `.coreone-absent-global-npmrc-${process.pid}-${randomBytes(8).toString('hex')}`,
  ),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
})

function portFromEnvironment(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`[E2E_ENV] ${name} must be an integer between 1 and 65535`)
  }
  return String(port)
}

function booleanFlag(name: string): boolean {
  const value = process.env[name]?.trim()
  if (!value || value === '0') return false
  if (value === '1') return true
  throw new Error(`[E2E_ENV] ${name} must be 0 or 1`)
}

const backendPort = portFromEnvironment('E2E_BACKEND_PORT', '3001')
const frontendPort = portFromEnvironment('E2E_FRONTEND_PORT', '8080')
if (backendPort === frontendPort) {
  throw new Error('[E2E_ENV] E2E_BACKEND_PORT and E2E_FRONTEND_PORT must be different')
}

const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim()
if (chromiumExecutablePath && !isAbsolute(chromiumExecutablePath)) {
  throw new Error('[E2E_ENV] PLAYWRIGHT_CHROMIUM_PATH must be an absolute path')
}
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH
if (browsersPath !== undefined && browsersPath !== browsersPath.trim()) {
  throw new Error('[E2E_ENV] PLAYWRIGHT_BROWSERS_PATH must not contain surrounding whitespace')
}
if (browsersPath && browsersPath !== '0' && !isAbsolute(browsersPath)) {
  throw new Error('[E2E_ENV] PLAYWRIGHT_BROWSERS_PATH must be 0 or an absolute path')
}
const reuseExistingServer = !process.env.CI && booleanFlag('E2E_REUSE_EXISTING_SERVER')
const ephemeralJwtSecret = randomBytes(48).toString('base64url')

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
    baseURL: `http://127.0.0.1:${frontendPort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: chromiumExecutablePath
          ? { executablePath: chromiumExecutablePath }
          : undefined,
      },
    },
  ],

  // 同时启动后端 API 和前端 dev server，解决 E2E 测试因后端未启动导致的超时
  webServer: [
    {
      command: `${npmCommand} exec --offline -- tsx src/app.ts`,
      cwd: backendDir,
      url: `http://127.0.0.1:${backendPort}/api/health`,
      reuseExistingServer,
      timeout: 60000,
      // E2E 后端须以 development 运行：既落 app.listen（NODE_ENV!=='test'），又启用夹具账号种子
      // （安全止血后 fail-closed：仅显式 dev/test 才种 admin/admin123 等，E2E 登录依赖它）。
      // JWT 使用进程内临时高熵值；SQLite 使用内存库，绝不复用生产或仓库数据库。
      env: {
        ...safeChildEnvironment,
        NODE_ENV: 'development',
        PORT: backendPort,
        JWT_SECRET: ephemeralJwtSecret,
        DATABASE_PATH: ':memory:',
      },
    },
    {
      command: `${npmCommand} run dev -- --host 127.0.0.1 --port ${frontendPort} --strictPort`,
      cwd: frontendDir,
      url: `http://127.0.0.1:${frontendPort}`,
      reuseExistingServer,
      timeout: 120000,
      env: {
        ...safeChildEnvironment,
        VITE_API_BASE_URL: `http://127.0.0.1:${backendPort}/api/v1`,
      },
    },
  ],
})
