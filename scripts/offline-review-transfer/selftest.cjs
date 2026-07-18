#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CLI = path.join(__dirname, 'cli.cjs')
const FILTER = process.env.OFFLINE_REVIEW_SELFTEST_FILTER || ''
const ORIGIN = 'https://example.invalid/coreone/offline-review-fixture.git'
let checksRun = 0
let checksPassed = 0
let failures = 0

function check(name, fn) {
  if (FILTER && !name.includes(FILTER)) return
  checksRun += 1
  try {
    fn()
    checksPassed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  ❌ ${name}\n       ${error.stack || error.message}`)
  }
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim()
}

function write(root, relative, content) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  })
}

function expectOk(result, message) {
  assert.equal(result.status, 0, `${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
}

function expectFail(result, message, needle) {
  assert.notEqual(result.status, 0, `${message}: command unexpectedly succeeded\n${result.stdout}`)
  if (needle) {
    const combined = `${result.stdout}\n${result.stderr}`
    assert.match(combined, needle, `${message}: expected diagnostic ${needle}\n${combined}`)
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), 'test canonical JSON only accepts finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  assert.equal(typeof value, 'object')
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function rewriteManifest(packageDir, mutate) {
  const manifestFile = path.join(packageDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  mutate(manifest)
  fs.writeFileSync(manifestFile, canonicalJson(manifest))
  rewriteChecksums(packageDir)
  return manifest
}

function rewriteChecksums(packageDir) {
  const bundle = sha256File(path.join(packageDir, 'delivery.bundle'))
  const manifest = sha256File(path.join(packageDir, 'manifest.json'))
  fs.writeFileSync(path.join(packageDir, 'SHA256SUMS'), `${bundle}  delivery.bundle\n${manifest}  manifest.json\n`, 'ascii')
}

function updateBundleMetadata(packageDir) {
  rewriteManifest(packageDir, (manifest) => {
    const bundle = path.join(packageDir, 'delivery.bundle')
    manifest.bundle.bytes = fs.statSync(bundle).size
    manifest.bundle.sha256 = sha256File(bundle)
  })
}

function packageFiles(packageDir) {
  return fs.readdirSync(packageDir).sort()
}

function setupPair(label = 'pair') {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `coreone-offline-review-${label}-`))
  const sender = path.join(root, 'sender')
  const receiver = path.join(root, 'receiver')

  execFileSync('git', ['init', '-q', '-b', 'master', sender])
  git(sender, ['config', 'user.name', 'offline-review-sender'])
  git(sender, ['config', 'user.email', 'sender@example.invalid'])
  write(sender, 'README.md', '# fixture\n')
  git(sender, ['add', '--', 'README.md'])
  git(sender, ['commit', '-q', '-m', 'chore: fixture base'])
  const base = git(sender, ['rev-parse', 'HEAD'])
  git(sender, ['remote', 'add', 'origin', ORIGIN])
  git(sender, ['update-ref', 'refs/remotes/origin/master', base])

  execFileSync('git', ['clone', '-q', sender, receiver])
  git(receiver, ['config', 'user.name', 'offline-review-receiver'])
  git(receiver, ['config', 'user.email', 'receiver@example.invalid'])
  git(receiver, ['remote', 'set-url', 'origin', ORIGIN])
  git(receiver, ['update-ref', 'refs/remotes/origin/master', base])

  git(sender, ['switch', '-q', '-c', 'feature'])
  write(sender, 'src/feature.txt', 'fixed-head feature\n')
  git(sender, ['add', '--', 'src/feature.txt'])
  git(sender, ['commit', '-q', '-m', 'feat: fixed head fixture'])
  const head = git(sender, ['rev-parse', 'HEAD'])

  return { root, sender, receiver, base, head }
}

function exportPackage(repo, base, head, out) {
  return runCli(['export', '--repo', repo, '--base', base, '--head', head, '--out', out], repo)
}

function importPackage(repo, packageDir, reviewOut) {
  return runCli(['verify-import', '--repo', repo, '--package', packageDir, '--review-out', reviewOut], repo)
}

function copyPackage(source, destination) {
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true })
}

function readManifest(packageDir) {
  return JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'))
}

function snapshotRepo(repo) {
  const fetchHead = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])
  return {
    head: git(repo, ['rev-parse', 'HEAD']),
    status: git(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
    refs: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)']),
    objects: git(repo, ['count-objects', '-v']),
    fetchHead: fs.existsSync(fetchHead) ? fs.readFileSync(fetchHead).toString('base64') : null,
  }
}

