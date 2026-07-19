#!/usr/bin/env node

import assert from 'node:assert/strict'
import childProcess, { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const backend = resolve(root, '后端代码', 'server')
const launcher = resolve(backend, 'scripts', 'start-production.mjs')
const launcherSmoke = resolve(here, 'launcher-smoke.selftest.mjs')
const release = 'd'.repeat(40)
const sentinel = 'COREONE_DIAGNOSTIC_SECRET_SENTINEL_DO_NOT_ECHO'
const missingSecretPath = join(tmpdir(), `coreone-${sentinel}`, 'missing.jwt')
const rawPayload = `raw-child-payload:${sentinel}:${missingSecretPath}`
const preloadUrl = `data:text/javascript,${encodeURIComponent(`process.stderr.write(${JSON.stringify(`${rawPayload}\n`)})`)}`

function childEnvironment(extra = {}) {
  const env = { NODE_ENV: 'production', NODE_NO_WARNINGS: '1', ...extra }
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function parseStructuredRecords(stderr) {
  const records = []
  for (const line of stderr.split(/\r?\n/u)) {
    try {
      const record = JSON.parse(line)
      if (record && typeof record === 'object' && !Array.isArray(record)) records.push(record)
    } catch {
      // Raw stderr is deliberately present in this fixture and is not a record.
    }
  }
  return records
}

function assertNoSensitiveOutput(output) {
  if (output.includes(sentinel)) throw new Error('parent diagnostics leaked the sentinel')
  if (output.includes(missingSecretPath)) throw new Error('parent diagnostics leaked the absolute temporary path')
  if (output.includes('raw-child-payload')) throw new Error('parent diagnostics leaked raw child stderr')
  if (/"(?:timestamp|component|release|mode)"/u.test(output)) {
    throw new Error('parent diagnostics leaked the structured child payload')
  }
}

const args = process.argv.slice(2)

if (args.length === 1 && args[0] === '--fixture') {
  const originalSpawn = childProcess.spawn
  childProcess.spawn = (program, childArgs, options = {}) => {
    const env = {
      ...options.env,
      TRUST_PROXY_HOPS: '1',
      TRUST_PROXY_CIDRS: '127.0.0.0/8,::1/128',
    }
    if (env.COREONE_RUN_MODE === 'serve' && env.COREONE_ALLOW_DATABASE_CREATE === '0') {
      env.JWT_SECRET_FILE = missingSecretPath
      env.NODE_OPTIONS = `--import=${preloadUrl}`
    }
    return originalSpawn(program, childArgs, { ...options, env })
  }
  syncBuiltinESMExports()
  try {
    await import(`${pathToFileURL(launcherSmoke).href}?diagnostics=${Date.now()}`)
  } finally {
    childProcess.spawn = originalSpawn
    syncBuiltinESMExports()
  }
} else if (args.length > 0) {
  process.stderr.write('launcher smoke diagnostics selftest accepts only --fixture\n')
  process.exitCode = 2
} else {
  const directFailure = spawnSync(process.execPath, ['--experimental-sqlite', launcher], {
    cwd: backend,
    encoding: 'utf8',
    env: childEnvironment({
      COREONE_RUN_MODE: 'serve',
      COREONE_RELEASE_SHA: release,
      JWT_SECRET_FILE: missingSecretPath,
      DATABASE_PATH: join(tmpdir(), 'coreone-diagnostics-unused.db'),
      COREONE_ALLOW_DATABASE_CREATE: '0',
      NODE_OPTIONS: `--import=${preloadUrl}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  assert.equal(directFailure.status, 1, 'controlled launcher child did not exit 1')
  if (!directFailure.stderr.includes(rawPayload)) {
    throw new Error('controlled launcher child did not emit the raw sentinel fixture')
  }
  const childRecord = parseStructuredRecords(directFailure.stderr)
    .find(record => record.event === 'coreone.uncaught_exception')
  assert.ok(childRecord, 'controlled launcher child did not emit coreone.uncaught_exception')
  assert.equal(childRecord.errorType, 'Error', 'controlled launcher child emitted an unexpected error class')

  const parentFailure = spawnSync(process.execPath, [
    '--experimental-sqlite',
    fileURLToPath(import.meta.url),
    '--fixture',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  assert.equal(parentFailure.status, 1, 'controlled parent smoke did not preserve child failure')
  const parentOutput = `${parentFailure.stdout}\n${parentFailure.stderr}`
  assertNoSensitiveOutput(parentOutput)
  assert.match(parentOutput, /event=coreone\.uncaught_exception/u, 'parent smoke omitted the stable child event classification')
  assert.match(parentOutput, /errorType=Error/u, 'parent smoke omitted the stable child error classification')
  assert.match(parentOutput, /exit=1/u, 'parent smoke omitted the child exit classification')
  assert.match(parentOutput, /signal=none/u, 'parent smoke omitted the child signal classification')
  process.stdout.write('launcher smoke diagnostics selftest: child failure classified without raw stderr disclosure\n')
}
