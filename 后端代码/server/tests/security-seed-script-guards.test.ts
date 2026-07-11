import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const created: string[] = []
const script = resolve(process.cwd(), 'scripts/seed-pathology-data.ts')

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('pathology seed script environment guard', () => {
  it.each(['production', 'staging', ''])(
    'refuses NODE_ENV=%j before importing or creating the target database',
    (nodeEnv) => {
      const directory = mkdtempSync(join(tmpdir(), 'coreone-seed-guard-'))
      created.push(directory)
      const databasePath = join(directory, 'must-not-exist.db')
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: nodeEnv,
            DATABASE_PATH: databasePath,
            JWT_SECRET: 'SeedGuardOnly9x'.repeat(4),
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      )

      expect(result.status).not.toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).toContain('development/test')
      expect(existsSync(databasePath)).toBe(false)
    },
  )
})