function expectRejectedWithoutWrites(repo, packageDir, reviewOut, message, needle) {
  const before = snapshotRepo(repo)
  const result = importPackage(repo, packageDir, reviewOut)
  expectFail(result, message, needle)
  assert.deepEqual(snapshotRepo(repo), before, `${message}: target repository changed on rejection`)
  assert.equal(fs.existsSync(reviewOut), false, `${message}: review output must not be materialized`)
}

function withPair(label, fn) {
  const fixture = setupPair(label)
  try {
    fn(fixture)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
}

console.log(`offline review transfer · selftest${FILTER ? ` · filter=${JSON.stringify(FILTER)}` : ''}`)

check('clean export -> transfer copy -> isolated import -> structured findings return', () => {
  withPair('roundtrip', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    const transferred = path.join(root, 'transferred')
    const reviewOut = path.join(root, 'review-material')
    const findingsInput = path.join(root, 'findings.completed.json')
    const findingsOut = path.join(root, 'findings-outbound')
    const findingsCopy = path.join(root, 'findings-transferred')

    const exported = exportPackage(sender, base, head, outbound)
    expectOk(exported, 'clean export should succeed')
    assert.deepEqual(packageFiles(outbound), ['SHA256SUMS', 'delivery.bundle', 'manifest.json'])
    copyPackage(outbound, transferred)

    const imported = importPackage(receiver, transferred, reviewOut)
    expectOk(imported, 'verified import should succeed')
    const manifest = readManifest(transferred)
    assert.equal(git(receiver, ['rev-parse', manifest.range.reviewRef]), head)
    assert.equal(git(receiver, ['rev-parse', 'HEAD']), base, 'import must not checkout the delivered head')
    assert.equal(fs.existsSync(path.join(receiver, 'src', 'feature.txt')), false, 'import must not alter the worktree')
    assert.deepEqual(packageFiles(reviewOut), ['findings.template.json', 'review-instructions.md'])

    const findings = JSON.parse(fs.readFileSync(path.join(reviewOut, 'findings.template.json'), 'utf8'))
    assert.equal(findings.status, 'NOT_REVIEWED')
    findings.status = 'COMPLETED'
    findings.verdict = 'PASS'
    findings.reviewer.identity = 'Claude device 2 manual session'
    findings.reviewer.model = 'claude-manual'
    findings.reviewer.independence = 'Did not participate in implementation; reviewed the fixed review ref.'
    findings.reviewedAt = new Date().toISOString()
    findings.evidence = ['Manual fixed-SHA diff inspection on the isolated review ref.']
    findings.unverifiedBoundaries = ['No production, network, or real database validation was attempted.']
    fs.writeFileSync(findingsInput, JSON.stringify(findings, null, 2))

    const sealed = runCli(['seal-findings', '--package', transferred, '--input', findingsInput, '--out', findingsOut], receiver)
    expectOk(sealed, 'completed manual findings should seal')
    assert.deepEqual(packageFiles(findingsOut), ['SHA256SUMS', 'findings.json'])
    copyPackage(findingsOut, findingsCopy)
    const verified = runCli(['verify-findings', '--package', outbound, '--return', findingsCopy], sender)
    expectOk(verified, 'returned findings should verify against the original delivery')
  })
})

check('export fails closed for untracked, worktree, or index dirt', () => {
  withPair('dirty', ({ root, sender, base, head }) => {
    write(sender, 'untracked.txt', 'dirty\n')
    let out = path.join(root, 'dirty-untracked')
    expectFail(exportPackage(sender, base, head, out), 'untracked dirt must block export', /clean|dirty/i)
    assert.equal(fs.existsSync(out), false)
    fs.rmSync(path.join(sender, 'untracked.txt'))

    fs.appendFileSync(path.join(sender, 'src', 'feature.txt'), 'worktree dirt\n')
    out = path.join(root, 'dirty-worktree')
    expectFail(exportPackage(sender, base, head, out), 'worktree dirt must block export', /clean|dirty/i)
    assert.equal(fs.existsSync(out), false)
    git(sender, ['restore', '--worktree', '--', 'src/feature.txt'])

    write(sender, 'staged.txt', 'index dirt\n')
    git(sender, ['add', '--', 'staged.txt'])
    out = path.join(root, 'dirty-index')
    expectFail(exportPackage(sender, base, head, out), 'index dirt must block export', /clean|dirty/i)
    assert.equal(fs.existsSync(out), false)
  })
})

check('wrong cached base is rejected with zero target writes', () => {
  withPair('wrong-base', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    write(receiver, 'receiver-only.txt', 'different cached base\n')
    git(receiver, ['add', '--', 'receiver-only.txt'])
    git(receiver, ['commit', '-q', '-m', 'chore: receiver-only anchor'])
    const wrongBase = git(receiver, ['rev-parse', 'HEAD'])
    git(receiver, ['update-ref', 'refs/remotes/origin/master', wrongBase])
    expectRejectedWithoutWrites(receiver, outbound, path.join(root, 'review-out'), 'wrong base', /base|origin\/master/i)
  })
})

