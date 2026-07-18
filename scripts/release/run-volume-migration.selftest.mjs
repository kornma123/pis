#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const release = '1'.repeat(40)
const backendImage = `sha256:${'a'.repeat(64)}`
const frontendImage = `sha256:${'b'.repeat(64)}`
const volumeName = 'coreone-test-data'
const failures = []
let assertions = 0
let migration
let importFailure

try {
  migration = await import('./run-volume-migration.mjs')
} catch (error) {
  importFailure = error
}

async function check(name, assertion) {
  assertions += 1
  try {
    assert.ok(migration, `volume migration runner is unavailable: ${importFailure?.message || 'unknown import failure'}`)
    await assertion()
    process.stdout.write(`  PASS ${name}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push({ name, detail })
    process.stdout.write(`  FAIL ${name}: ${detail}\n`)
  }
}

function receipt() {
  return {
    schema: 'coreone.local-image-build-receipt/v1',
    createdAt: '2026-07-18T00:00:00.000Z',
    release,
    sourceTreeClean: true,
    backend: { tag: `coreone-backend:${release}`, image: backendImage },
    frontend: { tag: `coreone-frontend:${release}`, image: frontendImage },
    productionExecutionAuthorized: false,
  }
}

function composeModel() {
  return {
    name: 'coreone-test',
    services: {
      backend: {
        image: backendImage,
        labels: { 'org.opencontainers.image.revision': release, 'com.coreone.component': 'backend' },
      },
      frontend: {
        image: frontendImage,
        labels: { 'org.opencontainers.image.revision': release, 'com.coreone.component': 'frontend' },
      },
      'volume-permission-migration': {
        image: backendImage,
        labels: {
          'org.opencontainers.image.revision': release,
          'com.coreone.component': 'volume-permission-migration',
        },
      },
    },
    volumes: { 'coreone-data': { name: volumeName, external: true } },
  }
}

function imageInspection(image, component) {
  return {
    Id: image,
    RepoDigests: [`coreone-${component}@sha256:${component === 'backend' ? 'c'.repeat(64) : 'd'.repeat(64)}`],
    Config: { Labels: { 'org.opencontainers.image.revision': release } },
  }
}

function container({
  id = '3'.repeat(64),
  name = '/writer',
  status = 'running',
  running = true,
  mountName = volumeName,
  includeMounts = true,
} = {}) {
  const result = {
    Id: id,
    Name: name,
    State: { Status: status, Running: running, Paused: false, Restarting: false },
  }
  if (includeMounts) {
    result.Mounts = [{ Type: 'volume', Name: mountName, Destination: '/app/data', RW: true }]
  }
  return result
}

function fakeDocker({ snapshots = [[], [], []], mutationStatus = 0, mutationOutput } = {}) {
  const calls = []
  let enumerationIndex = 0
  let currentSnapshot = []
  const runner = (program, args) => {
    calls.push({ program, args: [...args] })
    if (program === 'git') {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${release}\n`, stderr: '' }
      if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
      return { status: 99, stdout: '', stderr: `unexpected fake git command: ${args.join(' ')}` }
    }
    assert.equal(program, 'docker')
    if (args[0] === 'version') {
      return {
        status: 0,
        stdout: JSON.stringify({ Client: { Version: '29.5.2' }, Server: { Version: '29.5.2' } }),
        stderr: '',
      }
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = args[2]
      const component = image === backendImage ? 'backend' : 'frontend'
      return { status: 0, stdout: JSON.stringify(imageInspection(image, component)), stderr: '' }
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return {
        status: 0,
        stdout: JSON.stringify({ Name: volumeName, Driver: 'local', Scope: 'local', Mountpoint: '/var/lib/docker/volumes/coreone-test-data/_data' }),
        stderr: '',
      }
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      currentSnapshot = snapshots[Math.min(enumerationIndex, snapshots.length - 1)] || []
      const stdout = currentSnapshot.map(item => item.Id).join('\n')
      if (currentSnapshot.length === 0) enumerationIndex += 1
      return { status: 0, stdout, stderr: '' }
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      const snapshot = currentSnapshot
      enumerationIndex += 1
      currentSnapshot = []
      return { status: 0, stdout: JSON.stringify(snapshot), stderr: '' }
    }
    if (args.includes('config')) {
      return { status: 0, stdout: JSON.stringify(composeModel()), stderr: '' }
    }
    if (args.includes('stop') && args.at(-1) === 'backend') {
      return { status: 0, stdout: '', stderr: '' }
    }
    if (args.includes('run') && args.includes('volume-permission-migration')) {
      if (args.includes('/app/release/verify-volume-migration.mjs') && args.includes('pre')) {
        return {
          status: 0,
          stdout: `${JSON.stringify({ status: 'VOLUME_MIGRATION_PRECHECK_VERIFIED', snapshotOrdinal: 1 })}\n`,
          stderr: '',
        }
      }
      return {
        status: mutationStatus,
        stdout: mutationOutput || (mutationStatus === 0
          ? `${JSON.stringify({
              status: 'VOLUME_MIGRATION_POSTCHECK_VERIFIED',
              snapshotOrdinal: 2,
              recursiveOwnershipVerified: true,
            })}\n`
          : ''),
        stderr: mutationStatus === 0 ? '' : 'simulated ownership failure',
      }
    }
    return { status: 99, stdout: '', stderr: `unexpected fake docker command: ${args.join(' ')}` }
  }
  return { calls, runner }
}

