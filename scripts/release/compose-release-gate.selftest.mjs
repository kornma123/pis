#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const release = '1'.repeat(40)
const otherRelease = '2'.repeat(40)
const backendImage = `sha256:${'a'.repeat(64)}`
const frontendImage = `sha256:${'b'.repeat(64)}`
const failures = []
let assertions = 0
let gate
let importFailure

try {
  gate = await import('./compose-release-gate.mjs')
} catch (error) {
  importFailure = error
}

async function check(name, assertion) {
  assertions += 1
  try {
    assert.ok(gate, `compose release gate is unavailable: ${importFailure?.message || 'unknown import failure'}`)
    await assertion()
    process.stdout.write(`  PASS ${name}\n`)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    failures.push({ name, detail })
    process.stdout.write(`  FAIL ${name}: ${detail}\n`)
  }
}

function receipt(overrides = {}) {
  return {
    schema: 'coreone.local-image-build-receipt/v1',
    createdAt: '2026-07-18T00:00:00.000Z',
    release,
    sourceTreeClean: true,
    backend: { tag: `coreone-backend:${release}`, image: backendImage },
    frontend: { tag: `coreone-frontend:${release}`, image: frontendImage },
    productionExecutionAuthorized: false,
    ...overrides,
  }
}

function composeModel(profile, overrides = {}) {
  const services = {
    backend: {
      image: backendImage,
      labels: { 'org.opencontainers.image.revision': release, 'com.coreone.component': 'backend' },
    },
    frontend: {
      image: frontendImage,
      labels: { 'org.opencontainers.image.revision': release, 'com.coreone.component': 'frontend' },
    },
  }
  if (profile === 'operator-r3-first-install') {
    services['database-init'] = {
      image: backendImage,
      labels: { 'org.opencontainers.image.revision': release, 'com.coreone.component': 'database-init' },
    }
  }
  if (profile === 'operator-r3-volume-migration') {
    services['volume-permission-migration'] = {
      image: backendImage,
      labels: {
        'org.opencontainers.image.revision': release,
        'com.coreone.component': 'volume-permission-migration',
      },
    }
  }
  return {
    name: 'coreone-test',
    services,
    volumes: { 'coreone-data': { name: 'coreone-test-data', external: true } },
    ...overrides,
  }
}

function imageInspection(image, component, overrides = {}) {
  return {
    Id: image,
    RepoDigests: [`coreone-${component}@sha256:${component === 'backend' ? 'c'.repeat(64) : 'd'.repeat(64)}`],
    Config: { Labels: { 'org.opencontainers.image.revision': release } },
    ...overrides,
  }
}

function fakeRunner({
  profile = 'normal',
  model,
  inspections = {},
  daemon = true,
  gitHead = release,
  dirty = '',
} = {}) {
  const calls = []
  const runner = (program, args) => {
    calls.push({ program, args: [...args] })
    if (program === 'git') {
      if (args[0] === 'rev-parse') return { status: 0, stdout: `${gitHead}\n`, stderr: '' }
      if (args[0] === 'status') return { status: 0, stdout: dirty, stderr: '' }
      return { status: 99, stdout: '', stderr: `unexpected fake git command: ${args.join(' ')}` }
    }
    assert.equal(program, 'docker')
    if (args[0] === 'version') {
      return {
        status: 0,
        stdout: JSON.stringify({ Client: { Version: '29.5.2' }, Server: daemon ? { Version: '29.5.2' } : null }),
        stderr: '',
      }
    }
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = args[2]
      const component = image === backendImage ? 'backend' : 'frontend'
      const inspection = inspections[component] || imageInspection(image, component)
      return { status: 0, stdout: JSON.stringify(inspection), stderr: '' }
    }
    if (args.includes('config')) {
      return { status: 0, stdout: JSON.stringify(model || composeModel(profile)), stderr: '' }
    }
    if (args.includes('up') || args.includes('run')) {
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 99, stdout: '', stderr: `unexpected fake docker command: ${args.join(' ')}` }
  }
  return { calls, runner }
}

