#!/usr/bin/env node

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const GATE = path.join(__dirname, 'local-release-gate.cjs')

// RED first: the gate module does not exist until the implementation step.
const {
  DEFAULT_E2E_SPECS,
  MINIMUM_LOCAL_RELEASE_NODE_VERSION,
  RECEIPT_SCHEMA_VERSION,
  REQUIRED_PREFLIGHT_CHECKS,
  REQUIRED_NODE_MAJOR,
  buildCanonicalGateReceipt,
  buildPlan,
  canonicalJson,
  canonicalAuthorityDigest,
  classifyDockerVersionResult,
  classifyDependencyCheck,
  classifyPreflightReport,
  classifySpawnResult,
  classifySecretScanResult,
  compareGitState,
  createReleaseEnvironment,
  createSelftestEnvironment,
  evaluateCriticalTests,
  executePlan,
  normalizeNewlines,
  overallExitCode,
  resolveNpmCli,
  runCommittedScope,
  runDockerDaemonCheck,
  runE2eSpecContract,
  validateReceiptTarget,
  validateBrowserExecutable,
  validateBrowsersPath,
  verifyCanonicalGateReceipt,
  writeCanonicalReceiptAtomic,
} = require(GATE)

function test(name, fn) {
  try {
    fn()
    process.stdout.write(`  PASS ${name}\n`)
  } catch (error) {
    process.stderr.write(`  FAIL ${name}\n${error.stack || error.message}\n`)
    process.exitCode = 1
  }
}

const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex')
const RECEIPT_BASE_SHA = '1'.repeat(40)
const RECEIPT_HEAD_SHA = '2'.repeat(40)
const RECEIPT_TREE_SHA = '3'.repeat(40)
const RECEIPT_TOOL_SHA256 = '4'.repeat(64)
const RECEIPT_ALLOWLIST_SHA256 = '5'.repeat(64)
const RECEIPT_NONCE = '6'.repeat(64)
const RECEIPT_ITEM_IDS = Object.freeze([
  'runtime:node',
  'runtime:npm',
  'e2e:browser',
  'runtime:docker-daemon',
])

function receiptInput(overrides = {}) {
  const input = {
    repository: {
      baseSha: RECEIPT_BASE_SHA,
      headSha: RECEIPT_HEAD_SHA,
      headTreeSha: RECEIPT_TREE_SHA,
      commits: [RECEIPT_HEAD_SHA],
    },
    gateToolSha256: RECEIPT_TOOL_SHA256,
    allowlistConfigSha256: RECEIPT_ALLOWLIST_SHA256,
    deliveryId: '11111111-1111-4111-8111-111111111111',
    nonce: RECEIPT_NONCE,
    gateExitCode: 0,
    planItemIds: [...RECEIPT_ITEM_IDS],
    results: [
      {
        id: 'runtime:node',
        status: 'PASS',
        exitCode: 0,
        durationMs: 11,
        stdoutSha256: EMPTY_SHA256,
        stderrSha256: EMPTY_SHA256,
      },
      {
        id: 'runtime:npm',
        status: 'PASS',
        exitCode: 0,
        durationMs: 12,
        stdoutSha256: EMPTY_SHA256,
        stderrSha256: EMPTY_SHA256,
      },
      {
        id: 'e2e:browser',
        status: 'PASS',
        exitCode: null,
        durationMs: 13,
        stdoutSha256: EMPTY_SHA256,
        stderrSha256: EMPTY_SHA256,
      },
      {
        id: 'runtime:docker-daemon',
        status: 'PASS',
        exitCode: 0,
        durationMs: 14,
        stdoutSha256: EMPTY_SHA256,
        stderrSha256: EMPTY_SHA256,
      },
    ],
    capabilities: {
      node: { status: 'PASS', version: '22.23.1' },
      npm: { status: 'PASS', version: '10.9.2' },
      browser: { status: 'PASS', executableVerified: true },
      docker: { status: 'PASS', clientVersion: '29.5.2', serverVersion: '29.5.2' },
    },
  }
  return { ...input, ...overrides }
}

function receiptExpectations(overrides = {}) {
  return {
    baseSha: RECEIPT_BASE_SHA,
    headSha: RECEIPT_HEAD_SHA,
    headTreeSha: RECEIPT_TREE_SHA,
    commits: [RECEIPT_HEAD_SHA],
    gateToolSha256: RECEIPT_TOOL_SHA256,
    allowlistConfigSha256: RECEIPT_ALLOWLIST_SHA256,
    itemIds: [...RECEIPT_ITEM_IDS],
    ...overrides,
  }
}

function resealReceipt(receipt) {
  const copy = structuredClone(receipt)
  delete copy.receiptRootSha256
  copy.receiptRootSha256 = crypto.createHash('sha256').update(canonicalJson(copy)).digest('hex')
  return copy
}