function environment(sandbox) {
  return {
    COREONE_RELEASE_SHA: release,
    COREONE_BACKEND_IMAGE: backendImage,
    COREONE_FRONTEND_IMAGE: frontendImage,
    COREONE_DATA_VOLUME_NAME: volumeName,
    COREONE_JWT_SECRET_FILE: join(sandbox, 'jwt.secret'),
    COREONE_INTERNAL_SUBNET: '10.77.0.0/24',
    COREONE_VOLUME_MIGRATION_ACK: 'R3_APPROVED_BACKUP_VERIFIED',
    COREONE_MIGRATION_BACKUP_SHA: '4'.repeat(64),
    COREONE_MIGRATION_BACKUP_NAME: 'migration.db',
    COREONE_MIGRATION_BACKUP_FILE: join(sandbox, 'migration.db'),
    COREONE_MIGRATION_MANIFEST_FILE: join(sandbox, 'migration.db.manifest.json'),
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'coreone-volume-migration-runner-test-'))
try {
  const receiptPath = join(sandbox, 'build-receipt.json')
  writeFileSync(receiptPath, `${JSON.stringify(receipt())}\n`, 'utf8')
  for (const name of ['jwt.secret', 'migration.db', 'migration.db.manifest.json']) {
    writeFileSync(join(sandbox, name), 'synthetic-selftest-fixture\n', 'utf8')
  }

  await check('exact-volume active mount is rejected before precheck or chown', async () => {
    const fake = fakeDocker({ snapshots: [[container()]] })
    await assert.rejects(
      migration.runVolumeMigration({ receiptPath, env: environment(sandbox), runner: fake.runner }),
      error => error?.mutationStarted === false && /active|mounted|writer/iu.test(error.message),
    )
    assert.equal(fake.calls.some(call => call.args.includes('/app/release/verify-volume-migration.mjs')), false)
    assert.equal(fake.calls.some(call => call.args.includes('/bin/sh')), false)
  })

  await check('only an exact volume-name match blocks; stopped associations remain inspectable', async () => {
    const unrelated = container({ mountName: `${volumeName}-other` })
    const stopped = container({ id: '5'.repeat(64), name: '/stopped-backend', status: 'exited', running: false })
    const fake = fakeDocker({ snapshots: [[unrelated, stopped], [unrelated, stopped], [unrelated, stopped]] })
    const result = await migration.runVolumeMigration({ receiptPath, env: environment(sandbox), runner: fake.runner })
    assert.equal(result.status, 'VOLUME_MIGRATION_VERIFIED')
    assert.equal(result.backendStarted, false)
    assert.equal(result.snapshotOrdinal, 2)
    assert.equal(result.recursiveOwnershipVerified, true)
  })

  await check('a writer injected after precheck aborts before ownership mutation', async () => {
    const fake = fakeDocker({ snapshots: [[], [container({ name: '/late-writer' })]] })
    await assert.rejects(
      migration.runVolumeMigration({ receiptPath, env: environment(sandbox), runner: fake.runner }),
      error => error?.mutationStarted === false && /active|mounted|writer/iu.test(error.message),
    )
    assert.ok(fake.calls.some(call => call.args.includes('pre')))
    assert.equal(fake.calls.some(call => call.args.includes('/bin/sh')), false)
  })

  await check('partial ownership failure requires forward-fix and never starts backend', async () => {
    const fake = fakeDocker({ snapshots: [[], [], []], mutationStatus: 17 })
    const result = await migration.runVolumeMigration({ receiptPath, env: environment(sandbox), runner: fake.runner })
    assert.equal(result.status, 'PARTIAL_MUTATION_FORWARD_FIX_REQUIRED')
    assert.equal(result.mutationStarted, true)
    assert.equal(result.backendStarted, false)
    assert.equal(result.rollbackAttempted, false)
    assert.ok(fake.calls.filter(call => call.args.includes('stop') && call.args.at(-1) === 'backend').length >= 2)
    assert.equal(fake.calls.some(call => call.args.includes('up')), false)
  })

  await check('a writer observed after postcheck still forces forward-fix-required', async () => {
    const fake = fakeDocker({ snapshots: [[], [], [container({ name: '/postcheck-writer' })], []] })
    const result = await migration.runVolumeMigration({ receiptPath, env: environment(sandbox), runner: fake.runner })
    assert.equal(result.status, 'PARTIAL_MUTATION_FORWARD_FIX_REQUIRED')
    assert.equal(result.backendStarted, false)
    assert.equal(result.rollbackAttempted, false)
  })

  await check('unknown container inspection is fail-closed before mutation', async () => {
    const fake = fakeDocker({ snapshots: [[container({ includeMounts: false })]] })
    await assert.rejects(
      migration.runVolumeMigration({ receiptPath, env: environment(sandbox), runner: fake.runner }),
      error => error?.mutationStarted === false && /unknown|inspect|mount/iu.test(error.message),
    )
    assert.equal(fake.calls.some(call => call.args.includes('/bin/sh')), false)
  })
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`volume migration runner selftest: ${failures.length}/${assertions} failed\n`)
  for (const failure of failures) process.stderr.write(`- ${failure.name}: ${failure.detail}\n`)
  process.exit(1)
}

process.stdout.write(`volume migration runner selftest: ${assertions} assertions passed\n`)
