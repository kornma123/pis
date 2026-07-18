#!/usr/bin/env node

'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  CONTROLLED_RUNTIME_RELATIVE,
  MAX_ARCHIVE_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MINIMUM_LOCAL_RELEASE_NODE_VERSION,
  REQUIRED_READINESS_IDS,
  ROOT,
  buildGateArguments,
  canonicalRuntimeTreeDigest,
  classifyBrowserProbe,
  classifyNodeProbe,
  classifyNpmCi,
  createSafeEnvironment,
  extractZipArchive,
  inspectZipArchive,
  overallReadinessExitCode,
  probeInstalledDependencies,
  resolveNpmCli,
  runChildPassthrough,
  runIsolatedOfflineNpmCi,
  validateBrowserExecutable,
  validateNode22Executable,
  verifyArchiveChecksum,
  verifyPinnedGitState,
} = require('./runtime-readiness.cjs')
const { parseFlags } = require('./index.cjs')
const { main: gateChildMain } = require('./gate-child.cjs')

function test(name, fn) {
  try {
    fn()
    process.stdout.write(`  PASS ${name}\n`)
  } catch (error) {
    process.stderr.write(`  FAIL ${name}\n${error.stack || error.message}\n`)
    process.exitCode = 1
  }
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function createStoredZip(archivePath, entries) {
  const localParts = []
  const centralParts = []
  let localOffset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const content = Buffer.from(entry.content || '')
    const checksum = crc32(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(content.length, 18)
    local.writeUInt32LE(content.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, content)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(content.length, 20)
    central.writeUInt32LE(content.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.name.endsWith('/') ? 0x41ed0010 : 0x81a40000, 38)
    central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + content.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  fs.writeFileSync(archivePath, Buffer.concat([...localParts, centralDirectory, end]))
}

test('repository contract requires supported Node 22 and controlled extraction stays under an ignored workspace directory', () => {
  assert.equal(CONTROLLED_RUNTIME_RELATIVE, '.agents/local-release-runtime/node22')
  assert.equal(MINIMUM_LOCAL_RELEASE_NODE_VERSION, '22.23.1')
  assert(MAX_ARCHIVE_BYTES >= 32 * 1024 * 1024)
  assert(MAX_TOTAL_UNCOMPRESSED_BYTES > MAX_ARCHIVE_BYTES)
})

test('local release rejects old Node 22 and Node 24 while accepting the supported Node 22 boundary', () => {
  const node24 = classifyNodeProbe({
    status: 0,
    stdout: JSON.stringify({ version: 'v24.15.0', execPath: 'C:\\runtime\\node.exe' }),
    stderr: '',
  }, 'C:\\runtime\\node.exe', 'win32')
  assert.equal(node24.status, 'BLOCKED')
  assert.match(node24.detail, /22\.23\.1/)

  const oldNode22 = classifyNodeProbe({
    status: 0,
    stdout: JSON.stringify({ version: 'v22.21.1', execPath: 'C:\\runtime\\node.exe' }),
    stderr: '',
  }, 'C:\\runtime\\node.exe', 'win32')
  assert.equal(oldNode22.status, 'BLOCKED')
  assert.match(oldNode22.detail, /22\.23\.1/)

  const boundaryNode22 = classifyNodeProbe({
    status: 0,
    stdout: JSON.stringify({ version: 'v22.23.1', execPath: 'C:\\runtime\\node.exe' }),
    stderr: '',
  }, 'C:\\runtime\\node.exe', 'win32')
  assert.equal(boundaryNode22.status, 'PASS')
  assert.equal(boundaryNode22.version, 'v22.23.1')

  const newerNode22 = classifyNodeProbe({
    status: 0,
    stdout: JSON.stringify({ version: 'v22.24.0', execPath: 'C:\\runtime\\node.exe' }),
    stderr: '',
  }, 'C:\\runtime\\node.exe', 'win32')
  assert.equal(newerNode22.status, 'PASS')
})

test('runbook locks the engine, real offline install, and Docker aggregation boundaries', () => {
  const backendPackage = JSON.parse(fs.readFileSync(path.join(ROOT, '后端代码', 'server', 'package.json'), 'utf8'))
  const runbook = fs.readFileSync(path.join(ROOT, 'docs', 'runbooks', 'local-release-runtime.md'), 'utf8')
  assert.equal(backendPackage.engines?.node, '^22.23.1 || ^24.0.0')
  assert.equal(backendPackage.devEngines?.runtime?.version, '^22.23.1 || ^24.0.0')
  for (const dockerfile of [
    path.join(ROOT, '前端代码', 'Dockerfile'),
    path.join(ROOT, '后端代码', 'server', 'Dockerfile'),
  ]) {
    assert.match(fs.readFileSync(dockerfile, 'utf8'), /FROM node:22\.23\.1-/)
  }
  assert.match(runbook, /\^22\.23\.1 \|\| \^24\.0\.0/)
  assert.match(runbook, /Node 22\.23\.1/)
  assert.match(runbook, /系统临时目录/)
  assert.match(runbook, /npm ci --offline --ignore-scripts --no-audit --fund=false/)
  assert.doesNotMatch(runbook, /npm ci --dry-run/)
  assert.match(runbook, /`probe`[^\n]*不检查 Docker/)
  assert.match(runbook, /`scripts\/local-release-gate\.cjs`[^\n]*Docker daemon/)
})

test('a script pretending to be Node is rejected before its claimed version is trusted', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-fake-node-'))
  const fakeNode = path.join(temporaryRoot, process.platform === 'win32' ? 'node.exe' : 'node')
  try {
    fs.writeFileSync(fakeNode, '#!/bin/sh\nprintf v22.23.1\n')
    if (process.platform !== 'win32') fs.chmodSync(fakeNode, 0o755)
    const outcome = validateNode22Executable(fakeNode)
    assert.equal(outcome.status, 'BLOCKED')
    assert.match(outcome.detail, /native executable|binary/i)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('Node and browser symlink paths fail closed', () => {
  const linked = () => ({
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => true,
  })
  const node = validateNode22Executable('/runtime/node', {
    platform: 'linux',
    lstat: linked,
  })
  const browser = validateBrowserExecutable('/browser/chromium', {
    platform: 'linux',
    lstat: linked,
  })
  assert.equal(node.status, 'BLOCKED')
  assert.equal(browser.status, 'BLOCKED')
  assert.match(node.detail, /link/i)
  assert.match(browser.detail, /link/i)
})

test('fake browser binaries are rejected and a real Chromium-shaped probe is accepted', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-fake-browser-'))
  const fakeBrowser = path.join(temporaryRoot, process.platform === 'win32' ? 'chrome.exe' : 'chromium')
  try {
    fs.writeFileSync(fakeBrowser, '#!/bin/sh\nprintf "Google Chrome 150.0.0.0"\n')
    if (process.platform !== 'win32') fs.chmodSync(fakeBrowser, 0o755)
    assert.equal(validateBrowserExecutable(fakeBrowser).status, 'BLOCKED')

    const accepted = classifyBrowserProbe({ status: 0, stdout: 'Google Chrome 150.0.7871.125\n', stderr: '' }, {
      platform: 'linux',
      metadata: null,
    })
    assert.equal(accepted.status, 'PASS')
    assert.equal(accepted.version, 'Google Chrome 150.0.7871.125')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('browser readiness is mandatory and cannot be skipped by aggregate status', () => {
  const results = REQUIRED_READINESS_IDS.map((id) => ({ id, status: 'PASS' }))
  results.find((result) => result.id === 'browser').status = 'BLOCKED'
  assert.equal(overallReadinessExitCode(results), 2)
  assert.equal(overallReadinessExitCode(results.filter((result) => result.id !== 'browser')), 1)
  results.find((result) => result.id === 'browser').status = 'PASS'
  assert.equal(overallReadinessExitCode(results), 0)
  assert.equal(overallReadinessExitCode([]), 1)
})

test('missing installed packages and real offline npm cache misses are stable BLOCKED outcomes', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-missing-deps-'))
  try {
    const installed = probeInstalledDependencies(temporaryRoot, [
      'node_modules/@playwright/test/package.json',
      'node_modules/vitest/package.json',
    ])
    assert.equal(installed.status, 'BLOCKED')
    assert.match(installed.detail, /@playwright\/test/)
    assert.equal(classifyNpmCi({ status: 1, stderr: 'npm error code ENOTCACHED' }).status, 'BLOCKED')
    assert.equal(classifyNpmCi({ status: 1, stderr: 'package.json and package-lock.json are not in sync' }).status, 'FAIL')
    assert.equal(classifyNpmCi({ status: 0, stdout: '', stderr: '' }).status, 'PASS')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('isolated offline npm ci performs a real install without writing source node_modules', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-real-offline-ci-'))
  const fixtureSource = path.join(temporaryRoot, 'fixture-source')
  const consumer = path.join(temporaryRoot, 'consumer')
  const cache = path.join(temporaryRoot, 'cache')
  try {
    fs.mkdirSync(fixtureSource)
    fs.mkdirSync(consumer)
    fs.mkdirSync(cache)
    fs.writeFileSync(path.join(fixtureSource, 'package.json'), JSON.stringify({
      name: 'coreone-offline-fixture',
      version: '1.0.0',
      files: ['index.js'],
    }))
    fs.writeFileSync(path.join(fixtureSource, 'index.js'), 'module.exports = "offline-fixture"\n')

    const npmCli = resolveNpmCli(process.execPath)
    assert.ok(npmCli, 'npm-cli.js must exist beside the selftest Node runtime')
    const npmEnvironment = createSafeEnvironment(process.env, { NPM_CONFIG_CACHE: cache })
    const pack = spawnSync(process.execPath, [
      npmCli,
      'pack',
      '--json',
      '--ignore-scripts',
      '--no-audit',
      '--fund=false',
      `--pack-destination=${consumer}`,
    ], {
      cwd: fixtureSource,
      env: npmEnvironment,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    })
    assert.equal(pack.status, 0, pack.stderr)
    const tarball = JSON.parse(pack.stdout)[0].filename
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({
      name: 'coreone-offline-consumer',
      version: '1.0.0',
      private: true,
      dependencies: { 'coreone-offline-fixture': `file:${tarball}` },
    }))
    const lock = spawnSync(process.execPath, [
      npmCli,
      'install',
      '--package-lock-only',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--fund=false',
    ], {
      cwd: consumer,
      env: npmEnvironment,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    })
    assert.equal(lock.status, 0, lock.stderr)
    fs.rmSync(path.join(consumer, 'node_modules'), { recursive: true, force: true })
    assert.equal(fs.existsSync(path.join(consumer, 'node_modules')), false)

    const outcome = runIsolatedOfflineNpmCi(consumer, process.execPath, {
      cacheDirectory: cache,
      required: ['node_modules/coreone-offline-fixture/package.json'],
    })
    assert.equal(outcome.status, 'PASS', outcome.detail)
    assert(outcome.installedPackageManifests >= 1)
    assert.equal(fs.existsSync(path.join(consumer, 'node_modules')), false)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('a completely empty npm cache makes the real repository lock proof BLOCKED', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-empty-offline-cache-'))
  try {
    const outcome = runIsolatedOfflineNpmCi(path.join(ROOT, '前端代码'), process.execPath, {
      cacheDirectory: path.join(temporaryRoot, 'empty-cache'),
      required: [
        'node_modules/vite/package.json',
        'node_modules/vitest/package.json',
        'node_modules/typescript/package.json',
        'node_modules/@playwright/test/package.json',
      ],
    })
    assert.equal(outcome.status, 'BLOCKED')
    assert.match(outcome.detail, /ENOTCACHED|offline cache/i)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('installed dependency versions must exactly match package-lock.json', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-installed-deps-'))
  const relative = 'node_modules/@playwright/test/package.json'
  const installed = path.join(temporaryRoot, ...relative.split('/'))
  try {
    fs.mkdirSync(path.dirname(installed), { recursive: true })
    fs.writeFileSync(installed, '{"name":"@playwright/test","version":"1.59.1"}\n')
    fs.writeFileSync(path.join(temporaryRoot, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/@playwright/test': { version: '1.59.1' } },
    }))
    assert.equal(probeInstalledDependencies(temporaryRoot, [relative]).status, 'PASS')
    fs.writeFileSync(installed, '{"name":"@playwright/test","version":"1.58.0"}\n')
    assert.equal(probeInstalledDependencies(temporaryRoot, [relative]).status, 'BLOCKED')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('checksum mismatch and absent operator files are rejected without extraction', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-node-archive-hash-'))
  const archive = path.join(temporaryRoot, 'node-v22.23.1-win-x64.zip')
  const manifest = path.join(temporaryRoot, 'SHASUMS256.txt')
  try {
    fs.writeFileSync(archive, 'not-a-real-archive')
    fs.writeFileSync(manifest, `${'0'.repeat(64)}  ${path.basename(archive)}\n`)
    assert.equal(verifyArchiveChecksum(archive, manifest).status, 'BLOCKED')
    assert.equal(verifyArchiveChecksum(path.join(temporaryRoot, 'missing.zip'), manifest).status, 'BLOCKED')
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('zip traversal is rejected before files are written', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-node-archive-traversal-'))
  const archive = path.join(temporaryRoot, 'node-v22.23.1-win-x64.zip')
  try {
    createStoredZip(archive, [
      { name: 'node-v22.23.1-win-x64/../../escape.txt', content: 'escape' },
    ])
    assert.throws(() => inspectZipArchive(archive), /traversal|unsafe/i)
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'escape.txt')), false)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('a bounded same-root archive is inspected and extracted without path escape', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-node-archive-pass-'))
  const archive = path.join(temporaryRoot, 'node-v22.23.1-win-x64.zip')
  const destination = path.join(temporaryRoot, 'destination')
  try {
    createStoredZip(archive, [
      { name: 'node-v22.23.1-win-x64/node.exe', content: 'MZ-test-fixture' },
      { name: 'node-v22.23.1-win-x64/README.md', content: 'fixture' },
    ])
    const inspection = inspectZipArchive(archive)
    assert.equal(inspection.distributionName, 'node-v22.23.1-win-x64')
    assert.equal(inspection.entries.length, 2)
    const extracted = extractZipArchive(archive, inspection, destination)
    assert.equal(extracted.status, 'PASS')
    assert.equal(
      fs.readFileSync(path.join(destination, 'node-v22.23.1-win-x64', 'README.md'), 'utf8'),
      'fixture',
    )
    assert.equal(fs.existsSync(path.join(temporaryRoot, 'escape.txt')), false)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('gate arguments require full pinned base/head and preserve exact repeated scope', () => {
  const base = 'b263219f34550a5ee44b661af3afb36667dc68d9'
  const head = 'd31049bc09a7aeff8964732ef6950bc4b7cc6089'
  const args = buildGateArguments({
    base,
    head,
    owned: ['scripts/local-release-runtime/**', 'docs/runbooks/local-release-runtime.md'],
    excluded: ['前端代码/src/**'],
  })
  assert.deepEqual(args, [
    '--offline-base=b263219f34550a5ee44b661af3afb36667dc68d9',
    '--owned=scripts/local-release-runtime/**',
    '--owned=docs/runbooks/local-release-runtime.md',
    '--excluded=前端代码/src/**',
  ])
  assert.throws(() => buildGateArguments({ base: 'origin/master', head, owned: ['a'], excluded: ['b'] }), /full 40-character/i)
  assert.throws(() => buildGateArguments({ base, head: 'HEAD', owned: ['a'], excluded: ['b'] }), /full 40-character/i)
})

test('CLI preserves the complete SHA manifest path instead of truncating it', () => {
  const manifest = 'C:\\operator-input\\SHASUMS256.txt'
  const options = parseFlags([`--sha256-manifest=${manifest}`, '--zip=C:\\operator-input\\node-v22.23.1-win-x64.zip'])
  assert.equal(options.sha256Manifest, manifest)
})

test('child PASS/FAIL/BLOCKED and unexpected exits are relayed without swallowing the exit code', () => {
  for (const [exitCode, status] of [[0, 'PASS'], [1, 'FAIL'], [2, 'BLOCKED'], [7, 'FAIL']]) {
    const result = runChildPassthrough(process.execPath, ['-e', `process.exit(${exitCode})`], {
      stdio: 'pipe',
    })
    assert.equal(result.exitCode, exitCode)
    assert.equal(result.status, status)
  }
})

test('Node22 gate child refuses to run without the expected full pinned Git state', () => {
  const sink = { write: () => {} }
  assert.equal(gateChildMain([], {}, { stdout: sink, stderr: sink }), 2)
})

test('scoped Git verification resolves fixed refs while ambient repository redirection is stripped', () => {
  const hostile = createSafeEnvironment({
    PATH: process.env.PATH || '',
    GIT_DIR: 'C:\\hostile\\repository.git',
    GIT_WORK_TREE: 'C:\\hostile\\worktree',
    GIT_COMMON_DIR: 'C:\\hostile\\common',
    GIT_INDEX_FILE: 'C:\\hostile\\index',
    GIT_OBJECT_DIRECTORY: 'C:\\hostile\\objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: 'C:\\hostile\\alternate',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory',
    GIT_CONFIG_VALUE_0: '*',
  })
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
  ]) assert.equal(hostile[key], undefined)

  const safeDirectory = path.resolve(ROOT).split(path.sep).join('/')
  const gitEnvironment = createSafeEnvironment(process.env, {
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  })
  const readRef = (ref) => {
    const result = spawnSync('git', ['-c', `safe.directory=${safeDirectory}`, 'rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: ROOT,
      env: gitEnvironment,
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim().toLowerCase()
  }
  const outcome = verifyPinnedGitState(ROOT, readRef('origin/master'), readRef('HEAD'))
  assert.equal(outcome.status, 'PASS')
})

test('matching official manifest entry verifies by filename and SHA-256', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-node-archive-match-'))
  const archive = path.join(temporaryRoot, 'node-v22.23.1-win-x64.zip')
  const manifest = path.join(temporaryRoot, 'SHASUMS256.txt')
  try {
    fs.writeFileSync(archive, 'fixture archive bytes')
    const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    fs.writeFileSync(manifest, `${hash}  ${path.basename(archive)}\n`)
    const result = verifyArchiveChecksum(archive, manifest)
    assert.equal(result.status, 'PASS')
    assert.equal(result.sha256, hash)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('controlled runtime tree digest detects post-extraction tampering', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-runtime-tree-'))
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'node_modules'), { recursive: true })
    fs.writeFileSync(path.join(temporaryRoot, 'node.exe'), 'MZ-node')
    fs.writeFileSync(path.join(temporaryRoot, 'node_modules', 'npm-cli.js'), 'original')
    const before = canonicalRuntimeTreeDigest(temporaryRoot)
    fs.writeFileSync(path.join(temporaryRoot, 'node_modules', 'npm-cli.js'), 'mutated')
    assert.notEqual(canonicalRuntimeTreeDigest(temporaryRoot), before)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

if (!process.exitCode) process.stdout.write('local-release-runtime selftest: PASS\n')
