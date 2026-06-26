import { defineConfig } from 'vitest/config'
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
    testTimeout: 30000,
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
