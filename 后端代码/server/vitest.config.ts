import { defineConfig, configDefaults } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// node:sqlite 是 Node 22+ 的实验性内置模块，但 vite 5 的 isBuiltin 剥离 `node:` 前缀后在
// builtinModules 中找不到 'sqlite'（该模块只以 `node:sqlite` 前缀形式存在），于是把它当成待解析的
// 源文件并报 "Failed to load url sqlite"。把这两种写法 alias 到本地垫片（真实文件，vite 能加载；
// 内部用 createRequire 拿到真正的内置模块再 re-export），彻底绕开。
const sqliteShim = fileURLToPath(new URL('./tests/node-sqlite-shim.mjs', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: /^node:sqlite$/, replacement: sqliteShim },
      { find: /^sqlite$/, replacement: sqliteShim },
    ],
  },
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // 以下 12 个是 tsx 集成冒烟脚本（自定义 test()+process.exit，需 live server，用
    // `npx tsx tests/X.test.ts` 单跑），不是 vitest 套件。文件名撞了 *.test.ts 会被 include 抓进来
    // 报 "No test suite found" → 使 `npm test` / CI 天生红。从 vitest 排除（默认排除项照带）。
    exclude: [
      ...configDefaults.exclude,
      'tests/auth.test.ts', 'tests/inbound.test.ts', 'tests/inventory.test.ts',
      'tests/outbound.test.ts', 'tests/materials.test.ts', 'tests/categories.test.ts',
      'tests/suppliers.test.ts', 'tests/supplier-returns.test.ts', 'tests/purchase-orders.test.ts',
      'tests/locations.test.ts', 'tests/roles.test.ts', 'tests/users.test.ts',
    ],
    testTimeout: 30000,
    // 安全回归会并行执行真实 bcrypt cost=12；Windows/低核 CI 上初始化 SQLite 的
    // beforeAll 可能被 CPU 争用拖过 Vitest 默认 10 秒，但并非挂死。与 testTimeout 对齐。
    hookTimeout: 30000,
    globals: true,
    environment: 'node',
    // 每文件强制独立内存库，消除跨文件 SQLite 污染（详见 tests/db-isolation.setup.ts）
    setupFiles: ['./tests/db-isolation.setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--experimental-sqlite'],
      },
    },
  },
})