check('wrong repository identity is rejected with zero target writes', () => {
  withPair('wrong-repo', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    git(receiver, ['remote', 'set-url', 'origin', 'https://example.invalid/other/repository.git'])
    expectRejectedWithoutWrites(receiver, outbound, path.join(root, 'review-out'), 'wrong repository', /identity|repository/i)
  })
})

check('bundle byte tamper is rejected before target writes', () => {
  withPair('tamper', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    const tampered = path.join(root, 'tampered')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    copyPackage(outbound, tampered)
    const bundle = path.join(tampered, 'delivery.bundle')
    const bytes = fs.readFileSync(bundle)
    bytes[bytes.length - 1] ^= 0xff
    fs.writeFileSync(bundle, bytes)
    expectRejectedWithoutWrites(receiver, tampered, path.join(root, 'review-out'), 'tampered bundle', /sha-?256|hash|checksum/i)
  })
})

check('manifest traversal with recomputed checksum is rejected before target writes', () => {
  withPair('traversal', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    const tampered = path.join(root, 'traversal-package')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    copyPackage(outbound, tampered)
    rewriteManifest(tampered, (manifest) => {
      manifest.range.files[0].path = '../escape.txt'
    })
    expectRejectedWithoutWrites(receiver, tampered, path.join(root, 'review-out'), 'path traversal', /path|traversal|unsafe/i)
    assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false)
  })
})

check('non-canonical manifest and extra package files are rejected', () => {
  withPair('format', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')

    const noncanonical = path.join(root, 'noncanonical')
    copyPackage(outbound, noncanonical)
    const manifest = readManifest(noncanonical)
    fs.writeFileSync(path.join(noncanonical, 'manifest.json'), JSON.stringify(manifest, null, 2))
    rewriteChecksums(noncanonical)
    expectRejectedWithoutWrites(receiver, noncanonical, path.join(root, 'review-a'), 'non-canonical manifest', /canonical|format/i)

    const extra = path.join(root, 'extra')
    copyPackage(outbound, extra)
    write(extra, 'notes.txt', 'unexpected\n')
    expectRejectedWithoutWrites(receiver, extra, path.join(root, 'review-b'), 'extra artifact', /extra|exact|artifact|package/i)

    const oversized = path.join(root, 'oversized')
    copyPackage(outbound, oversized)
    fs.writeFileSync(path.join(oversized, 'manifest.json'), Buffer.alloc(1024 * 1024 + 1, 0x20))
    rewriteChecksums(oversized)
    expectRejectedWithoutWrites(receiver, oversized, path.join(root, 'review-c'), 'oversized manifest', /size|limit|manifest/i)
  })
})

check('bundle advertising a wrong head is rejected before target writes', () => {
  withPair('wrong-head', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    const malicious = path.join(root, 'wrong-head-package')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    copyPackage(outbound, malicious)
    write(sender, 'src/second.txt', 'unexpected head\n')
    git(sender, ['add', '--', 'src/second.txt'])
    git(sender, ['commit', '-q', '-m', 'feat: unexpected second head'])
    fs.rmSync(path.join(malicious, 'delivery.bundle'))
    git(sender, ['bundle', 'create', path.join(malicious, 'delivery.bundle'), 'HEAD', `^${base}`])
    updateBundleMetadata(malicious)
    expectRejectedWithoutWrites(receiver, malicious, path.join(root, 'review-out'), 'wrong bundle head', /head|advertised|bundle/i)
  })
})

check('bundle with an extra advertised ref is rejected before target writes', () => {
  withPair('extra-ref', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    const malicious = path.join(root, 'extra-ref-package')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    copyPackage(outbound, malicious)
    git(sender, ['update-ref', 'refs/heads/extra-advertised-ref', head])
    fs.rmSync(path.join(malicious, 'delivery.bundle'))
    git(sender, ['bundle', 'create', path.join(malicious, 'delivery.bundle'), 'HEAD', 'refs/heads/extra-advertised-ref', `^${base}`])
    updateBundleMetadata(malicious)
    expectRejectedWithoutWrites(receiver, malicious, path.join(root, 'review-out'), 'extra advertised ref', /extra|advertised|ref/i)
  })
})

