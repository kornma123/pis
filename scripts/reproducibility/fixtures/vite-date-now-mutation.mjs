import path from 'node:path'
import { fileURLToPath } from 'node:url'
import baseConfig from '../../../前端代码/vite.config.ts'

const FIXTURE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND_SOURCE_DIRECTORY = path.resolve(FIXTURE_DIRECTORY, '..', '..', '..', '前端代码', 'src')

export default async function dateNowMutation(environment) {
  const base = typeof baseConfig === 'function' ? await baseConfig(environment) : baseConfig
  const output = base.build?.rollupOptions?.output ?? {}
  const timestamp = Date.now()

  return {
    ...base,
    resolve: {
      ...base.resolve,
      alias: {
        ...base.resolve?.alias,
        '@': FRONTEND_SOURCE_DIRECTORY,
      },
    },
    build: {
      ...base.build,
      rollupOptions: {
        ...base.build?.rollupOptions,
        output: {
          ...output,
          entryFileNames: `assets/[name]-[hash]-${timestamp}.js`,
          chunkFileNames: `assets/[name]-[hash]-${timestamp}.js`,
          assetFileNames: `assets/[name]-[hash]-${timestamp}.[ext]`,
        },
      },
    },
  }
}