test('canonical gate receipt binds repository, tool, capabilities, item evidence, and admissibility', () => {
  assert.equal(typeof buildCanonicalGateReceipt, 'function')
  assert.equal(typeof verifyCanonicalGateReceipt, 'function')
  const receipt = buildCanonicalGateReceipt(receiptInput())

  assert.equal(receipt.schemaVersion, RECEIPT_SCHEMA_VERSION)
  assert.deepEqual(receipt.repository, {
    baseSha: RECEIPT_BASE_SHA,
    headSha: RECEIPT_HEAD_SHA,
    headTreeSha: RECEIPT_TREE_SHA,
    commits: [RECEIPT_HEAD_SHA],
  })
  assert.equal(receipt.gate.toolSha256, RECEIPT_TOOL_SHA256)
  assert.equal(receipt.gate.allowlistConfigSha256, RECEIPT_ALLOWLIST_SHA256)
  assert.deepEqual(Object.keys(receipt.capabilities).sort(), ['browser', 'docker', 'node', 'npm'])
  assert.equal(receipt.items.length, RECEIPT_ITEM_IDS.length)
  assert(receipt.items.every((item) => Number.isInteger(item.durationMs) && item.durationMs >= 0))
  assert(receipt.items.every((item) => /^[0-9a-f]{64}$/.test(item.stdoutSha256)))
  assert(receipt.items.every((item) => /^[0-9a-f]{64}$/.test(item.stderrSha256)))
  assert.equal(receipt.aggregateVerdict, 'PASS')
  assert.equal(receipt.admissible, true)
  assert.match(receipt.receiptRootSha256, /^[0-9a-f]{64}$/)
  assert.doesNotThrow(() => verifyCanonicalGateReceipt(receipt, receiptExpectations()))
  assert.equal(canonicalJson(receipt), canonicalJson(JSON.parse(canonicalJson(receipt))))
})

test('receipt verification rejects wrong repository SHA and gate-tool drift', () => {
  const receipt = buildCanonicalGateReceipt(receiptInput())
  assert.throws(
    () => verifyCanonicalGateReceipt(receipt, receiptExpectations({ headSha: '7'.repeat(40) })),
    /head/i,
  )
  assert.throws(
    () => verifyCanonicalGateReceipt(receipt, receiptExpectations({ gateToolSha256: '8'.repeat(64) })),
    /tool/i,
  )
})

test('receipt verification rejects BLOCKED-as-PASS plus unknown, missing, and extra items', () => {
  const blockedInput = receiptInput({
    gateExitCode: 2,
    results: receiptInput().results.map((result) => (
      result.id === 'e2e:browser' ? { ...result, status: 'BLOCKED' } : result
    )),
    capabilities: {
      ...receiptInput().capabilities,
      browser: { status: 'BLOCKED', executableVerified: false },
    },
  })
  const blocked = buildCanonicalGateReceipt(blockedInput)
  assert.equal(blocked.aggregateVerdict, 'BLOCKED')
  assert.equal(blocked.admissible, false)

  const falsePass = resealReceipt({ ...blocked, aggregateVerdict: 'PASS', admissible: true })
  assert.throws(() => verifyCanonicalGateReceipt(falsePass, receiptExpectations()), /admissible|aggregate/i)

  const unknown = structuredClone(blocked)
  unknown.items[2].status = 'UNKNOWN'
  assert.throws(() => verifyCanonicalGateReceipt(resealReceipt(unknown), receiptExpectations()), /status/i)

  const missing = structuredClone(blocked)
  missing.items.pop()
  assert.throws(() => verifyCanonicalGateReceipt(resealReceipt(missing), receiptExpectations()), /missing|item/i)

  const extra = structuredClone(blocked)
  extra.items.push({ ...extra.items[0], id: 'unexpected:item' })
  assert.throws(() => verifyCanonicalGateReceipt(resealReceipt(extra), receiptExpectations()), /unknown|item/i)
})

test('receipt root digest detects stdout evidence tampering', () => {
  const receipt = buildCanonicalGateReceipt(receiptInput())
  receipt.items[0].stdoutSha256 = '9'.repeat(64)
  assert.throws(() => verifyCanonicalGateReceipt(receipt, receiptExpectations()), /root|digest/i)
})

test('receipt serialization rejects raw secret, environment, argv, stdout, and stderr fields', () => {
  const receipt = buildCanonicalGateReceipt(receiptInput())
  for (const [key, value] of [
    ['environment', { JWT_SECRET: 'must-not-persist' }],
    ['argv', ['--token=must-not-persist']],
    ['stdout', 'Bearer must-not-persist'],
    ['stderr', 'password=must-not-persist'],
  ]) {
    const contaminated = structuredClone(receipt)
    contaminated[key] = value
    assert.throws(() => verifyCanonicalGateReceipt(resealReceipt(contaminated), receiptExpectations()), /forbidden|schema|secret/i)
  }
})

