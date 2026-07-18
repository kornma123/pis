#!/usr/bin/env node

// This is the only production image entrypoint. Set the mode before any
// application module loads dotenv/config so fixtures cannot be re-enabled.
process.env.NODE_ENV = 'production'

const { isAbsolute } = await import('node:path')
const { lstatSync, readFileSync } = await import('node:fs')

const releaseSha = process.env.COREONE_RELEASE_SHA
if (!/^[0-9a-f]{40}$/u.test(releaseSha || '')) {
  throw new Error('COREONE_RELEASE_SHA must be the approved 40-character lowercase commit SHA')
}

const runMode = process.env.COREONE_RUN_MODE || 'serve'
if (!['serve', 'initialize'].includes(runMode)) {
  throw new Error('COREONE_RUN_MODE must be serve or initialize')
}

function releaseLog(level, event, detail = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    component: 'backend',
    event,
    release: releaseSha,
    mode: runMode,
    ...detail,
  }
  process[level === 'error' ? 'stderr' : 'stdout'].write(`${JSON.stringify(record)}\n`)
}

process.on('uncaughtException', error => {
  releaseLog('error', 'coreone.uncaught_exception', { errorType: error?.name || 'Error' })
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  releaseLog('error', 'coreone.unhandled_rejection', {
    errorType: reason instanceof Error ? reason.name : typeof reason,
  })
  process.exit(1)
})

function hasEnvironmentVariable(name) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
}

function loadRequiredSecretFile(fileVariable, valueVariable) {
  if (hasEnvironmentVariable(valueVariable)) {
    throw new Error(`${valueVariable} inline values are forbidden; use ${fileVariable}`)
  }
  const filePath = process.env[fileVariable]
  if (!filePath) throw new Error(`${fileVariable} is required`)
  if (!isAbsolute(filePath)) throw new Error(`${fileVariable} must be an absolute path`)

  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${fileVariable} must reference a regular file`)

  const value = readFileSync(filePath, 'utf8').replace(/\r?\n$/u, '')
  if (!value || value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error(`${fileVariable} contains an invalid secret payload`)
  }
  process.env[valueVariable] = value
  delete process.env[fileVariable]
}

function rejectSecretInputs(fileVariable, valueVariable, mode) {
  if (hasEnvironmentVariable(fileVariable) || hasEnvironmentVariable(valueVariable)) {
    throw new Error(`${mode} mode does not accept ${fileVariable} or ${valueVariable}`)
  }
}

function assertPathDoesNotExist(filePath, label) {
  try {
    lstatSync(filePath)
    throw new Error(`initialize mode requires a pristine DATABASE_PATH; found ${label}`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

if (runMode === 'initialize') {
  rejectSecretInputs('JWT_SECRET_FILE', 'JWT_SECRET', 'initialize')
  if (process.env.COREONE_ALLOW_DATABASE_CREATE !== '1') {
    throw new Error('initialize mode requires COREONE_ALLOW_DATABASE_CREATE=1')
  }
  const databasePath = process.env.DATABASE_PATH
  if (!databasePath || !isAbsolute(databasePath)) {
    throw new Error('initialize mode requires an absolute DATABASE_PATH')
  }
  for (const [candidate, label] of [
    [databasePath, 'database file'],
    [`${databasePath}-wal`, 'WAL sidecar'],
    [`${databasePath}-shm`, 'shared-memory sidecar'],
    [`${databasePath}-journal`, 'rollback-journal sidecar'],
  ]) {
    assertPathDoesNotExist(candidate, label)
  }
  loadRequiredSecretFile('ADMIN_INITIAL_PASSWORD_FILE', 'ADMIN_INITIAL_PASSWORD')
  releaseLog('info', 'coreone.database_initializing', { node: process.version })
  const { initializeDatabase } = await import('../dist/src/database/DatabaseManager.js')
  initializeDatabase()
  delete process.env.ADMIN_INITIAL_PASSWORD
  releaseLog('info', 'coreone.database_initialized')
} else {
  rejectSecretInputs('ADMIN_INITIAL_PASSWORD_FILE', 'ADMIN_INITIAL_PASSWORD', 'serve')
  if (process.env.COREONE_ALLOW_DATABASE_CREATE === '1') {
    throw new Error('serve mode forbids COREONE_ALLOW_DATABASE_CREATE=1')
  }
  loadRequiredSecretFile('JWT_SECRET_FILE', 'JWT_SECRET')
  releaseLog('info', 'coreone.starting', { node: process.version })
  await import('../dist/src/app.js')
  delete process.env.JWT_SECRET
  releaseLog('info', 'coreone.started')
}
