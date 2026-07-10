#!/usr/bin/env node
'use strict'

const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const scanner = path.resolve(__dirname, 'check-no-secrets.cjs')
const { isHistoricalAllow } = require(scanner)
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-secret-scan-'))
const HISTORICAL_ALLOW_COMMIT = 'a4063fff8046db87d2b0a8eae8833b8d337eb4ed'
const MAX_SCAN_BYTES = 64 * 1024 * 1024
let assertions = 0

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitWithInput(args, input) {
  return execFileSync('git', args, {
    cwd: repo,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function runScanner(args = []) {
  return spawnSync(process.execPath, [scanner, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function assert(condition, message, result) {
  assertions++
  if (!condition) {
    const diagnostic = result
      ? `\nstatus=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`
      : ''
    throw new Error(`${message}${diagnostic}`)
  }
}

function expectStatus(result, status, message) {
  assert(result.status === status, message, result)
}

function stageFixture(file, content) {
  const absolute = path.join(repo, file)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
  git(['add', '--', file])
  return absolute
}

function removeFixture(file) {
  git(['reset', '-q', 'HEAD', '--', file])
  fs.rmSync(path.join(repo, file), { recursive: true, force: true })
}

function expectTrackedSecret(file, content, message, expectedRule) {
  stageFixture(file, content)
  try {
    const result = runScanner()
    expectStatus(result, 1, message)
    if (expectedRule) {
      assert(result.stderr.includes(expectedRule), `${message}: should report ${expectedRule}`, result)
    }
  } finally {
    removeFixture(file)
  }
}

try {
  git(['init', '-q'])
  git(['config', 'user.name', 'secret-scan-selftest'])
  git(['config', 'user.email', 'secret-scan@example.invalid'])

  fs.writeFileSync(path.join(repo, 'clean.txt'), 'clean\n')
  git(['add', 'clean.txt'])
  git(['commit', '-qm', 'base'])
  const base = git(['rev-parse', 'HEAD'])
  const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])

  const fakeKey = `sk-kimi-${'A'.repeat(48)}`
  fs.writeFileSync(path.join(repo, 'transient.txt'), `${fakeKey}\n`)
  git(['add', 'transient.txt'])
  git(['commit', '-qm', 'introduce fake secret'])
  fs.rmSync(path.join(repo, 'transient.txt'))
  git(['add', '-u'])
  git(['commit', '-qm', 'delete fake secret'])
  const head = git(['rev-parse', 'HEAD'])

  const finalTreeOnly = runScanner()
  expectStatus(finalTreeOnly, 0, 'final clean tree should pass')

  const historyAware = runScanner(['--range', `${base}..${head}`])
  expectStatus(historyAware, 1, 'range scan must catch a secret deleted by a later commit')
  assert(historyAware.stderr.includes('kimi-api-key'), 'range scan should report the matching rule', historyAware)

  // Merge commit introduces a secret (conflict-resolution style), a later commit deletes it.
  // Final tree is clean; only `diff-tree -m` surfaces the secret inside the merge commit.
  git(['checkout', '-q', '-b', 'sidebranch', base])
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'side\n')
  git(['add', 'shared.txt'])
  git(['commit', '-qm', 'side branch file'])
  git(['checkout', '-q', mainBranch])
  fs.writeFileSync(path.join(repo, 'mainonly.txt'), 'main\n')
  git(['add', 'mainonly.txt'])
  git(['commit', '-qm', 'main branch file'])
  const preMerge = git(['rev-parse', 'HEAD'])
  git(['merge', '--no-commit', '--no-ff', 'sidebranch'])
  fs.writeFileSync(path.join(repo, 'leaked-in-merge.txt'), `${fakeKey}\n`)
  git(['add', 'leaked-in-merge.txt'])
  git(['commit', '-qm', 'merge resolution introduces secret'])
  fs.rmSync(path.join(repo, 'leaked-in-merge.txt'))
  git(['add', '-u'])
  git(['commit', '-qm', 'delete secret added in merge'])
  const mergeHead = git(['rev-parse', 'HEAD'])
  const mergeScan = runScanner(['--range', `${preMerge}..${mergeHead}`])
  expectStatus(mergeScan, 1, 'range scan must catch a secret introduced by a merge commit and deleted later')
  assert(mergeScan.stderr.includes('kimi-api-key'), 'merge-range scan should report the matching rule', mergeScan)

  expectTrackedSecret('.env.example', `${fakeKey}\n`, '.env.example must be scanned', 'kimi-api-key')
  expectTrackedSecret('dependencies.lock', `${fakeKey}\n`, 'text lockfiles must not be an unconditional bypass', 'kimi-api-key')
  expectTrackedSecret('bypass.txt', `${fakeKey} // secret-scan:allow\n`, 'allow marker must not bypass checks outside the historical line')
  expectTrackedSecret(
    '后端代码/server/src/middleware/auth.ts',
    `const fresh = '${fakeKey}' // secret-scan:allow\n`,
    'a new auth.ts line must not inherit the historical allow marker',
  )
  expectTrackedSecret(
    'evil-scripts/check-no-secrets.cjs',
    `${fakeKey}\n`,
    'a path that merely ends in scripts/check-no-secrets.cjs must still be scanned',
    'kimi-api-key',
  )

  // The root scanner contains exact rule-definition lines, but the rest of that file must
  // still be scanned. Appending an unrelated credential may not inherit a whole-file skip.
  stageFixture('scripts/check-no-secrets.cjs', `${fakeKey}\n`)
  try {
    const rootScannerSecret = runScanner()
    expectStatus(rootScannerSecret, 1, 'the root scanner file must not be a whole-file bypass')
    assert(rootScannerSecret.stderr.includes('kimi-api-key'), 'root scanner secret should report the matching rule', rootScannerSecret)
  } finally {
    removeFixture('scripts/check-no-secrets.cjs')
  }

  stageFixture('opaque.zip', Buffer.from('PK\x03\x04compressed fixture'))
  try {
    expectStatus(runScanner(), 2, 'an archive that is not safely unpacked must fail closed')
  } finally {
    removeFixture('opaque.zip')
  }
  stageFixture('renamed-archive.png', Buffer.from('PK\x03\x04compressed fixture'))
  try {
    expectStatus(runScanner(), 2, 'archive magic must fail closed even behind a binary-looking extension')
  } finally {
    removeFixture('renamed-archive.png')
  }

  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${fakeKey}\r\n`, 'utf16le')])
  expectTrackedSecret('encoded-le.ps1', utf16le, 'UTF-16LE with BOM must be decoded and scanned', 'kimi-api-key')

  const utf16beText = Buffer.from(`${fakeKey}\n`, 'utf16le')
  for (let i = 0; i < utf16beText.length; i += 2) {
    ;[utf16beText[i], utf16beText[i + 1]] = [utf16beText[i + 1], utf16beText[i]]
  }
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beText])
  expectTrackedSecret('encoded-be.ps1', utf16be, 'UTF-16BE with BOM must be decoded and scanned', 'kimi-api-key')

  const nulInjected = Buffer.from(`${fakeKey.slice(0, 18)}\0${fakeKey.slice(18)}\n`, 'utf8')
  expectTrackedSecret('nul-injected.txt', nulInjected, 'NUL injection must not turn text into an unconditional bypass', 'kimi-api-key')
  expectTrackedSecret(
    'nul-injected.png',
    nulInjected,
    'NUL injection inside a known binary extension must not split an ASCII token',
    'kimi-api-key',
  )

  // A strict GB18030 fallback may legally consume a leading high byte together with
  // the first ASCII token byte. The raw ASCII view must still retain the complete key.
  const gb18030Prefix = Buffer.concat([Buffer.from([0x81]), Buffer.from(`${fakeKey}\n`, 'ascii')])
  expectTrackedSecret(
    'gb18030-prefix.txt',
    gb18030Prefix,
    'GB18030 fallback must not swallow the first byte of an adjacent ASCII credential',
    'kimi-api-key',
  )

  // A complete compact JWT must be caught even when its signature does not resemble a vendor API key.
  const fakeJwt = [
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZha2UgVXNlciIsImlhdCI6MTUxNjIzOTAyMn0',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ].join('.')
  expectTrackedSecret('token.txt', `${fakeJwt}\n`, 'a complete compact JWT must be detected', 'compact-jwt')

  const fakeJwtSecret = '7Ab9C2d4E6f80135'.repeat(4)
  expectTrackedSecret(
    'runtime.env',
    `JWT_SECRET=${fakeJwtSecret}\n`,
    'a high-entropy literal JWT_SECRET assignment must be detected',
    'jwt-secret-assignment',
  )
  expectTrackedSecret(
    'hardcoded-runtime.js',
    `process.env.JWT_SECRET = '${fakeJwtSecret}'\n`,
    'a literal process.env.JWT_SECRET assignment must be detected',
    'jwt-secret-assignment',
  )
  expectTrackedSecret(
    'misleading-name.env',
    `JWT_SECRET=test-fake-${fakeJwtSecret}\n`,
    'keywords such as test/fake must not exempt an otherwise secret-like literal',
    'jwt-secret-assignment',
  )
  const lowEntropyJwtSecret = 'ab'.repeat(16)
  expectTrackedSecret(
    'low-entropy.env',
    `JWT_SECRET=${lowEntropyJwtSecret}\n`,
    'a non-placeholder JWT_SECRET literal of 32 characters must be detected regardless of entropy',
    'jwt-secret-assignment',
  )

  // Invalid text must fail closed instead of being decoded with replacement characters.
  stageFixture('invalid-encoding.txt', Buffer.from([0xff, 0xff, 0xff]))
  try {
    expectStatus(runScanner(), 2, 'undecodable tracked content must fail closed')
  } finally {
    removeFixture('invalid-encoding.txt')
  }

  // A tracked path that cannot be read must fail closed. Replacing it with a directory is
  // deterministic across CI users, unlike chmod-based tests that root can bypass.
  const unreadable = stageFixture('read-failure.txt', 'clean\n')
  fs.rmSync(unreadable)
  fs.mkdirSync(unreadable)
  try {
    expectStatus(runScanner(), 2, 'a tracked path read failure must fail closed')
  } finally {
    removeFixture('read-failure.txt')
  }

  // A sparse file makes the over-limit test cheap: stat must reject it before allocating 65 MiB.
  const oversized = path.join(repo, 'oversized.txt')
  const oversizedFd = fs.openSync(oversized, 'w')
  fs.ftruncateSync(oversizedFd, MAX_SCAN_BYTES + 1)
  fs.closeSync(oversizedFd)
  git(['add', '--', 'oversized.txt'])
  try {
    expectStatus(runScanner(), 2, 'tracked content over the scan limit must fail closed')
  } finally {
    removeFixture('oversized.txt')
  }

  // Invalid UTF-8 in a Git path used to be decoded to U+FFFD and then re-read via commit:path,
  // which silently missed the blob. The raw object id must drive range reads instead.
  const rawBase = git(['rev-parse', 'HEAD'])
  const secretBlob = gitWithInput(['hash-object', '-w', '--stdin'], `${fakeKey}\n`)
  const invalidName = Buffer.concat([Buffer.from('invalid-'), Buffer.from([0xff]), Buffer.from('.txt')])
  const rawTreeRecord = Buffer.concat([
    Buffer.from(`100644 blob ${secretBlob}\t`),
    invalidName,
    Buffer.from([0]),
  ])
  const rawTree = gitWithInput(['mktree', '-z'], rawTreeRecord)
  const rawSecretCommit = git(['commit-tree', rawTree, '-p', rawBase, '-m', 'secret under non-utf8 path'])
  const emptyTree = gitWithInput(['mktree'], '')
  const rawHead = git(['commit-tree', emptyTree, '-p', rawSecretCommit, '-m', 'delete non-utf8 path'])
  const rawPathScan = runScanner(['--range', `${rawBase}..${rawHead}`])
  expectStatus(rawPathScan, 1, 'range scan must read changed content by raw blob id, not decoded path')
  assert(rawPathScan.stderr.includes('kimi-api-key'), 'raw-path range scan should report the matching rule', rawPathScan)

  // Spaces and newlines are valid filename bytes and must remain supported.
  const oddPathBase = git(['rev-parse', 'HEAD'])
  const oddPath = 'space and\nnewline.txt'
  fs.writeFileSync(path.join(repo, oddPath), `${fakeKey}\n`)
  git(['add', '--', oddPath])
  git(['commit', '-qm', 'secret under odd path'])
  fs.rmSync(path.join(repo, oddPath))
  git(['add', '-u'])
  git(['commit', '-qm', 'delete odd path'])
  const oddPathHead = git(['rev-parse', 'HEAD'])
  expectStatus(
    runScanner(['--range', `${oddPathBase}..${oddPathHead}`]),
    1,
    'range scan must preserve spaces and newlines in paths',
  )

  // Rename handling remains covered while raw diff records replace commit:path lookups.
  fs.writeFileSync(path.join(repo, 'before-rename.txt'), 'clean\n')
  git(['add', 'before-rename.txt'])
  git(['commit', '-qm', 'rename base'])
  const renameBase = git(['rev-parse', 'HEAD'])
  git(['mv', 'before-rename.txt', 'after rename.txt'])
  fs.writeFileSync(path.join(repo, 'after rename.txt'), `${fakeKey}\n`)
  git(['add', 'after rename.txt'])
  git(['commit', '-qm', 'rename introduces secret'])
  fs.rmSync(path.join(repo, 'after rename.txt'))
  git(['add', '-u'])
  git(['commit', '-qm', 'delete renamed secret'])
  const renameHead = git(['rev-parse', 'HEAD'])
  expectStatus(runScanner(['--range', `${renameBase}..${renameHead}`]), 1, 'range scan must keep rename coverage')

  // The only auth.ts marker exceptions are exact denylist lines in PR #119's initial
  // commit. Build the compromised values at runtime so this selftest is itself clean.
  // This pure-function check does not depend on the historical Git object remaining
  // reachable after a future squash, rebase, or branch deletion.
  const historicalPath = Buffer.from('后端代码/server/src/middleware/auth.ts')
  const historicalSource = { kind: 'commit', commit: HISTORICAL_ALLOW_COMMIT }
  const historicalV1 = `  '${['coreone-jwt', '-secret-key-2024'].join('')}', // secret-scan:allow 已泄露的历史签名密钥（此处为拒绝清单，非泄露）`
  const historicalV0 = `  '${['coreone', '-secret-key-2024'].join('')}', // secret-scan:allow 更早的硬编码回退密钥（已移除，一并拒绝）`
  assert(
    isHistoricalAllow(historicalPath, historicalV1, 'leaked-jwt-secret-v1', historicalSource),
    'the exact v1 historical denylist line should be allowed only in its immutable commit',
  )
  assert(
    isHistoricalAllow(historicalPath, historicalV0, 'leaked-jwt-secret-v0', historicalSource),
    'the exact v0 historical denylist line should be allowed only in its immutable commit',
  )
  assert(
    !isHistoricalAllow(historicalPath, historicalV1, 'leaked-jwt-secret-v1', { kind: 'commit', commit: '0'.repeat(40) }),
    'the same historical line in another commit must not be allowed',
  )
  assert(
    !isHistoricalAllow(historicalPath, `${historicalV1} changed`, 'leaked-jwt-secret-v1', historicalSource),
    'a changed historical line must not be allowed',
  )
  assert(
    !isHistoricalAllow(Buffer.from('other/auth.ts'), historicalV1, 'leaked-jwt-secret-v1', historicalSource),
    'the historical line at another path must not be allowed',
  )
  assert(
    !isHistoricalAllow(historicalPath, historicalV1, 'leaked-jwt-secret-v1', { kind: 'working-tree' }),
    'the current working tree must never inherit the historical marker allow',
  )

  console.log(`secret-scan selftest passed: ${assertions}/${assertions}`)
} finally {
  fs.rmSync(repo, { recursive: true, force: true })
}
