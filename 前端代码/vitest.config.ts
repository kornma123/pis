import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: [
        'src/test/**',
        'src/**/*.d.ts',
        'src/types/**',
        'src/**/*.config.*',
      ],
    },
  },
  // 组件测试使用 React 自动 JSX 运行时（与应用构建的 SWC automatic runtime 对齐），
  // 这样组件源码无需显式 import React 即可在 vitest 中渲染
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
