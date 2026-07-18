#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const backend = resolve(root, '后端代码', 'server')
const launcher = resolve(backend, 'scripts', 'start-production.mjs')
const compiledApp = resolve(backend, 'dist', 'src', 'app.js')
const release = 'c'.repeat(40)
const launchedChildren = new Set()

assert.ok(existsSync(compiledApp), 'compiled backend is missing; run the backend build first')

function safeChildEnvironment() {
  const env = { NODE_ENV: 'production', NODE_NO_WARNINGS: '1' }
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const { port } = address
      server.close(error => (error ? reject(error) : resolvePort(port)))
    })
  })
}

function delay(milliseconds) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function launch(extraEnvironment, expectedEvents) {
  const child = spawn(process.execPath, ['--experimental-sqlite', launcher], {
    cwd: backend,
    env: { ...safeChildEnvironment(), ...extraEnvironment },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  launchedChildren.add(child)
  child.once('exit', () => launchedChildren.delete(child))
  const events = new Set()
  let stdoutCarry = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    const text = `${stdoutCarry}${chunk}`
    for (const event of expectedEvents) {
      if (text.includes(`\"event\":\"${event}\"`)) events.add(event)
    }
    stdoutCarry = text.slice(-160)
  })
  child.stderr.resume()
  return { child, events }
}

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('launcher exit timed out'))
    }, timeoutMilliseconds)
    const onExit = code => {
      cleanup()
      resolveExit(code)
    }
    const onError = error => {
      cleanup()
      reject(error)
    }
    function cleanup() {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function waitForHealth(child, port, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds
  let lastStatus = 'not reachable'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`launcher exited before health check (code ${child.exitCode})`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) })
      lastStatus = `HTTP ${response.status}`
      if (response.ok) {
        const body = await response.json()
        assert.equal(body?.success, true)
        assert.equal(body?.data?.status, 'ok')
        return
      }
    } catch (error) {
      lastStatus = error instanceof Error ? error.name : 'request failed'
    }
    await delay(150)
  }
  throw new Error(`health endpoint did not become ready: ${lastStatus}`)
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null) return
  try {
    child.kill()
  } catch (error) {
    if (error?.code === 'ESRCH') return
    throw error
  }
  try {
    await waitForExit(child, 5000)
    return
  } catch {
    child.kill('SIGKILL')
  }
  await waitForExit(child, 5000)
}

const sandbox = mkdtempSync(join(tmpdir(), 'coreone-launcher-smoke-'))
const databasePath = join(sandbox, 'coreone-smoke.db')
const jwtSecretPath = join(sandbox, 'jwt.secret')
const adminSecretPath = join(sandbox, 'admin.secret')
writeFileSync(jwtSecretPath, randomBytes(48).toString('base64url'), { flag: 'wx', mode: 0o600 })
let adminPassword = `Aa9!${randomBytes(30).toString('base64url')}z`
writeFileSync(adminSecretPath, adminPassword, { flag: 'wx', mode: 0o600 })

try {
  const forbiddenDatabasePath = join(sandbox, 'forbidden-serve-create.db')
  const forbiddenServe = launch({
    COREONE_RUN_MODE: 'serve',
    COREONE_RELEASE_SHA: release,
    JWT_SECRET_FILE: jwtSecretPath,
    DATABASE_PATH: forbiddenDatabasePath,
    COREONE_ALLOW_DATABASE_CREATE: '1',
  }, [])
  assert.notEqual(await waitForExit(forbiddenServe.child, 10000), 0, 'serve mode accepted database creation')
  assert.equal(existsSync(forbiddenDatabasePath), false, 'forbidden serve mode created a database')

  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecarDatabasePath = join(sandbox, `stale-sidecar${suffix}.db`)
    const sidecarPath = `${sidecarDatabasePath}${suffix}`
    writeFileSync(sidecarPath, 'stale SQLite sidecar must fail closed', { flag: 'wx' })
    const sidecarInitializer = launch({
      COREONE_RUN_MODE: 'initialize',
      COREONE_RELEASE_SHA: release,
      ADMIN_INITIAL_PASSWORD_FILE: adminSecretPath,
      DATABASE_PATH: sidecarDatabasePath,
      COREONE_ALLOW_DATABASE_CREATE: '1',
    }, [])
    assert.notEqual(await waitForExit(sidecarInitializer.child, 10000), 0, `initializer accepted ${suffix}`)
    assert.equal(existsSync(sidecarDatabasePath), false, `initializer opened a database beside ${suffix}`)
    rmSync(sidecarPath, { force: true })
  }

  const initializer = launch({
    COREONE_RUN_MODE: 'initialize',
    COREONE_RELEASE_SHA: release,
    ADMIN_INITIAL_PASSWORD_FILE: adminSecretPath,
    DATABASE_PATH: databasePath,
    COREONE_ALLOW_DATABASE_CREATE: '1',
  }, ['coreone.database_initializing', 'coreone.database_initialized'])
  assert.equal(await waitForExit(initializer.child, 45000), 0, 'database initializer failed')
  assert.ok(initializer.events.has('coreone.database_initializing'), 'database initializing event is missing')
  assert.ok(initializer.events.has('coreone.database_initialized'), 'database initialized event is missing')

  const repeatedInitializer = launch({
    COREONE_RUN_MODE: 'initialize',
    COREONE_RELEASE_SHA: release,
    ADMIN_INITIAL_PASSWORD_FILE: adminSecretPath,
    DATABASE_PATH: databasePath,
    COREONE_ALLOW_DATABASE_CREATE: '1',
  }, [])
  assert.notEqual(await waitForExit(repeatedInitializer.child, 10000), 0, 'initializer accepted an existing database')
  rmSync(adminSecretPath, { force: true })

  const database = new DatabaseSync(databasePath, { readOnly: true })
  const admin = database.prepare("SELECT username FROM users WHERE username='admin' AND status=1").get()
  database.close()
  assert.equal(admin?.username, 'admin', 'initializer did not create the controlled admin')

  const port = await reservePort()
  const server = launch({
    COREONE_RUN_MODE: 'serve',
    COREONE_RELEASE_SHA: release,
    JWT_SECRET_FILE: jwtSecretPath,
    DATABASE_PATH: databasePath,
    COREONE_ALLOW_DATABASE_CREATE: '0',
    PORT: String(port),
  }, ['coreone.starting', 'coreone.started'])
  await waitForHealth(server.child, port, 45000)

  const loginResponse = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: adminPassword }),
    signal: AbortSignal.timeout(5000),
  })
  const loginBody = await loginResponse.json()
  assert.equal(loginResponse.ok, true, 'initialized admin cannot log in')
  assert.equal(loginBody?.success, true, 'initialized admin login did not return success')
  adminPassword = undefined

  assert.ok(server.events.has('coreone.starting'), 'structured starting event is missing')
  assert.ok(server.events.has('coreone.started'), 'structured started event is missing')
  assert.equal(existsSync(adminSecretPath), false, 'serve smoke retained the one-time admin secret file')
  process.stdout.write('launcher smoke selftest: isolated init, admin login, restart, and health passed\n')
} finally {
  adminPassword = undefined
  for (const child of [...launchedChildren]) await stopChild(child)
  rmSync(sandbox, { recursive: true, force: true })
}