check('existing review ref is never force-overwritten', () => {
  withPair('collision', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    const manifest = readManifest(outbound)
    git(receiver, ['update-ref', manifest.range.reviewRef, base])
    expectRejectedWithoutWrites(receiver, outbound, path.join(root, 'review-out'), 'review ref collision', /collision|exists|overwrite|ref/i)
    assert.equal(git(receiver, ['rev-parse', manifest.range.reviewRef]), base)
  })
})

check('dangerous paths and secret-bearing commits block export', () => {
  withPair('dangerous', ({ root, sender, base }) => {
    write(sender, '.env', 'SAFE_LOOKING_PLACEHOLDER=not-a-secret\n')
    git(sender, ['add', '--', '.env'])
    git(sender, ['commit', '-q', '-m', 'test: dangerous path'])
    let head = git(sender, ['rev-parse', 'HEAD'])
    let out = path.join(root, 'dangerous-out')
    expectFail(exportPackage(sender, base, head, out), 'dangerous path must block export', /dangerous|unsafe|\.env|path/i)
    assert.equal(fs.existsSync(out), false)

    git(sender, ['rm', '-q', '--', '.env'])
    write(sender, 'src/credential.txt', `github_pat_${'A'.repeat(40)}\n`)
    git(sender, ['add', '--', 'src/credential.txt'])
    git(sender, ['commit', '-q', '-m', 'test: secret scanner fixture'])
    head = git(sender, ['rev-parse', 'HEAD'])
    out = path.join(root, 'secret-out')
    expectFail(exportPackage(sender, base, head, out), 'secret must block export', /secret|github-token|credential/i)
    assert.equal(fs.existsSync(out), false)
  })
  withPair('metadata-secret', ({ root, sender, base }) => {
    write(sender, 'src/metadata-secret-fixture.txt', 'harmless blob\n')
    git(sender, ['add', '--', 'src/metadata-secret-fixture.txt'])
    git(sender, ['commit', '-q', '-m', `test: metadata github_pat_${'B'.repeat(40)}`])
    const head = git(sender, ['rev-parse', 'HEAD'])
    const out = path.join(root, 'metadata-secret-out')
    expectFail(exportPackage(sender, base, head, out), 'commit metadata secret must block export', /secret|github-token|metadata/i)
    assert.equal(fs.existsSync(out), false)
  })
})

check('non-linear merge history is rejected by the single-chain contract', () => {
  withPair('merge', ({ root, sender, base }) => {
    git(sender, ['switch', '-q', '-c', 'side', base])
    write(sender, 'src/side.txt', 'side\n')
    git(sender, ['add', '--', 'src/side.txt'])
    git(sender, ['commit', '-q', '-m', 'feat: side'])
    git(sender, ['switch', '-q', 'feature'])
    git(sender, ['merge', '-q', '--no-ff', 'side', '-m', 'merge: forbidden merge fixture'])
    const mergeHead = git(sender, ['rev-parse', 'HEAD'])
    const out = path.join(root, 'merge-out')
    expectFail(exportPackage(sender, base, mergeHead, out), 'merge commits must block export', /linear|single|merge|ancestor/i)
    assert.equal(fs.existsSync(out), false)
  })
})

check('tampered returned findings fail checksum verification', () => {
  withPair('findings-tamper', ({ root, sender, receiver, base, head }) => {
    const outbound = path.join(root, 'outbound')
    const reviewOut = path.join(root, 'review-out')
    const input = path.join(root, 'findings.completed.json')
    const sealedOut = path.join(root, 'sealed')
    expectOk(exportPackage(sender, base, head, outbound), 'fixture export')
    expectOk(importPackage(receiver, outbound, reviewOut), 'fixture import')
    const findings = JSON.parse(fs.readFileSync(path.join(reviewOut, 'findings.template.json'), 'utf8'))
    findings.status = 'COMPLETED'
    findings.verdict = 'PASS'
    findings.reviewer.identity = 'Claude manual session'
    findings.reviewer.model = 'claude-manual'
    findings.reviewer.independence = 'Independent fixed-ref review.'
    findings.reviewedAt = new Date().toISOString()
    findings.evidence = ['Manual review evidence.']
    findings.unverifiedBoundaries = ['No production or network validation was attempted.']
    fs.writeFileSync(input, JSON.stringify(findings, null, 2))
    expectOk(runCli(['seal-findings', '--package', outbound, '--input', input, '--out', sealedOut], receiver), 'seal fixture')
    fs.appendFileSync(path.join(sealedOut, 'findings.json'), ' ')
    expectFail(runCli(['verify-findings', '--package', outbound, '--return', sealedOut], sender), 'tampered findings must fail', /sha-?256|hash|checksum/i)
  })
})

console.log(`\n${checksPassed}/${checksRun} checks passed`)
if (failures) process.exitCode = 1
