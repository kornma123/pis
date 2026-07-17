#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  buildEnvironment,
  createManifest,
  diffManifests,
  hasManifestDifferences,
  manifestDigest,
} = require('./frontend-build-repro.cjs')

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..')
const CHECKER = path.join(__dirname, 'frontend-build-repro.cjs')
const FRONTEND_DIRECTORY = path.join(REPOSITORY_ROOT, '前端代码')
const VITE_ENTRYPOINT = path.join(FRONTEND_DIRECTORY, 'node_modules', 'vite', 'bin', 'vite.js')
const MUTATION_CONFIG = path.join(__dirname, 'fixtures', 'vite-date-now-mutation.mjs')

const contaminatedDefaultEnvironment = buildEnvironment(
  null,
  path.resolve(os.tmpdir(), 'coreone-empty-vite-env'),
  {
    release_sha: 'must-not-leak',
    Build_Id: 'must-not-leak',
  },
)
assert.equal(
  Object.keys(contaminatedDefaultEnvironment).some((name) =>
    ['RELEASE_SHA', 'BUILD_ID'].includes(name.toUpperCase()),
  ),
  false,
  'default identity must remove every case variant of RELEASE_SHA and BUILD_ID',
)

const contaminatedExplicitEnvironment = buildEnvironment(
  { releaseSha: 'explicit-release', buildId: 'explicit-build' },
  path.resolve(os.tmpdir(), 'coreone-empty-vite-env'),
  {
    release_sha: 'must-be-replaced',
    Build_Id: 'must-be-replaced',
  },
)
assert.deepEqual(
  Object.fromEntries(
    Object.entries(contaminatedExplicitEnvironment).filter(([name]) =>
      ['RELEASE_SHA', 'BUILD_ID'].includes(name.toUpperCase()),
    ),
  ),
  { RELEASE_SHA: 'explicit-release', BUILD_ID: 'explicit-build' },
  'explicit identity must use only canonical environment keys',
)

function runChecker(argumentsList = []) {
  return spawnSync(process.execPath, [CHECKER, ...argumentsList], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
}

function combinedOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`
}

const reference = [
  { path: 'a.txt', size: 1, sha256: 'a'.repeat(64) },
  { path: 'nested/b.txt', size: 2, sha256: 'b'.repeat(64) },
]
const identical = reference.map((entry) => ({ ...entry }))
const changed = reference.map((entry) => ({ ...entry }))
changed[1].sha256 = 'c'.repeat(64)
const renamed = reference.map((entry) => ({ ...entry }))
renamed[1].path = 'nested/renamed.txt'

assert.deepEqual(diffManifests(reference, identical), { missing: [], unexpected: [], changed: [] })
assert.equal(hasManifestDifferences(diffManifests(reference, identical)), false)
assert.equal(manifestDigest(reference), manifestDigest(identical))
assert.deepEqual(diffManifests(reference, changed), {
  missing: [],
  unexpected: [],
  changed: ['nested/b.txt'],
})
assert.equal(hasManifestDifferences(diffManifests(reference, changed)), true)
assert.notEqual(manifestDigest(reference), manifestDigest(changed))
assert.deepEqual(diffManifests(reference, renamed), {
  missing: ['nested/b.txt'],
  unexpected: ['nested/renamed.txt'],
  changed: [],
})

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-repro-selftest-'))
try {
  const orderedTree = path.join(temporaryRoot, 'ordered-tree')
  const reverseOrderedTree = path.join(temporaryRoot, 'reverse-ordered-tree')
  fs.mkdirSync(path.join(orderedTree, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(orderedTree, 'nested', 'b.txt'), 'second', 'utf8')
  fs.writeFileSync(path.join(orderedTree, 'a.txt'), 'first', 'utf8')
  fs.mkdirSync(path.join(reverseOrderedTree, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(reverseOrderedTree, 'a.txt'), 'first', 'utf8')
  fs.writeFileSync(path.join(reverseOrderedTree, 'nested', 'b.txt'), 'second', 'utf8')
  assert.deepEqual(createManifest(orderedTree), createManifest(reverseOrderedTree))

  const invalidIdentityResult = spawnSync(
    process.execPath,
    [VITE_ENTRYPOINT, 'build', '--outDir', path.join(temporaryRoot, 'invalid-identity'), '--emptyOutDir'],
    {
      cwd: FRONTEND_DIRECTORY,
      env: { ...process.env, RELEASE_SHA: '   ', BUILD_ID: 'selftest' },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  )
  const invalidIdentityOutput = `${invalidIdentityResult.stdout || ''}${invalidIdentityResult.stderr || ''}`
  if (invalidIdentityResult.error) throw invalidIdentityResult.error
  assert.notEqual(invalidIdentityResult.status, 0, 'an explicitly empty RELEASE_SHA must fail closed')
  assert.match(invalidIdentityOutput, /RELEASE_SHA must be a non-empty printable value/)
  process.stdout.write('PASS explicitly empty build identity was rejected\n')

  const controlResult = runChecker(['--same-input-only'])
  if (controlResult.error) throw controlResult.error
  assert.equal(controlResult.status, 0, `production config control must pass\n${combinedOutput(controlResult)}`)
  assert.match(combinedOutput(controlResult), /PASS frontend build reproducibility contract/)
  process.stdout.write('PASS production config control was reproducible\n')

  const mutationResult = runChecker(['--same-input-only', `--vite-config=${MUTATION_CONFIG}`])
  const mutationOutput = combinedOutput(mutationResult)
  if (mutationResult.error) throw mutationResult.error
  assert.notEqual(mutationResult.status, 0, 'Date.now mutation must make the checker fail')
  assert.match(mutationOutput, /same identity file manifest\/hash mismatch/)
  process.stdout.write('PASS Date.now filename mutation was rejected by the real-build checker\n')
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true })
}
assert.equal(fs.existsSync(temporaryRoot), false, 'selftest temporary directory must be removed')

process.stdout.write('PASS frontend build reproducibility selftest\n')