function environment(overrides = {}) {
  return {
    COREONE_RELEASE_SHA: release,
    COREONE_BACKEND_IMAGE: backendImage,
    COREONE_FRONTEND_IMAGE: frontendImage,
    COREONE_DATA_VOLUME_NAME: 'coreone-test-data',
    COREONE_JWT_SECRET_FILE: 'C:\\operator\\jwt.secret',
    COREONE_INTERNAL_SUBNET: '10.77.0.0/24',
    ...overrides,
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'coreone-compose-release-gate-test-'))
try {
  const receiptPath = join(sandbox, 'build-receipt.json')
  writeFileSync(receiptPath, `${JSON.stringify(receipt())}\n`, 'utf8')

  await check('strict image references reject mutable tags and malformed digests', () => {
    assert.equal(gate.validateImmutableImageReference(backendImage, 'backend image'), backendImage)
    for (const invalid of [
      'coreone-backend:latest',
      `coreone-backend@${backendImage}`,
      `sha256:${'A'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
      ` ${backendImage}`,
    ]) {
      assert.throws(() => gate.validateImmutableImageReference(invalid, 'backend image'))
    }
  })

  await check('external receipt schema, release, tags, and both image IDs are equality-bound', () => {
    const verified = gate.readBuildReceipt(receiptPath, { release, backendImage, frontendImage })
    assert.equal(verified.release, release)
    assert.equal(verified.backend.image, backendImage)
    assert.equal(verified.frontend.image, frontendImage)

    const cases = [
      { release: otherRelease },
      { backend: { tag: `coreone-backend:${release}`, image: `sha256:${'e'.repeat(64)}` } },
      { frontend: { tag: `coreone-frontend:${release}`, image: `sha256:${'f'.repeat(64)}` } },
      { schema: 'coreone.local-image-build-receipt/v0' },
      { unexpected: true },
    ]
    for (const [index, override] of cases.entries()) {
      const path = join(sandbox, `mismatch-${index}.json`)
      writeFileSync(path, JSON.stringify(receipt(override)), 'utf8')
      assert.throws(() => gate.readBuildReceipt(path, { release, backendImage, frontendImage }))
    }
  })

  await check('normal, first-install, and volume-migration profiles use one admission gate', async () => {
    for (const profile of ['normal', 'operator-r3-first-install', 'operator-r3-volume-migration']) {
      const fake = fakeRunner({ profile })
      const result = await gate.admitComposeRelease({
        profile,
        receiptPath,
        env: environment(),
        runner: fake.runner,
      })
      assert.equal(result.status, 'RELEASE_ADMISSION_VERIFIED')
      assert.equal(result.profile, profile)
      assert.equal(result.release, release)
      assert.ok(fake.calls.some(call => call.args[0] === 'version'))
      assert.equal(fake.calls.filter(call => call.args[0] === 'image' && call.args[1] === 'inspect').length, 2)
      assert.ok(fake.calls.some(call => call.args.includes('config')))
    }
  })

  await check('all three profiles reject mutable image tags before Docker execution', async () => {
    for (const profile of ['normal', 'operator-r3-first-install', 'operator-r3-volume-migration']) {
      const fake = fakeRunner({ profile })
      await assert.rejects(
        gate.admitComposeRelease({
          profile,
          receiptPath,
          env: environment({ COREONE_BACKEND_IMAGE: 'coreone-backend:mutable' }),
          runner: fake.runner,
        }),
        /sha256/iu,
      )
      assert.equal(fake.calls.length, 0)
    }
  })

  await check('daemon or inspect identity unknown is fail-closed', async () => {
    const missingDaemon = fakeRunner({ daemon: false })
    await assert.rejects(
      gate.admitComposeRelease({ profile: 'normal', receiptPath, env: environment(), runner: missingDaemon.runner }),
      error => error?.exitCode === 2 && /daemon|server/iu.test(error.message),
    )

    for (const [name, inspection] of Object.entries({
      missingId: imageInspection(backendImage, 'backend', { Id: undefined }),
      wrongId: imageInspection(backendImage, 'backend', { Id: `sha256:${'9'.repeat(64)}` }),
      missingRepoDigests: imageInspection(backendImage, 'backend', { RepoDigests: undefined }),
      wrongRevision: imageInspection(backendImage, 'backend', {
        Config: { Labels: { 'org.opencontainers.image.revision': otherRelease } },
      }),
    })) {
      const fake = fakeRunner({ inspections: { backend: inspection } })
      await assert.rejects(
        gate.admitComposeRelease({ profile: 'normal', receiptPath, env: environment(), runner: fake.runner }),
        undefined,
        name,
      )
    }
  })

  await check('fixed release HEAD and clean Compose source are required', async () => {
    for (const fake of [
      fakeRunner({ gitHead: otherRelease }),
      fakeRunner({ dirty: ' M docker-compose.yml\n' }),
    ]) {
      await assert.rejects(
        gate.admitComposeRelease({ profile: 'normal', receiptPath, env: environment(), runner: fake.runner }),
        /HEAD|clean|drift|working tree/iu,
      )
      assert.equal(fake.calls.some(call => call.program === 'docker'), false)
    }
  })

  await check('rendered service images and revision labels cannot drift from the receipt', async () => {
    const wrongImageModel = composeModel('normal')
    wrongImageModel.services.backend.image = `sha256:${'8'.repeat(64)}`
    const wrongLabelModel = composeModel('normal')
    wrongLabelModel.services.frontend.labels['org.opencontainers.image.revision'] = otherRelease
    for (const model of [wrongImageModel, wrongLabelModel]) {
      const fake = fakeRunner({ model })
      await assert.rejects(
        gate.admitComposeRelease({ profile: 'normal', receiptPath, env: environment(), runner: fake.runner }),
      )
    }
  })

  await check('fixed release execution is wrapped and direct migration execution is delegated', async () => {
    const normal = fakeRunner({ profile: 'normal' })
    const result = await gate.runComposeRelease({
      profile: 'normal',
      receiptPath,
      env: environment(),
      runner: normal.runner,
      execute: true,
    })
    assert.equal(result.status, 'LOCAL_COMPOSE_EXECUTED')
    assert.ok(normal.calls.some(call => call.args.join(' ') === 'compose up --detach --no-build --pull never'))

    const migration = fakeRunner({ profile: 'operator-r3-volume-migration' })
    await assert.rejects(
      gate.runComposeRelease({
        profile: 'operator-r3-volume-migration',
        receiptPath,
        env: environment(),
        runner: migration.runner,
        execute: true,
      }),
      /run-volume-migration/iu,
    )
    assert.equal(migration.calls.some(call => call.args.includes('run')), false)
  })
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

if (failures.length > 0) {
  process.stderr.write(`compose release gate selftest: ${failures.length}/${assertions} failed\n`)
  for (const failure of failures) process.stderr.write(`- ${failure.name}: ${failure.detail}\n`)
  process.exit(1)
}

process.stdout.write(`compose release gate selftest: ${assertions} assertions passed\n`)
