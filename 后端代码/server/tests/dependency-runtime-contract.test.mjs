import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  SUPPORTED_NODE_RANGE,
  findLockfileDependencyViolations,
  findLockfileSelectionViolations,
  findManifestDependencyViolations,
  findRuntimeCapabilityViolations,
  findRuntimeWiringViolations,
  isSupportedNodeVersion,
  probeDatabaseSync,
} from '../scripts/check-runtime-contract.mjs'

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
)
const lockfile = JSON.parse(
  await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'),
)

test('dependency contract excludes native sqlite3 from manifest and lockfile', () => {
  assert.deepEqual(findManifestDependencyViolations(manifest), [])
  assert.deepEqual(findLockfileDependencyViolations(lockfile), [])
})

test('runtime contract is declared consistently and cannot be skipped with ignore-scripts', () => {
  assert.equal(manifest.engines?.node, SUPPORTED_NODE_RANGE)
  assert.deepEqual(manifest.devEngines?.runtime, {
    name: 'node',
    version: SUPPORTED_NODE_RANGE,
    onFail: 'error',
  })
  assert.deepEqual(findRuntimeWiringViolations(manifest, lockfile), [])

  const manifestMutant = structuredClone(manifest)
  manifestMutant.scripts.build = 'tsc'
  assert.match(
    findRuntimeWiringViolations(manifestMutant, lockfile).join('\n'),
    /scripts\.build/,
  )
})

test('dependency mutation is detected before sqlite3 can return unnoticed', () => {
  const manifestMutant = structuredClone(manifest)
  manifestMutant.dependencies = {
    ...manifestMutant.dependencies,
    sqlite3: '^5.1.7',
  }

  const lockfileMutant = structuredClone(lockfile)
  lockfileMutant.packages['node_modules/sqlite3'] = {
    version: '5.1.7',
    hasInstallScript: true,
  }

  assert.match(
    findManifestDependencyViolations(manifestMutant).join('\n'),
    /must not declare sqlite3/,
  )
  assert.match(
    findLockfileDependencyViolations(lockfileMutant).join('\n'),
    /node_modules\/sqlite3/,
  )
})

test('npm alias mutation cannot hide sqlite3 behind another dependency name', () => {
  const manifestMutant = structuredClone(manifest)
  manifestMutant.dependencies.driver = 'npm:sqlite3@^5.1.7'

  const lockfileMutant = structuredClone(lockfile)
  lockfileMutant.packages[''].dependencies.driver = 'npm:sqlite3@^5.1.7'
  lockfileMutant.packages['node_modules/driver'] = {
    name: 'sqlite3',
    version: '5.1.7',
    resolved: 'https://registry.npmjs.org/sqlite3/-/sqlite3-5.1.7.tgz',
    hasInstallScript: true,
  }

  assert.match(
    findManifestDependencyViolations(manifestMutant).join('\n'),
    /alias.*sqlite3/i,
  )
  assert.match(
    findLockfileDependencyViolations(lockfileMutant).join('\n'),
    /sqlite3/,
  )
})

test('npm-shrinkwrap cannot silently override the lockfile checked by the guard', () => {
  assert.deepEqual(findLockfileSelectionViolations(false), [])
  assert.match(
    findLockfileSelectionViolations(true).join('\n'),
    /npm-shrinkwrap\.json/,
  )
})

test('the repository-backed Node 22 floor and the local Node 24 line pass the version gate', () => {
  assert.equal(SUPPORTED_NODE_RANGE, '^22.23.1 || ^24.0.0')
  assert.equal(isSupportedNodeVersion('22.12.99'), false)
  assert.equal(isSupportedNodeVersion('22.13.0'), false)
  assert.equal(isSupportedNodeVersion('22.23.0'), false)
  assert.equal(isSupportedNodeVersion('22.23.1'), true)
  assert.equal(isSupportedNodeVersion('23.4.0'), false)
  assert.equal(isSupportedNodeVersion('24.0.0'), true)
  assert.equal(isSupportedNodeVersion('24.0.0-rc.1'), false)
  assert.equal(isSupportedNodeVersion('24.15.0'), true)
  assert.equal(isSupportedNodeVersion('25.0.0'), false)
  assert.equal(isSupportedNodeVersion('not-a-version'), false)
})

test('runtime capability mutation fails when DatabaseSync is unavailable', () => {
  assert.deepEqual(findRuntimeCapabilityViolations('24.15.0', true), [])
  assert.match(
    findRuntimeCapabilityViolations('24.15.0', false).join('\n'),
    /in-memory probe failed/,
  )
})

test('runtime capability mutation fails when the in-memory database cannot close cleanly', () => {
  class CloseFailureDatabaseSync {
    prepare() {
      return { get: () => ({ ok: 1 }) }
    }

    close() {
      throw new Error('close failed')
    }
  }

  assert.equal(
    probeDatabaseSync({ DatabaseSync: CloseFailureDatabaseSync }),
    false,
  )
})

test('the current runtime completes an in-memory node:sqlite query', async () => {
  const sqlite = await import('node:sqlite')
  assert.equal(probeDatabaseSync(sqlite), true)
})
