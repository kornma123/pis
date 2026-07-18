#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const {
  buildCanonicalGateReceipt,
  canonicalJson: canonicalGateJson,
} = require('../local-release-gate.cjs')

let api
try {
  api = await import('./export-local-images.mjs')
} catch (error) {
  process.stderr.write(`  FAIL exporter module exists\n${error.code || error.message}\n`)
  process.exitCode = 1
}

if (api) {
  const {
    EXPORT_RECEIPT_SCHEMA_VERSION,
    canonicalJson,
    exportLocalImages,
    verifyCanonicalExportReceipt,
  } = api

  let passed = 0
  let failed = 0
  function test(name, fn) {
    try {
      fn()
      passed += 1
      process.stdout.write(`  PASS ${name}\n`)
    } catch (error) {
      failed += 1
      process.stderr.write(`  FAIL ${name}\n${error.stack || error.message}\n`)
    }
  }

  const BASE_SHA = '1'.repeat(40)
  const HEAD_SHA = '2'.repeat(40)
  const TREE_SHA = '3'.repeat(40)
  const GATE_TOOL_SHA256 = '4'.repeat(64)
  const ALLOWLIST_SHA256 = '5'.repeat(64)
  const BUILD_TOOL_SHA256 = '6'.repeat(64)
  const EXPORT_TOOL_SHA256 = '7'.repeat(64)
  const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')
  const BACKEND_IMAGE = `sha256:${'a'.repeat(64)}`
  const FRONTEND_IMAGE = `sha256:${'b'.repeat(64)}`
  const BACKEND_DIGEST = `coreone-backend@sha256:${'c'.repeat(64)}`
  const FRONTEND_DIGEST = `coreone-frontend@sha256:${'d'.repeat(64)}`
  const DELIVERY_ID = '22222222-2222-4222-8222-222222222222'
  const ITEM_IDS = [
    'runtime:node',
    'runtime:npm',
    'e2e:browser',
    'runtime:docker-daemon',
  ]

  function gateInput({ blocked = false, repository = {} } = {}) {
    return {
      repository: {
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        headTreeSha: TREE_SHA,
        commits: [HEAD_SHA],
        ...repository,
      },
      gateToolSha256: GATE_TOOL_SHA256,
      allowlistConfigSha256: ALLOWLIST_SHA256,
      deliveryId: '11111111-1111-4111-8111-111111111111',
      nonce: '8'.repeat(64),
      gateExitCode: blocked ? 2 : 0,
      planItemIds: [...ITEM_IDS],
      results: ITEM_IDS.map((id, index) => ({
        id,
        status: blocked && id === 'runtime:docker-daemon' ? 'BLOCKED' : 'PASS',
        exitCode: id === 'e2e:browser' || (blocked && id === 'runtime:docker-daemon') ? null : 0,
        durationMs: index + 1,
        stdoutSha256: EMPTY_SHA256,
        stderrSha256: EMPTY_SHA256,
      })),
      capabilities: {
        node: { status: 'PASS', version: '22.23.1' },
        npm: { status: 'PASS', version: '10.9.2' },
        browser: { status: 'PASS', executableVerified: true },
        docker: blocked
          ? { status: 'BLOCKED', clientVersion: '29.5.2', serverVersion: null }
          : { status: 'PASS', clientVersion: '29.5.2', serverVersion: '29.5.2' },
      },
    }
  }

  function buildReceipt(overrides = {}) {
    return {
      schema: 'coreone.local-image-build-receipt/v1',
      createdAt: '2026-07-19T00:00:00.000Z',
      release: HEAD_SHA,
      sourceTreeClean: true,
      backend: { tag: `coreone-backend:${HEAD_SHA}`, image: BACKEND_IMAGE },
      frontend: { tag: `coreone-frontend:${HEAD_SHA}`, image: FRONTEND_IMAGE },
      productionExecutionAuthorized: false,
      ...overrides,
    }
  }

  function resealGateReceipt(receipt) {
    const copy = structuredClone(receipt)
    delete copy.receiptRootSha256
    copy.receiptRootSha256 = createHash('sha256').update(canonicalGateJson(copy)).digest('hex')
    return copy
  }

  function resealExportReceipt(receipt) {
    const copy = structuredClone(receipt)
    delete copy.receiptRootSha256
    copy.receiptRootSha256 = createHash('sha256').update(canonicalJson(copy)).digest('hex')
    return copy
  }

  function fakeDocker({ drift = false, saveFailure = false } = {}) {
    const calls = []
    let inspections = 0
    const runner = (program, args) => {
      calls.push([program, ...args])
      if (program !== 'docker') return { status: 127, stdout: '', stderr: '' }
      if (args[0] === 'version') {
        return {
          status: 0,
          stdout: JSON.stringify({ Client: { Version: '29.5.2' }, Server: { Version: '29.5.2' } }),
          stderr: '',
        }
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        inspections += 1
        const imageId = args[2]
        const backend = imageId === BACKEND_IMAGE
        const digest = backend ? BACKEND_DIGEST : FRONTEND_DIGEST
        return {
          status: 0,
          stdout: JSON.stringify({
            Id: imageId,
            RepoDigests: drift && inspections > 2 && backend
              ? [`coreone-backend@sha256:${'e'.repeat(64)}`]
              : [digest],
            Config: { Labels: { 'org.opencontainers.image.revision': HEAD_SHA } },
          }),
          stderr: '',
        }
      }
      if (args[0] === 'save') {
        const outputIndex = args.indexOf('--output')
        writeFileSync(args[outputIndex + 1], 'coreone-docker-save-archive-v1')
        return saveFailure
          ? { status: 1, stdout: '', stderr: 'synthetic save failure' }
          : { status: 0, stdout: '', stderr: '' }
      }
      return { status: 127, stdout: '', stderr: '' }
    }
    return { calls, runner }
  }

  function fixture(options = {}) {
    const sandbox = mkdtempSync(join(tmpdir(), 'coreone-image-export-selftest-'))
    const repositoryRoot = join(sandbox, 'repo')
    const inputRoot = join(sandbox, 'inputs')
    const outputRoot = join(sandbox, 'outputs')
    mkdirSync(repositoryRoot)
    mkdirSync(inputRoot)
    mkdirSync(outputRoot)
    const gateReceiptPath = join(inputRoot, 'gate.json')
    const buildReceiptPath = join(inputRoot, 'build.json')
    const archivePath = join(outputRoot, 'images.tar')
    const receiptPath = join(outputRoot, 'export.json')
    const gateReceipt = options.gateReceipt || buildCanonicalGateReceipt(gateInput(options.gateOptions))
    writeFileSync(gateReceiptPath, canonicalGateJson(gateReceipt))
    writeFileSync(buildReceiptPath, JSON.stringify(options.buildReceipt || buildReceipt()))
    const docker = fakeDocker(options.dockerOptions)
    return {
      sandbox,
      repositoryRoot,
      gateReceiptPath,
      buildReceiptPath,
      archivePath,
      receiptPath,
      gateReceipt,
      docker,
      run(overrides = {}) {
        return exportLocalImages({
          repositoryRoot,
          repository: {
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
            headTreeSha: TREE_SHA,
            commits: [HEAD_SHA],
          },
          releaseSha: HEAD_SHA,
          gateReceiptPath,
          buildReceiptPath,
          archivePath,
          receiptPath,
          toolSha256: {
            gate: GATE_TOOL_SHA256,
            build: BUILD_TOOL_SHA256,
            exporter: EXPORT_TOOL_SHA256,
          },
          runner: docker.runner,
          now: () => '2026-07-19T00:01:00.000Z',
          deliveryId: () => DELIVERY_ID,
          ...overrides,
        })
      },
      cleanup() {
        rmSync(sandbox, { recursive: true, force: true })
      },
    }
  }

  function partials(path) {
    return readdirSync(dirname(path)).filter((name) => name.includes('.partial-'))
  }

  function assertNoOutputs(state) {
    assert.equal(existsSync(state.archivePath), false)
    assert.equal(existsSync(state.receiptPath), false)
    assert.deepEqual(partials(state.archivePath), [])
    assert.deepEqual(partials(state.receiptPath), [])
  }

  function withFixture(options, fn) {
    const state = fixture(options)
    try {
      fn(state)
    } finally {
      state.cleanup()
    }
  }

  test('happy fixture writes one canonical receipt-bound archive export', () => {
    withFixture({}, (state) => {
      const receipt = state.run()
      assert.equal(receipt.schemaVersion, EXPORT_RECEIPT_SCHEMA_VERSION)
      assert.deepEqual(receipt.repository, {
        releaseSha: HEAD_SHA,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        headTreeSha: TREE_SHA,
        commits: [HEAD_SHA],
      })
      assert.deepEqual(receipt.tools, {
        exporterSha256: EXPORT_TOOL_SHA256,
        buildToolSha256: BUILD_TOOL_SHA256,
        gateToolSha256: GATE_TOOL_SHA256,
      })
      assert.equal(receipt.inputs.gateReceiptRootSha256, state.gateReceipt.receiptRootSha256)
      assert.match(receipt.inputs.buildReceiptSha256, /^[0-9a-f]{64}$/u)
      assert.deepEqual(receipt.images.backend, {
        imageId: BACKEND_IMAGE,
        revision: HEAD_SHA,
        repoDigests: [BACKEND_DIGEST],
      })
      assert.deepEqual(receipt.images.frontend, {
        imageId: FRONTEND_IMAGE,
        revision: HEAD_SHA,
        repoDigests: [FRONTEND_DIGEST],
      })
      assert.equal(receipt.archive.format, 'docker-save-tar')
      assert.equal(receipt.archive.sizeBytes, readFileSync(state.archivePath).length)
      assert.equal(receipt.admissible, true)
      assert.equal(readFileSync(state.receiptPath, 'utf8'), canonicalJson(receipt))
      assert.doesNotThrow(() => verifyCanonicalExportReceipt(receipt, {
        archivePath: state.archivePath,
        repository: receipt.repository,
        toolSha256: { gate: GATE_TOOL_SHA256, build: BUILD_TOOL_SHA256, exporter: EXPORT_TOOL_SHA256 },
      }))
      const saveCall = state.docker.calls.find((call) => call[1] === 'save')
      assert.deepEqual(saveCall.slice(-2), [BACKEND_IMAGE, FRONTEND_IMAGE])
      assert.equal(state.docker.calls.some((call) => ['load', 'run'].includes(call[1])), false)
    })
  })

  test('gate/build receipt state, repository, and tool mismatches fail closed', () => {
    const cases = [
      { buildReceipt: buildReceipt({ release: '9'.repeat(40) }), pattern: /release/i },
      { gateOptions: { blocked: true }, pattern: /admissible|PASS|BLOCKED/i },
      { gateOptions: { repository: { baseSha: '9'.repeat(40) } }, pattern: /base/i },
      { gateOptions: { repository: { headSha: '9'.repeat(40), commits: ['9'.repeat(40)] } }, pattern: /head/i },
      { gateOptions: { repository: { headTreeSha: '9'.repeat(40) } }, pattern: /tree/i },
    ]
    for (const scenario of cases) {
      withFixture(scenario, (state) => {
        assert.throws(() => state.run(), scenario.pattern)
        assertNoOutputs(state)
      })
    }
    withFixture({}, (state) => {
      assert.throws(() => state.run({
        toolSha256: { gate: '9'.repeat(64), build: BUILD_TOOL_SHA256, exporter: EXPORT_TOOL_SHA256 },
      }), /tool/i)
      assertNoOutputs(state)
    })
  })

  test('mutable image identity and post-save inspect drift fail closed', () => {
    withFixture({
      buildReceipt: buildReceipt({
        backend: { tag: `coreone-backend:${HEAD_SHA}`, image: 'coreone-backend:latest' },
      }),
    }, (state) => {
      assert.throws(() => state.run(), /immutable|sha256|image/i)
      assertNoOutputs(state)
    })
    withFixture({ dockerOptions: { drift: true } }, (state) => {
      assert.throws(() => state.run(), /drift|RepoDigest|identity/i)
      assertNoOutputs(state)
    })
  })

  test('docker save failure is atomic and archive truncation invalidates the receipt', () => {
    withFixture({ dockerOptions: { saveFailure: true } }, (state) => {
      assert.throws(() => state.run(), /docker save|save failed/i)
      assertNoOutputs(state)
    })
    withFixture({}, (state) => {
      const receipt = state.run()
      truncateSync(state.archivePath, 3)
      assert.throws(() => verifyCanonicalExportReceipt(receipt, { archivePath: state.archivePath }), /archive.*(digest|size)/i)
    })
  })

  test('existing archive or receipt targets are never overwritten', () => {
    for (const target of ['archivePath', 'receiptPath']) {
      withFixture({}, (state) => {
        writeFileSync(state[target], 'existing')
        assert.throws(() => state.run(), /exists|overwrite/i)
        assert.equal(readFileSync(state[target], 'utf8'), 'existing')
        assert.deepEqual(partials(state[target]), [])
      })
    }
  })

  test('repository-internal archive or receipt targets are rejected before docker save', () => {
    for (const target of ['archivePath', 'receiptPath']) {
      withFixture({}, (state) => {
        const overrides = { [target]: join(state.repositoryRoot, target === 'archivePath' ? 'images.tar' : 'receipt.json') }
        assert.throws(() => state.run(overrides), /outside|repository/i)
        assert.deepEqual(readdirSync(state.repositoryRoot), [])
        assert.equal(state.docker.calls.some((call) => call[1] === 'save'), false)
      })
    }
  })

  test('strict receipt allowlists reject secret and database material', () => {
    for (const contaminated of [
      buildReceipt({ environment: { JWT_SECRET: 'must-not-persist' } }),
      buildReceipt({ database: 'coreone.db' }),
    ]) {
      withFixture({ buildReceipt: contaminated }, (state) => {
        assert.throws(() => state.run(), /field|secret|database|forbidden/i)
        assertNoOutputs(state)
      })
    }
    withFixture({}, (state) => {
      const contaminated = structuredClone(state.gateReceipt)
      contaminated.argv = ['--token=must-not-persist']
      writeFileSync(state.gateReceiptPath, canonicalGateJson(resealGateReceipt(contaminated)))
      assert.throws(() => state.run(), /forbidden|schema|secret/i)
      assertNoOutputs(state)
    })
    withFixture({}, (state) => {
      const receipt = state.run()
      for (const [key, value] of [
        ['environment', { JWT_SECRET: 'must-not-persist' }],
        ['database', 'coreone.db'],
      ]) {
        const contaminated = structuredClone(receipt)
        contaminated[key] = value
        assert.throws(() => verifyCanonicalExportReceipt(resealExportReceipt(contaminated)), /field|forbidden|secret|database/i)
      }
    })
  })

  if (failed > 0) {
    process.stderr.write(`export-local-images selftest: FAIL (${failed} failed, ${passed} passed)\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`export-local-images selftest: PASS (${passed}/${passed})\n`)
  }
}
