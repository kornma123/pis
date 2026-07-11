#!/usr/bin/env node
'use strict'

const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

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

function runScanner(args = [], timeout) {
  return spawnSync(process.execPath, [scanner, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
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

function makeEmptyTarHeader() {
  const header = Buffer.alloc(512)
  header.write('payload.txt', 0, 'ascii')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write('00000000000\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.fill(0x20, 148, 156)
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

function makeEmptyZip() {
  return Buffer.from([
    0x50, 0x4b, 0x05, 0x06,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
  ])
}

function makeZip64Envelope() {
  const record = Buffer.alloc(56)
  Buffer.from([0x50, 0x4b, 0x06, 0x06]).copy(record)
  record.writeBigUInt64LE(44n, 4)
  record.writeUInt16LE(45, 12)
  record.writeUInt16LE(45, 14)
  const locator = Buffer.alloc(20)
  Buffer.from([0x50, 0x4b, 0x06, 0x07]).copy(locator)
  locator.writeBigUInt64LE(0n, 8)
  locator.writeUInt32LE(1, 16)
  const eocd = makeEmptyZip()
  eocd.writeUInt16LE(0xffff, 8)
  eocd.writeUInt16LE(0xffff, 10)
  eocd.writeUInt32LE(0xffffffff, 12)
  eocd.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([record, locator, eocd])
}

function makeZip64RecordEndCollisionEnvelope() {
  // A legal outer Zip64 record may contain arbitrary extensible data. Put a
  // second structurally plausible PK\x06\x06 inside it whose declared end is
  // the same locator offset, but whose central-directory geometry is invalid.
  // The scanner must retain both candidates instead of letting the inner one
  // overwrite the valid outer record in its end-offset index.
  const record = Buffer.alloc(120)
  Buffer.from([0x50, 0x4b, 0x06, 0x06]).copy(record)
  record.writeBigUInt64LE(108n, 4)
  record.writeUInt16LE(45, 12)
  record.writeUInt16LE(45, 14)

  const innerOffset = 60
  Buffer.from([0x50, 0x4b, 0x06, 0x06]).copy(record, innerOffset)
  record.writeBigUInt64LE(48n, innerOffset + 4)
  record.writeUInt16LE(45, innerOffset + 12)
  record.writeUInt16LE(45, innerOffset + 14)
  record.writeBigUInt64LE(1n, innerOffset + 40)

  const locator = Buffer.alloc(20)
  Buffer.from([0x50, 0x4b, 0x06, 0x07]).copy(locator)
  locator.writeBigUInt64LE(0n, 8)
  locator.writeUInt32LE(1, 16)
  const eocd = makeEmptyZip()
  eocd.writeUInt16LE(0xffff, 8)
  eocd.writeUInt16LE(0xffff, 10)
  eocd.writeUInt32LE(0xffffffff, 12)
  eocd.writeUInt32LE(0xffffffff, 16)
  return Buffer.concat([record, locator, eocd])
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
  const jwtVariable = ['JWT', '_SECRET'].join('')
  const publicExample = 'your-jwt-secret-key-change-in-production'
  const formerCiPlaceholder = 'ci-throwaway-not-a-real-secret-do-not-use-in-prod'
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
  stageFixture(
    '后端代码/server/.env.example',
    `${jwtVariable}=${publicExample}\n`,
  )
  try {
    expectStatus(runScanner(), 0, 'only the exact documented backend .env.example placeholder may be tracked')
  } finally {
    removeFixture('后端代码/server/.env.example')
  }
  expectTrackedSecret(
    '.github/workflows/public-placeholder.yml',
    `env:\n  ${jwtVariable}: ${formerCiPlaceholder}\n`,
    'the former public CI placeholder must not be a global scanner exemption',
    'jwt-secret-assignment',
  )
  expectTrackedSecret(
    'docker-compose.yml',
    `services:\n  backend:\n    environment:\n      ${jwtVariable}: ${publicExample}\n`,
    'the example placeholder must be allowed only at its exact documentation path and line',
    'jwt-secret-assignment',
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
  stageFixture('tracked.db', Buffer.from('not-even-a-complete-database'))
  try {
    expectStatus(runScanner(), 2, 'tracked database extensions must fail closed even when their bytes look harmless')
  } finally {
    removeFixture('tracked.db')
  }
  stageFixture(
    'renamed-sqlite.png',
    Buffer.concat([
      Buffer.from('apparently-safe-prefix'),
      Buffer.from('SQLite format 3\0', 'ascii'),
      Buffer.alloc(128),
      Buffer.from('trailing-bytes'),
    ]),
  )
  try {
    expectStatus(runScanner(), 2, 'renaming a SQLite database to a media extension must not bypass the gate')
  } finally {
    removeFixture('renamed-sqlite.png')
  }
  const sqliteHistoryBase = git(['rev-parse', 'HEAD'])
  fs.writeFileSync(
    path.join(repo, 'historical-sqlite.png'),
    Buffer.concat([Buffer.from('prefix'), Buffer.from('SQLite format 3\0', 'ascii'), Buffer.alloc(64)]),
  )
  git(['add', 'historical-sqlite.png'])
  git(['commit', '-qm', 'introduce renamed sqlite payload'])
  fs.rmSync(path.join(repo, 'historical-sqlite.png'))
  git(['add', '-u'])
  git(['commit', '-qm', 'delete renamed sqlite payload'])
  const sqliteHistoryHead = git(['rev-parse', 'HEAD'])
  expectStatus(
    runScanner(['--range', `${sqliteHistoryBase}..${sqliteHistoryHead}`]),
    2,
    'range scanning must fail closed for an embedded SQLite header deleted by a later commit',
  )
  stageFixture('credential.p12', Buffer.from('opaque credential container'))
  try {
    expectStatus(runScanner(), 2, 'opaque credential containers must fail closed')
  } finally {
    removeFixture('credential.p12')
  }
  stageFixture('renamed-archive.png', makeEmptyZip())
  try {
    expectStatus(runScanner(), 2, 'archive magic must fail closed even behind a binary-looking extension')
  } finally {
    removeFixture('renamed-archive.png')
  }

  stageFixture(
    'polyglot.png',
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('apparently-safe-prefix'),
      makeEmptyZip(),
    ]),
  )
  try {
    expectStatus(runScanner(), 2, 'embedded archive magic in a polyglot must fail closed')
  } finally {
    removeFixture('polyglot.png')
  }

  stageFixture(
    'zip-with-trailing-bytes.png',
    Buffer.concat([Buffer.from('prefix'), makeEmptyZip(), Buffer.from('allowed-by-zip-readers')]),
  )
  try {
    expectStatus(runScanner(), 2, 'a structurally valid ZIP with arbitrary prefix and trailing bytes must fail closed')
  } finally {
    removeFixture('zip-with-trailing-bytes.png')
  }

  stageFixture(
    'zip64-with-prefix-and-trailing-bytes.png',
    Buffer.concat([Buffer.from('prefix'), makeZip64Envelope(), Buffer.from('trailing-bytes')]),
  )
  try {
    expectStatus(runScanner(), 2, 'a Zip64 envelope with arbitrary prefix and trailing bytes must fail closed')
  } finally {
    removeFixture('zip64-with-prefix-and-trailing-bytes.png')
  }

  stageFixture(
    'zip64-record-end-collision.png',
    Buffer.concat([Buffer.from('prefix'), makeZip64RecordEndCollisionEnvelope(), Buffer.from('trailing')]),
  )
  try {
    expectStatus(
      runScanner(),
      2,
      'an embedded Zip64 record candidate must not overwrite a valid outer record with the same end offset',
    )
  } finally {
    removeFixture('zip64-record-end-collision.png')
  }

  const zip64SentinelFloodCandidate = Buffer.alloc(22)
  Buffer.from([0x50, 0x4b, 0x05, 0x06]).copy(zip64SentinelFloodCandidate)
  zip64SentinelFloodCandidate.writeUInt16LE(0xffff, 8)
  zip64SentinelFloodCandidate.writeUInt16LE(0xffff, 10)
  zip64SentinelFloodCandidate.writeUInt32LE(0xffffffff, 12)
  zip64SentinelFloodCandidate.writeUInt32LE(0xffffffff, 16)
  const zip64SentinelFlood = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ...Array.from({ length: Math.ceil((1024 * 1024) / zip64SentinelFloodCandidate.length) }, () => (
      zip64SentinelFloodCandidate
    )),
  ]).subarray(0, 1024 * 1024)
  stageFixture('zip64-sentinel-flood.png', zip64SentinelFlood)
  try {
    expectStatus(
      runScanner([], 5000),
      0,
      'many Zip64 sentinel candidates must remain linear and must not become false-positive archives',
    )
  } finally {
    removeFixture('zip64-sentinel-flood.png')
  }

  stageFixture(
    'prefixed-bzip2.png',
    Buffer.concat([
      Buffer.from('apparently-safe-prefix'),
      Buffer.concat([Buffer.from('BZ'), Buffer.from('h91AY&SY')]),
      Buffer.from('opaque-bzip2-payload'),
      Buffer.from('trailing-bytes'),
    ]),
  )
  try {
    expectStatus(runScanner(), 2, 'a bzip2 stream behind an arbitrary prefix must fail closed')
  } finally {
    removeFixture('prefixed-bzip2.png')
  }

  const embeddedArchives = [
    ['7z', Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(26)])],
    ['rar', Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])],
    ['xz', Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.alloc(6)])],
    ['zstd', Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x00, 0x00])])],
    ['lz4', Buffer.concat([Buffer.from([0x04, 0x22, 0x4d, 0x18]), Buffer.from([0x40, 0x40, 0x00])])],
  ]
  for (const [format, header] of embeddedArchives) {
    stageFixture(
      `prefixed-${format}.png`,
      Buffer.concat([Buffer.from('apparently-safe-prefix'), header, Buffer.alloc(32), Buffer.from('trailing-bytes')]),
    )
    try {
      expectStatus(runScanner(), 2, `${format} magic behind an arbitrary prefix must fail closed`)
    } finally {
      removeFixture(`prefixed-${format}.png`)
    }
  }

  stageFixture(
    'prefixed-gzip-with-trailing-bytes.png',
    Buffer.concat([
      Buffer.from('apparently-safe-prefix'),
      zlib.gzipSync(Buffer.from('opaque payload')),
      Buffer.from('trailing-bytes'),
    ]),
  )
  try {
    expectStatus(runScanner(), 2, 'a gzip stream with arbitrary prefix and trailing bytes must fail closed')
  } finally {
    removeFixture('prefixed-gzip-with-trailing-bytes.png')
  }

  const gzipCandidate = Buffer.alloc(24, 0x41)
  Buffer.from([0x1f, 0x8b, 0x08, 0x08]).copy(gzipCandidate)
  stageFixture('gzip-candidate-flood.png', Buffer.concat(Array.from({ length: 5000 }, () => gzipCandidate)))
  try {
    expectStatus(runScanner([], 5000), 2, 'many plausible gzip headers must fail closed without repeated decompression')
  } finally {
    removeFixture('gzip-candidate-flood.png')
  }

  stageFixture(
    'short-magic-is-not-an-archive.png',
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('random-BZh-and-\x1f\x8b-bytes')]),
  )
  try {
    expectStatus(runScanner(), 0, 'short magic inside media must not cause an unvalidated archive false positive')
  } finally {
    removeFixture('short-magic-is-not-an-archive.png')
  }

  stageFixture(
    'prefixed-tar.png',
    Buffer.concat([Buffer.from('apparently-safe-prefix'), makeEmptyTarHeader()]),
  )
  try {
    expectStatus(runScanner(), 2, 'a valid tar header behind an arbitrary prefix must fail closed')
  } finally {
    removeFixture('prefixed-tar.png')
  }

  stageFixture(
    'large-secret.bin',
    Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 123\n'),
  )
  try {
    expectStatus(runScanner(), 2, 'Git LFS pointers must fail closed when payload history is not scanned')
  } finally {
    removeFixture('large-secret.bin')
  }

  stageFixture(
    'large-secret-crlf.bin',
    Buffer.from('version https://git-lfs.github.com/spec/v1\r\noid sha256:' + 'b'.repeat(64) + '\r\nsize 456\r\n'),
  )
  try {
    expectStatus(runScanner(), 2, 'CRLF Git LFS pointers must also fail closed')
  } finally {
    removeFixture('large-secret-crlf.bin')
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

  // Spaces are portable filename bytes; POSIX also permits newlines. Exercise
  // the strongest path supported by the host without making Windows selftests
  // fail before the scanner runs.
  const oddPathBase = git(['rev-parse', 'HEAD'])
  const oddPath = process.platform === 'win32' ? 'space in filename.txt' : 'space and\nnewline.txt'
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