test('receipt target is external, atomic, no-overwrite, and leaves no partial file on interruption', () => {
  assert.equal(typeof validateReceiptTarget, 'function')
  assert.equal(typeof writeCanonicalReceiptAtomic, 'function')
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-receipt-repo-'))
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-receipt-external-'))
  try {
    const receipt = buildCanonicalGateReceipt(receiptInput())
    assert.throws(
      () => validateReceiptTarget(path.join(repositoryRoot, 'receipt.json'), { repositoryRoot }),
      /outside|repository/i,
    )
    assert.throws(
      () => validateReceiptTarget('relative-receipt.json', { repositoryRoot }),
      /absolute/i,
    )

    const target = path.join(externalRoot, 'receipt.json')
    writeCanonicalReceiptAtomic(target, receipt, { repositoryRoot })
    assert.equal(fs.readFileSync(target, 'utf8'), canonicalJson(receipt))
    assert.throws(
      () => writeCanonicalReceiptAtomic(target, receipt, { repositoryRoot }),
      /exist|overwrite/i,
    )

    const interruptedTarget = path.join(externalRoot, 'interrupted.json')
    assert.throws(
      () => writeCanonicalReceiptAtomic(interruptedTarget, receipt, {
        repositoryRoot,
        beforePublish: () => { throw new Error('synthetic interruption') },
      }),
      /synthetic interruption/,
    )
    assert.equal(fs.existsSync(interruptedTarget), false)
    assert.deepEqual(
      fs.readdirSync(externalRoot).filter((name) => name.includes('interrupted') || name.includes('.partial-')),
      [],
    )
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true })
    fs.rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('LF and CRLF diagnostics normalize identically', () => {
  assert.equal(normalizeNewlines('alpha\r\nbeta\rgamma\n'), 'alpha\nbeta\ngamma\n')
  assert.equal(normalizeNewlines('alpha\nbeta\ngamma\n'), 'alpha\nbeta\ngamma\n')
})

test('authority digest ignores checkout EOL but detects real content mutation', () => {
  const lf = new Map([
    ['AGENTS.md', 'alpha\nbeta\n'],
    ['docs/contract.md', 'gamma\n'],
  ])
  const crlf = new Map([
    ['AGENTS.md', 'alpha\r\nbeta\r\n'],
    ['docs/contract.md', 'gamma\r\n'],
  ])
  const mutated = new Map(crlf)
  mutated.set('docs/contract.md', 'changed\r\n')

  assert.equal(canonicalAuthorityDigest(lf), canonicalAuthorityDigest(crlf))
  assert.notEqual(canonicalAuthorityDigest(lf), canonicalAuthorityDigest(mutated))
})

test('exit status, not PASS/FAIL wording or line endings, decides the result', () => {
  assert.equal(classifySpawnResult({ status: 0, stdout: 'FAIL\r\n', stderr: '' }), 'PASS')
  assert.equal(classifySpawnResult({ status: 9, stdout: 'PASS\n', stderr: '' }), 'FAIL')
  assert.equal(
    classifySpawnResult({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
    'BLOCKED',
  )
})

test('the verified HEAD and cached base must remain stable for the whole gate', () => {
  const initial = {
    head: '1111111111111111111111111111111111111111',
    base: '2222222222222222222222222222222222222222',
    headReflog: 'head-reflog-a',
    baseReflog: 'base-reflog-a',
  }
  assert.equal(compareGitState(initial, { ...initial }).status, 'PASS')
  assert.equal(compareGitState(initial, { ...initial, head: '3333333333333333333333333333333333333333' }).status, 'FAIL')
  assert.equal(compareGitState(initial, { ...initial, base: '4444444444444444444444444444444444444444' }).status, 'FAIL')
  assert.equal(compareGitState(initial, { ...initial, headReflog: 'head-reflog-b' }).status, 'FAIL')
  assert.equal(compareGitState(initial, { ...initial, baseReflog: 'base-reflog-b' }).status, 'FAIL')
  assert.equal(compareGitState(initial, { head: 'not-a-sha', base: initial.base }).status, 'FAIL')
})

test('temporary Git harness strips ambient config and disables prompts', () => {
  const environment = createSelftestEnvironment({
    PATH: process.env.PATH || '',
    GIT_CONFIG_GLOBAL: 'hostile-global-config',
    GIT_CONFIG_SYSTEM: 'hostile-system-config',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: 'hostile-hooks',
    SECRET_FOR_UNRELATED_TOOL: 'must-not-propagate',
  }, process.platform)
  assert.equal(environment.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null')
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(environment.GIT_TERMINAL_PROMPT, '0')
  assert.equal(environment.GIT_ALLOW_PROTOCOL, 'file')
  assert.equal(environment.GIT_CONFIG_COUNT, undefined)
  assert.equal(environment.SECRET_FOR_UNRELATED_TOOL, undefined)
})

test('committed diff scope rejects excluded paths even from a clean worktree', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-release-scope-'))
  const temporaryHooks = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-empty-hooks-'))
  const runGit = (args) => {
    const result = spawnSync('git', [
      '-c',
      'commit.gpgSign=false',
      '-c',
      `core.hooksPath=${temporaryHooks}`,
      ...args,
    ], {
      cwd: temporaryRoot,
      env: createSelftestEnvironment(process.env, process.platform),
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    return result.stdout.trim()
  }
  try {
    runGit(['init', '--quiet'])
    fs.writeFileSync(path.join(temporaryRoot, 'base.txt'), 'base\n')
    runGit(['add', '--', 'base.txt'])
    runGit(['-c', 'user.name=COREONE Selftest', '-c', 'user.email=selftest@coreone.invalid', 'commit', '--quiet', '-m', 'test: base'])
    const base = runGit(['rev-parse', 'HEAD'])

    fs.mkdirSync(path.join(temporaryRoot, 'owned'))
    fs.writeFileSync(path.join(temporaryRoot, 'owned', 'gate.txt'), 'owned\n')
    runGit(['add', '--', 'owned/gate.txt'])
    runGit(['-c', 'user.name=COREONE Selftest', '-c', 'user.email=selftest@coreone.invalid', 'commit', '--quiet', '-m', 'test: owned'])
    const ownedHead = runGit(['rev-parse', 'HEAD'])
    const step = {
      cwd: temporaryRoot,
      owned: ['owned/**'],
      excluded: ['excluded/**'],
    }
    assert.equal(runCommittedScope(step, { head: ownedHead, base }).status, 'PASS')

    fs.mkdirSync(path.join(temporaryRoot, 'excluded'))
    fs.writeFileSync(path.join(temporaryRoot, 'excluded', 'business.txt'), 'excluded\n')
    runGit(['add', '--', 'excluded/business.txt'])
    runGit(['-c', 'user.name=COREONE Selftest', '-c', 'user.email=selftest@coreone.invalid', 'commit', '--quiet', '-m', 'test: excluded'])
    const excludedHead = runGit(['rev-parse', 'HEAD'])
    const rejected = runCommittedScope(step, { head: excludedHead, base })
    assert.equal(rejected.status, 'FAIL')
    assert.match(rejected.detail, /excluded\/business\.txt/)
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
    fs.rmSync(temporaryHooks, { recursive: true, force: true })
  }
})

test('overall gate fails closed on failures and reports environment blocks separately', () => {
  assert.equal(overallExitCode([{ status: 'PASS' }]), 0)
  assert.equal(overallExitCode([{ status: 'PASS' }, { status: 'BLOCKED' }]), 2)
  assert.equal(overallExitCode([{ status: 'BLOCKED' }, { status: 'FAIL' }]), 1)
  assert.equal(overallExitCode([{ status: 'UNKNOWN' }]), 1)
})

test('dependency integrity distinguishes source mismatch from local installation blocks', () => {
  assert.equal(classifyDependencyCheck({ status: 0 }, 'tree').status, 'PASS')
  assert.equal(classifyDependencyCheck({ status: 1, stderr: 'npm error code ELSPROBLEMS' }, 'tree').status, 'BLOCKED')
  assert.equal(classifyDependencyCheck({ status: 1, stderr: 'npm error code ENOTCACHED' }, 'lock').status, 'BLOCKED')
  assert.equal(
    classifyDependencyCheck({ status: 1, stderr: 'npm error code EUSAGE\npackage.json and package-lock.json are not in sync' }, 'lock').status,
    'FAIL',
  )
})

test('secret scanner preserves its PASS, finding, and unable-to-scan exit contract', () => {
  assert.equal(classifySecretScanResult({ status: 0 }), 'PASS')
  assert.equal(classifySecretScanResult({ status: 1 }), 'FAIL')
  assert.equal(classifySecretScanResult({ status: 2 }), 'BLOCKED')
  assert.equal(
    classifySecretScanResult({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }),
    'BLOCKED',
  )
})

test('critical E2E source contract rejects missing files and fake-green constructs', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-e2e-specs-'))
  try {
    const spec = path.join(temporaryRoot, 'critical.spec.ts')
    const directory = path.join(temporaryRoot, 'directory.spec.ts')
    fs.writeFileSync(spec, "test('runs', async () => { expect(true).toBe(true) })\n")
    fs.mkdirSync(directory)

    assert.equal(runE2eSpecContract({ root: temporaryRoot, paths: [spec] }).status, 'PASS')
    assert.equal(runE2eSpecContract({ root: temporaryRoot, paths: [path.join(temporaryRoot, 'missing.spec.ts')] }).status, 'FAIL')
    assert.equal(runE2eSpecContract({ root: temporaryRoot, paths: [directory] }).status, 'FAIL')

    for (const [source, expectedRule] of [
      ["test.skip('hidden red', () => {})\n", /test control modifier/],
      ["test.fail('expected red', () => {})\n", /test control modifier/],
      ["test.describe.only('focused', () => {})\n", /test control modifier/],
      ["if (await locator.isVisible().catch(() => false)) action()\n", /swallowed locator predicate/],
      ["try { await cleanup() } catch { /* ignore */ }\n", /ignored catch block/],
      ["if (!fixtureId) return\n", /conditional bare return/],
      ["await page.waitForTimeout(800)\n", /fixed timeout/],
    ]) {
      fs.writeFileSync(spec, source)
      const result = runE2eSpecContract({ root: temporaryRoot, paths: [spec] })
      assert.equal(result.status, 'FAIL')
      assert.match(result.detail, expectedRule)
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

test('browser override contract requires absolute executable paths', () => {
  assert.equal(validateBrowserExecutable('relative/chromium', { platform: 'linux' }).status, 'BLOCKED')
  assert.equal(validateBrowserExecutable('/opt/chromium', {
    platform: 'linux',
    stat: () => ({ isFile: () => true }),
    access: () => {},
  }).status, 'PASS')
  assert.equal(validateBrowserExecutable('/opt/not-executable', {
    platform: 'linux',
    stat: () => ({ isFile: () => true }),
    access: () => { throw new Error('EACCES') },
  }).status, 'BLOCKED')
  assert.equal(validateBrowsersPath(undefined, 'linux').status, 'PASS')
  assert.equal(validateBrowsersPath('0', 'win32').status, 'PASS')
  assert.equal(validateBrowsersPath('/var/cache/playwright', 'linux').status, 'PASS')
  assert.equal(validateBrowsersPath('C:\\playwright-cache', 'win32').status, 'PASS')
  assert.equal(validateBrowsersPath('relative/cache', 'linux').status, 'BLOCKED')
  assert.equal(validateBrowsersPath('relative\\cache', 'win32').status, 'BLOCKED')
  assert.equal(validateBrowsersPath(' 0 ', 'linux').status, 'BLOCKED')
  assert.equal(validateBrowsersPath(' /var/cache/playwright ', 'linux').status, 'BLOCKED')
})

test('Docker aggregate readiness rejects a client-only mock CLI and accepts client plus server', () => {
  const mock = (payload, exitCode = 0) => runDockerDaemonCheck({
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(payload))});process.exit(${exitCode})`],
    cwd: ROOT,
    timeoutMs: 5000,
  })
  const clientOnly = mock({ Client: { Version: '29.5.2' }, Server: null })
  assert.equal(clientOnly.status, 'BLOCKED')
  assert.match(clientOnly.detail, /daemon|server/i)

  const complete = mock({
    Client: { Version: '29.5.2' },
    Server: { Version: '29.5.2', ApiVersion: '1.54' },
  })
  assert.equal(complete.status, 'PASS')
  assert.match(complete.detail, /client 29\.5\.2; server 29\.5\.2/)

  assert.equal(classifyDockerVersionResult({ status: 1, stderr: 'daemon unavailable' }).status, 'BLOCKED')
})

test('release Playwright reporter rejects zero, skipped, flaky, and expected-failure tests', () => {
  const passing = (spec) => ({
    outcome: 'expected',
    expectedStatus: 'passed',
    location: { file: path.join(ROOT, '前端代码', spec) },
  })
  assert.equal(evaluateCriticalTests(DEFAULT_E2E_SPECS.map(passing)).status, 'PASS')
  assert.equal(evaluateCriticalTests(DEFAULT_E2E_SPECS.slice(0, 2).map(passing)).status, 'FAIL')
  assert.equal(evaluateCriticalTests([]).status, 'FAIL')
  assert.equal(evaluateCriticalTests([{ ...passing(DEFAULT_E2E_SPECS[0]), outcome: 'skipped', expectedStatus: 'skipped' }]).status, 'FAIL')
  assert.equal(evaluateCriticalTests([{ ...passing(DEFAULT_E2E_SPECS[0]), outcome: 'flaky' }]).status, 'FAIL')
  assert.equal(evaluateCriticalTests([{ ...passing(DEFAULT_E2E_SPECS[0]), expectedStatus: 'failed' }]).status, 'FAIL')
})

test('offline preflight only accepts stale-fetch WARN at the exact pinned base', () => {
  const base = 'b263219f34550a5ee44b661af3afb36667dc68d9'
  const report = {
    verdict: 'WARN',
    repository: { baseRef: 'origin/master', baseSha: base, head: base, targetSha: base },
    checks: [
      ...REQUIRED_PREFLIGHT_CHECKS.map((id) => ({
        id,
        status: id === 'git.fetch-age' ? 'WARN' : 'PASS',
      })),
      { id: 'scope.dirty', status: 'PASS' },
    ],
  }
  const accepted = classifyPreflightReport(report, base)
  assert.equal(accepted.status, 'PASS')
  assert.equal(accepted.head, base)
  assert.equal(accepted.base, base)
  assert.equal(classifyPreflightReport(report).status, 'BLOCKED')
  assert.equal(
    classifyPreflightReport({
      ...report,
      checks: [
        ...report.checks.filter((check) => check.id !== 'scope.dirty'),
        { id: 'scope.owned-dirty', status: 'WARN' },
      ],
    }, base).status,
    'BLOCKED',
  )
  assert.equal(
    classifyPreflightReport({ ...report, verdict: 'FAIL', checks: [{ id: 'git.freshness', status: 'FAIL' }] }, base).status,
    'FAIL',
  )
  assert.equal(classifyPreflightReport({}, base).status, 'FAIL')
  assert.equal(classifyPreflightReport({ ...report, checks: report.checks.filter((check) => check.id !== 'scope.dirty') }, base).status, 'FAIL')
  assert.equal(classifyPreflightReport({ ...report, verdict: 'PASS' }, base).status, 'FAIL')
  assert.equal(
    classifyPreflightReport({ verdict: 'PASS', repository: report.repository, checks: [] }, base).status,
    'FAIL',
  )
})

test('npm resolution is host-independent and cannot be spoofed by ambient env', () => {
  const windowsResolved = resolveNpmCli({
    execPath: 'D:\\NODE.JS\\node.exe',
    platform: 'win32',
    env: {
      COREONE_NPM_CLI: 'C:\\untrusted\\npm-cli.js',
      npm_execpath: 'C:\\also-untrusted\\npm-cli.js',
    },
    exists: (candidate) => [
      'C:\\untrusted\\npm-cli.js',
      'C:\\also-untrusted\\npm-cli.js',
      'D:\\NODE.JS\\node_modules\\npm\\bin\\npm-cli.js',
    ].includes(candidate),
  })
  assert.equal(windowsResolved, 'D:\\NODE.JS\\node_modules\\npm\\bin\\npm-cli.js')

  const unixResolved = resolveNpmCli({
    execPath: '/opt/node/bin/node',
    platform: 'linux',
    exists: (candidate) => candidate === '/opt/node/lib/node_modules/npm/bin/npm-cli.js',
  })
  assert.equal(unixResolved, '/opt/node/lib/node_modules/npm/bin/npm-cli.js')
})

test('release child environment strips application and injection variables', () => {
  const env = createReleaseEnvironment({
    PATH: 'safe-path',
    HOME: 'safe-home',
    JWT_SECRET: 'ambient-jwt-must-not-pass',
    DATABASE_PATH: 'ambient-database-must-not-pass',
    VITE_TOKEN: 'ambient-vite-must-not-pass',
    NODE_OPTIONS: '--require=ambient-injection.cjs',
  }, { NODE_ENV: 'test' })
  assert.equal(env.PATH, 'safe-path')
  assert.equal(env.HOME, 'safe-home')
  assert.equal(env.NODE_ENV, 'test')
  assert.equal(env.NPM_CONFIG_OFFLINE, 'true')
  assert.equal(typeof env.NPM_CONFIG_USERCONFIG, 'string')
  assert.equal(typeof env.NPM_CONFIG_GLOBALCONFIG, 'string')
  assert.notEqual(env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG)
  assert.equal(env.JWT_SECRET, undefined)
  assert.equal(env.DATABASE_PATH, undefined)
  assert.equal(env.VITE_TOKEN, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
})

test('the plan contains the complete ordered local release contract', () => {
  const plan = buildPlan({
    root: ROOT,
    platform: 'win32',
    nodeExecutable: 'C:\\runtime\\node.exe',
    npmCli: 'C:\\runtime\\npm-cli.js',
    offlineBase: 'b263219f34550a5ee44b661af3afb36667dc68d9',
    owned: ['前端代码/playwright.config.ts'],
    excluded: ['前端代码/src/**'],
  })
  const ids = plan.map((step) => step.id)

  const requiredInOrder = [
    'preflight',
    'git:state-pin',
    'git:committed-scope',
    'authority:eol-contract',
    'git:clean-release-tree',
    'environment:local-config',
    'selftest:check-no-secrets',
    'secret-scan',
    'runtime:node',
    'runtime:npm',
    'runtime:docker-daemon',
    'selftest:agent-preflight',
    'selftest:local-release-gate',
    'build-discipline',
    'frontend:dependencies',
    'frontend:dependencies:integrity',
    'frontend:typecheck',
    'frontend:typecheck:config',
    'frontend:build',
    'frontend:unit',
    'backend:dependencies',
    'backend:dependencies:integrity',
    'backend:build',
    'backend:unit',
    'e2e:specs',
    'e2e:browser',
    'e2e:critical',
    'git:diff-check',
    'git:clean-release-tree:final',
    'git:state-stability:final',
  ]

  let cursor = -1
  for (const id of requiredInOrder) {
    const index = ids.indexOf(id)
    assert(index > cursor, `${id} must appear after ${requiredInOrder[Math.max(0, requiredInOrder.indexOf(id) - 1)]}`)
    cursor = index
  }

  const frontendCommands = plan.filter((step) => step.cwd === path.join(ROOT, '前端代码') && step.usesNpm)
  assert(frontendCommands.length >= 3)
  assert(frontendCommands.every((step) => step.command === 'C:\\runtime\\node.exe'))
  assert(frontendCommands.every((step) => step.args[0] === 'C:\\runtime\\npm-cli.js'))
  assert(frontendCommands.every((step) => {
    const pathKey = Object.keys(step.env).find((key) => key.toUpperCase() === 'PATH')
    return step.env[pathKey].split(';')[0] === 'C:\\runtime'
  }))
  const npmRuntime = plan.find((step) => step.id === 'runtime:npm')
  assert.equal(npmRuntime.npmLauncher, 'C:\\runtime\\npm.cmd')
  const dockerRuntime = plan.find((step) => step.id === 'runtime:docker-daemon')
  assert.equal(dockerRuntime.kind, 'docker-daemon')
  assert.equal(dockerRuntime.command, 'docker')
  assert.equal(dockerRuntime.hardStop, true)
  for (const step of plan.filter((candidate) => candidate.id.startsWith('selftest:'))) {
    assert.equal(step.env.GIT_CONFIG_GLOBAL, 'NUL')
    assert.equal(step.env.GIT_CONFIG_NOSYSTEM, '1')
    assert.equal(step.env.GIT_TERMINAL_PROMPT, '0')
    assert.equal(step.env.GIT_ALLOW_PROTOCOL, 'file')
  }
  for (const id of ['selftest:agent-preflight', 'selftest:local-release-gate', 'build-discipline']) {
    assert(plan.find((step) => step.id === id).requires.includes('runtime:node'))
  }
  const appTypecheck = plan.find((step) => step.id === 'frontend:typecheck')
  const configTypecheck = plan.find((step) => step.id === 'frontend:typecheck:config')
  assert.deepEqual(appTypecheck.args.slice(1), ['exec', '--offline', '--', 'tsc', '--noEmit', '--project', 'tsconfig.app.json'])
  assert.deepEqual(configTypecheck.args.slice(1), ['exec', '--offline', '--', 'tsc', '--noEmit', '--project', 'tsconfig.node.json'])
  assert.equal(plan.some((step) => step.args?.includes('-b')), false)
  for (const id of ['frontend:dependencies:integrity', 'backend:dependencies:integrity']) {
    const dependencyIntegrity = plan.find((step) => step.id === id)
    assert.equal(dependencyIntegrity.kind, 'npm-dependency-integrity')
    assert.deepEqual(dependencyIntegrity.checks.map((check) => check.mode), ['tree'])
    assert.equal(dependencyIntegrity.isolatedInstallProof, true)
    assert.equal(dependencyIntegrity.checks.some((check) => check.args.includes('--dry-run')), false)
  }
  for (const id of ['frontend:typecheck', 'frontend:typecheck:config', 'frontend:build', 'frontend:unit', 'e2e:browser', 'e2e:critical']) {
    assert(plan.find((step) => step.id === id).requires.includes('frontend:dependencies:integrity'))
  }
  for (const id of ['backend:build', 'backend:unit', 'e2e:critical']) {
    assert(plan.find((step) => step.id === id).requires.includes('backend:dependencies:integrity'))
  }
  assert.deepEqual(DEFAULT_E2E_SPECS, [
    'e2e/auth.spec.ts',
    'e2e/supplier-returns.spec.ts',
    'e2e/users.spec.ts',
  ])
  const e2eSpecs = plan.find((step) => step.id === 'e2e:specs')
  assert.equal(e2eSpecs.kind, 'e2e-spec-contract')
  assert.deepEqual(e2eSpecs.paths, DEFAULT_E2E_SPECS.map((spec) => path.join(ROOT, '前端代码', spec)))

  const backendUnit = plan.find((step) => step.id === 'backend:unit')
  assert.equal(backendUnit.env.NODE_ENV, 'test')
  assert.equal(backendUnit.env.DATABASE_PATH, ':memory:')
  assert.equal(typeof backendUnit.env.JWT_SECRET, 'string')
  assert(backendUnit.env.JWT_SECRET.length >= 64)

  const criticalE2e = plan.find((step) => step.id === 'e2e:critical')
  assert(criticalE2e.requires.includes('e2e:specs'))
  assert.equal(criticalE2e.env.CI, '1')
  assert.equal(criticalE2e.env.E2E_REUSE_EXISTING_SERVER, '0')
  const e2ePathKey = Object.keys(criticalE2e.env).find((key) => key.toUpperCase() === 'PATH')
  assert.equal(criticalE2e.env[e2ePathKey].split(';')[0], 'C:\\runtime')
  assert.equal(plan.at(-1).id, 'git:state-stability:final')

  const statePin = plan.find((step) => step.id === 'git:state-pin')
  const committedScope = plan.find((step) => step.id === 'git:committed-scope')
  const secretScan = plan.find((step) => step.id === 'secret-scan')
  const diffCheck = plan.find((step) => step.id === 'git:diff-check')
  assert.equal(statePin.preflightStep, 'preflight')
  assert.equal(committedScope.initialStep, 'git:state-pin')
  assert.equal(committedScope.hardStop, true)
  assert.equal(secretScan.initialStep, 'git:state-pin')
  assert.equal(diffCheck.initialStep, 'git:state-pin')
  assert.equal(secretScan.hardStop, true)

  const localConfig = plan.find((step) => step.id === 'environment:local-config')
  assert.equal(localConfig.hardStop, true)
  const hardStopProbe = executePlan([
    { ...localConfig, paths: [GATE] },
    {
      id: 'must-not-run',
      label: 'hard-stop execution probe',
      kind: 'command',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: ROOT,
      timeoutMs: 5000,
    },
  ])
  assert.equal(hardStopProbe[0].status, 'BLOCKED')
  assert.equal(hardStopProbe[1].status, 'BLOCKED')
  assert.match(hardStopProbe[1].detail, /hard-stopped by environment:local-config/)

  const secretHardStopProbe = executePlan([
    {
      id: 'secret-scan',
      label: 'secret scan failure probe',
      kind: 'command',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
      cwd: ROOT,
      timeoutMs: 5000,
      hardStop: secretScan.hardStop,
    },
    {
      id: 'must-not-run-after-secret-scan',
      label: 'secret hard-stop execution probe',
      kind: 'command',
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      cwd: ROOT,
      timeoutMs: 5000,
    },
  ])
  assert.equal(secretHardStopProbe[0].status, 'FAIL')
  assert.equal(secretHardStopProbe[1].status, 'BLOCKED')
  assert.match(secretHardStopProbe[1].detail, /hard-stopped by secret-scan/)
})

test('Node runtime contract matches the repository release runtime', () => {
  assert.equal(REQUIRED_NODE_MAJOR, 22)
  assert.equal(MINIMUM_LOCAL_RELEASE_NODE_VERSION, '22.23.1')
  assert.equal(fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim(), '22')
  const backendPackage = JSON.parse(fs.readFileSync(path.join(ROOT, '后端代码', 'server', 'package.json'), 'utf8'))
  assert.equal(backendPackage.engines.node, '^22.23.1 || ^24.0.0')
})

test('Playwright startup is local, explicit, and free of personal browser paths', () => {
  const source = fs.readFileSync(path.join(ROOT, '前端代码', 'playwright.config.ts'), 'utf8')
  assert.doesNotMatch(source, /(?:[A-Z]:(?:\\+|\/)Users(?:\\+|\/)|\/(?:home|Users)\/)[^'"\r\n]+/i)
  assert.doesNotMatch(source, /\bnpx(?:\.cmd)?\b/)
  assert.match(source, /PLAYWRIGHT_CHROMIUM_PATH/)
  assert.match(source, /PLAYWRIGHT_BROWSERS_PATH/)
  assert.match(source, /isAbsolute/)
  assert.match(source, /E2E_REUSE_EXISTING_SERVER/)
  assert.match(source, /randomBytes/)
  assert.match(source, /cwd:\s*backendDir/)
  assert.match(source, /cwd:\s*frontendDir/)
  assert.match(source, /--strictPort/)
  assert.match(source, /DATABASE_PATH:\s*':memory:'/)
  assert.match(source, /return String\(port\)/)
  assert.doesNotMatch(source, /http:\/\/localhost/)
  assert.doesNotMatch(source, /env:\s*{\s*\.\.\.process\.env/)
  assert.match(source, /NPM_CONFIG_USERCONFIG/)
  assert.match(source, /NPM_CONFIG_GLOBALCONFIG/)
})

test('the critical E2E package command names its intentionally limited scope', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, '前端代码', 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['test:e2e:critical'],
    'playwright test e2e/auth.spec.ts e2e/supplier-returns.spec.ts e2e/users.spec.ts --fail-on-flaky-tests --reporter=list,../scripts/local-release-gate.cjs --workers=1',
  )
})

if (!process.exitCode) process.stdout.write('local-release-gate selftest: PASS\n')
