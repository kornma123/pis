#!/usr/bin/env node

'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { AUTHORITY_FILES, matchesAny } = require('./agent-preflight.cjs')
const {
  LOCAL_RELEASE_NODE_MAJOR,
  MINIMUM_LOCAL_RELEASE_NODE_VERSION,
  isSupportedLocalReleaseNodeVersion,
  runIsolatedOfflineNpmCi,
} = require('./local-release-runtime/runtime-readiness.cjs')

const ROOT = path.resolve(__dirname, '..')
const REQUIRED_NODE_MAJOR = LOCAL_RELEASE_NODE_MAJOR
const DOCKER_VERSION_ARGS = Object.freeze(['version', '--format', '{{json .}}'])
const REQUIRED_PREFLIGHT_CHECKS = Object.freeze([
  'git.fetch-age',
  'git.branch',
  'git.freshness',
  'authority.files',
  'authority.contract-id',
  'adapter.AGENTS.md',
  'adapter.CLAUDE.md',
  'drift.high-risk-rules',
  'drift.dynamic-facts',
  'drift.session-log',
  'drift.live-code-contract',
  'drift.legacy-guides',
  'drift.github-runtime-source',
])
const SAFE_ENVIRONMENT_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SHELL',
])
const DEFAULT_E2E_SPECS = Object.freeze([
  'e2e/auth.spec.ts',
  'e2e/supplier-returns.spec.ts',
  'e2e/users.spec.ts',
])
const E2E_SOURCE_RULES = Object.freeze([
  {
    label: 'test control modifier (skip/fixme/fail/only)',
    pattern: /\b(?:test(?:\s*\.\s*describe)?|testInfo)\s*\.\s*(?:skip|fixme|fail|only)\s*\(/g,
  },
  {
    label: 'swallowed locator predicate',
    pattern: /\.\s*(?:isVisible|isEnabled|isDisabled)\s*\([^)]*\)\s*\.catch\s*\(\s*\(\s*\)\s*=>\s*false\s*\)/g,
  },
  {
    label: 'ignored catch block',
    pattern: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\n]*(?:\n|$))|\s)*\}/g,
  },
  {
    label: 'conditional bare return',
    pattern: /\bif\s*\([^\n{}]*\)\s*(?:\{\s*)?return\s*(?:;|(?=\n|\}))/g,
  },
  {
    label: 'fixed timeout instead of a web-first wait',
    pattern: /\.\s*waitForTimeout\s*\(/g,
  },
])
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000
const RECEIPT_SCHEMA_VERSION = 'coreone.local-release-gate.receipt/v1'
const RECEIPT_STATUSES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'])
const RECEIPT_CAPABILITY_ITEMS = Object.freeze({
  node: 'runtime:node',
  npm: 'runtime:npm',
  browser: 'e2e:browser',
  docker: 'runtime:docker-daemon',
})
const SHA40_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n')
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

const EMPTY_SHA256 = sha256Hex('')

function canonicalJson(value) {
  const encode = (current, location) => {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      return JSON.stringify(current)
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`canonical JSON rejects non-finite number at ${location}`)
      return JSON.stringify(Object.is(current, -0) ? 0 : current)
    }
    if (Array.isArray(current)) {
      return `[${current.map((entry, index) => encode(entry, `${location}[${index}]`)).join(',')}]`
    }
    if (current && typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`canonical JSON requires a plain object at ${location}`)
      }
      return `{${Object.keys(current).sort().map((key) => {
        if (current[key] === undefined) throw new Error(`canonical JSON rejects undefined at ${location}.${key}`)
        return `${JSON.stringify(key)}:${encode(current[key], `${location}.${key}`)}`
      }).join(',')}}`
    }
    throw new Error(`canonical JSON rejects ${typeof current} at ${location}`)
  }
  return encode(value, '$')
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

function assertExactKeys(value, expected, label) {
  assertPlainObject(value, label)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} schema fields must be exactly: ${wanted.join(', ')}`)
  }
}

function assertHex(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} has an invalid digest or SHA`)
}

function assertReceiptHasNoRawSensitiveData(value, location = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertReceiptHasNoRawSensitiveData(entry, `${location}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const lowered = key.toLowerCase()
      if (
        ['argv', 'args', 'command', 'cwd', 'env', 'environment', 'stdout', 'stderr'].includes(lowered)
        || /(?:secret|password|authorization|cookie|rawtoken|accesstoken|refreshtoken)/i.test(key)
      ) {
        throw new Error(`receipt schema forbids raw sensitive field ${location}.${key}`)
      }
      assertReceiptHasNoRawSensitiveData(entry, `${location}.${key}`)
    }
    return
  }
  if (typeof value === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|\b(?:password|token|secret)\s*=/i.test(value)) {
    throw new Error(`receipt secret filter rejected raw sensitive content at ${location}`)
  }
}

function aggregateReceiptVerdict(items) {
  if (items.some((item) => item.status === 'FAIL')) return 'FAIL'
  if (items.some((item) => item.status === 'BLOCKED')) return 'BLOCKED'
  if (items.some((item) => item.status === 'UNVERIFIED')) return 'UNVERIFIED'
  return 'PASS'
}

function exitCodeForReceiptVerdict(verdict) {
  if (verdict === 'PASS') return 0
  if (verdict === 'BLOCKED') return 2
  return 1
}

function normalizeReceiptItem(result) {
  assertPlainObject(result, 'receipt item input')
  if (typeof result.id !== 'string' || !/^[A-Za-z0-9:_-]+$/.test(result.id)) {
    throw new Error('receipt item id is invalid')
  }
  if (!RECEIPT_STATUSES.includes(result.status)) throw new Error(`receipt item status is invalid for ${result.id}`)
  if (result.exitCode !== null && (!Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255)) {
    throw new Error(`receipt item exit code is invalid for ${result.id}`)
  }
  if (!Number.isInteger(result.durationMs) || result.durationMs < 0) {
    throw new Error(`receipt item duration is invalid for ${result.id}`)
  }
  assertHex(result.stdoutSha256, SHA256_PATTERN, `receipt item stdout digest for ${result.id}`)
  assertHex(result.stderrSha256, SHA256_PATTERN, `receipt item stderr digest for ${result.id}`)
  return {
    id: result.id,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutSha256: result.stdoutSha256,
    stderrSha256: result.stderrSha256,
  }
}

function normalizeReceiptCapabilities(capabilities, items) {
  assertExactKeys(capabilities, ['node', 'npm', 'browser', 'docker'], 'receipt capabilities')
  const normalized = {
    node: { ...capabilities.node },
    npm: { ...capabilities.npm },
    browser: { ...capabilities.browser },
    docker: { ...capabilities.docker },
  }
  assertExactKeys(normalized.node, ['status', 'version'], 'receipt Node capability')
  assertExactKeys(normalized.npm, ['status', 'version'], 'receipt npm capability')
  assertExactKeys(normalized.browser, ['status', 'executableVerified'], 'receipt browser capability')
  assertExactKeys(normalized.docker, ['status', 'clientVersion', 'serverVersion'], 'receipt Docker capability')

  for (const [name, itemId] of Object.entries(RECEIPT_CAPABILITY_ITEMS)) {
    const item = items.find((candidate) => candidate.id === itemId)
    if (!item) throw new Error(`receipt item set is missing capability item ${itemId}`)
    if (!RECEIPT_STATUSES.includes(normalized[name].status)) throw new Error(`receipt ${name} capability status is invalid`)
    if (normalized[name].status !== item.status) throw new Error(`receipt ${name} capability status does not match ${itemId}`)
  }
  for (const [label, version] of [
    ['Node', normalized.node.version],
    ['npm', normalized.npm.version],
    ['Docker client', normalized.docker.clientVersion],
    ['Docker server', normalized.docker.serverVersion],
  ]) {
    if (version !== null && (typeof version !== 'string' || !/^[0-9A-Za-z.+_-]{1,64}$/.test(version))) {
      throw new Error(`receipt ${label} version is invalid`)
    }
  }
  if (typeof normalized.browser.executableVerified !== 'boolean') {
    throw new Error('receipt browser executableVerified must be boolean')
  }
  if (normalized.browser.status !== 'PASS' && normalized.browser.executableVerified) {
    throw new Error('receipt browser cannot be verified when its status is not PASS')
  }
  return normalized
}

function validateReceiptRepository(repository) {
  assertExactKeys(repository, ['baseSha', 'headSha', 'headTreeSha', 'commits'], 'receipt repository')
  assertHex(repository.baseSha, SHA40_PATTERN, 'receipt base SHA')
  assertHex(repository.headSha, SHA40_PATTERN, 'receipt head SHA')
  assertHex(repository.headTreeSha, SHA40_PATTERN, 'receipt head tree SHA')
  if (!Array.isArray(repository.commits)) throw new Error('receipt commit list must be an array')
  repository.commits.forEach((commit, index) => assertHex(commit, SHA40_PATTERN, `receipt commit ${index}`))
  if (new Set(repository.commits).size !== repository.commits.length) throw new Error('receipt commit list contains duplicates')
  if (repository.baseSha === repository.headSha && repository.commits.length !== 0) {
    throw new Error('receipt commit list must be empty when base equals head')
  }
  if (repository.baseSha !== repository.headSha && repository.commits.at(-1) !== repository.headSha) {
    throw new Error('receipt commit list must terminate at exact head SHA')
  }
}

function buildCanonicalGateReceipt(input) {
  assertExactKeys(input, [
    'repository',
    'gateToolSha256',
    'allowlistConfigSha256',
    'deliveryId',
    'nonce',
    'gateExitCode',
    'planItemIds',
    'results',
    'capabilities',
  ], 'receipt input')
  validateReceiptRepository(input.repository)
  assertHex(input.gateToolSha256, SHA256_PATTERN, 'gate tool SHA-256')
  assertHex(input.allowlistConfigSha256, SHA256_PATTERN, 'allowlist config SHA-256')
  if (typeof input.deliveryId !== 'string' || !DELIVERY_ID_PATTERN.test(input.deliveryId)) {
    throw new Error('receipt deliveryId must be a UUID v4')
  }
  assertHex(input.nonce, SHA256_PATTERN, 'receipt nonce')
  if (!Array.isArray(input.planItemIds) || !Array.isArray(input.results)) {
    throw new Error('receipt plan and result items must be arrays')
  }
  if (new Set(input.planItemIds).size !== input.planItemIds.length) throw new Error('receipt plan item ids must be unique')
  const items = input.results.map(normalizeReceiptItem)
  const resultIds = items.map((item) => item.id)
  if (
    resultIds.length !== input.planItemIds.length
    || resultIds.some((id, index) => id !== input.planItemIds[index])
  ) {
    throw new Error('receipt result items must exactly match the ordered gate plan')
  }
  const capabilities = normalizeReceiptCapabilities(input.capabilities, items)
  const aggregateVerdict = aggregateReceiptVerdict(items)
  if (input.gateExitCode !== exitCodeForReceiptVerdict(aggregateVerdict)) {
    throw new Error('receipt gate exit code does not match aggregate verdict')
  }
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    deliveryId: input.deliveryId,
    nonce: input.nonce,
    repository: structuredClone(input.repository),
    gate: {
      toolSha256: input.gateToolSha256,
      allowlistConfigSha256: input.allowlistConfigSha256,
    },
    capabilities,
    items,
    gateExitCode: input.gateExitCode,
    aggregateVerdict,
    admissible: aggregateVerdict === 'PASS' && items.every((item) => item.status === 'PASS'),
  }
  assertReceiptHasNoRawSensitiveData(receipt)
  receipt.receiptRootSha256 = sha256Hex(canonicalJson(receipt))
  verifyCanonicalGateReceipt(receipt, {
    baseSha: input.repository.baseSha,
    headSha: input.repository.headSha,
    headTreeSha: input.repository.headTreeSha,
    commits: input.repository.commits,
    gateToolSha256: input.gateToolSha256,
    allowlistConfigSha256: input.allowlistConfigSha256,
    itemIds: input.planItemIds,
  })
  return receipt
}

function verifyCanonicalGateReceipt(receipt, expected = {}) {
  assertPlainObject(receipt, 'receipt')
  assertHex(receipt.receiptRootSha256, SHA256_PATTERN, 'receipt root digest')
  const unsigned = { ...receipt }
  delete unsigned.receiptRootSha256
  const computedRoot = sha256Hex(canonicalJson(unsigned))
  if (computedRoot !== receipt.receiptRootSha256) throw new Error('receipt root digest mismatch')
  assertReceiptHasNoRawSensitiveData(receipt)
  assertExactKeys(receipt, [
    'schemaVersion',
    'deliveryId',
    'nonce',
    'repository',
    'gate',
    'capabilities',
    'items',
    'gateExitCode',
    'aggregateVerdict',
    'admissible',
    'receiptRootSha256',
  ], 'receipt')
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) throw new Error('receipt schemaVersion is unsupported')
  if (typeof receipt.deliveryId !== 'string' || !DELIVERY_ID_PATTERN.test(receipt.deliveryId)) {
    throw new Error('receipt deliveryId is invalid')
  }
  assertHex(receipt.nonce, SHA256_PATTERN, 'receipt nonce')
  validateReceiptRepository(receipt.repository)
  assertExactKeys(receipt.gate, ['toolSha256', 'allowlistConfigSha256'], 'receipt gate')
  assertHex(receipt.gate.toolSha256, SHA256_PATTERN, 'receipt gate tool SHA-256')
  assertHex(receipt.gate.allowlistConfigSha256, SHA256_PATTERN, 'receipt allowlist digest')
  if (!Array.isArray(receipt.items)) throw new Error('receipt items must be an array')
  const items = receipt.items.map(normalizeReceiptItem)
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('receipt item ids must be unique')
  normalizeReceiptCapabilities(receipt.capabilities, items)
  const aggregateVerdict = aggregateReceiptVerdict(items)
  if (receipt.aggregateVerdict !== aggregateVerdict) throw new Error('receipt aggregate verdict is inconsistent')
  if (!Number.isInteger(receipt.gateExitCode) || receipt.gateExitCode !== exitCodeForReceiptVerdict(aggregateVerdict)) {
    throw new Error('receipt gate exit code is inconsistent')
  }
  const admissible = aggregateVerdict === 'PASS' && items.every((item) => item.status === 'PASS')
  if (receipt.admissible !== admissible) throw new Error('receipt admissible flag is inconsistent')

  const exact = (actual, wanted, label) => {
    if (wanted !== undefined && actual !== wanted) throw new Error(`receipt ${label} does not match expected ${label}`)
  }
  exact(receipt.repository.baseSha, expected.baseSha, 'base SHA')
  exact(receipt.repository.headSha, expected.headSha, 'head SHA')
  exact(receipt.repository.headTreeSha, expected.headTreeSha, 'head tree SHA')
  exact(receipt.gate.toolSha256, expected.gateToolSha256, 'gate tool SHA-256')
  exact(receipt.gate.allowlistConfigSha256, expected.allowlistConfigSha256, 'allowlist config SHA-256')
  if (expected.commits !== undefined && canonicalJson(receipt.repository.commits) !== canonicalJson(expected.commits)) {
    throw new Error('receipt commit list does not match expected commit list')
  }
  if (expected.itemIds !== undefined) {
    const actualIds = items.map((item) => item.id)
    if (canonicalJson(actualIds) !== canonicalJson(expected.itemIds)) {
      const missing = expected.itemIds.filter((id) => !actualIds.includes(id))
      const unknown = actualIds.filter((id) => !expected.itemIds.includes(id))
      throw new Error(`receipt item set mismatch; missing=${missing.join('|') || 'none'} unknown=${unknown.join('|') || 'none'}`)
    }
  }
  return { status: 'PASS', receiptRootSha256: receipt.receiptRootSha256 }
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function validateReceiptTarget(target, { repositoryRoot = ROOT } = {}) {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw new Error('receipt target must be an explicit absolute path outside the repository')
  }
  const resolvedTarget = path.resolve(target)
  const resolvedRepository = fs.realpathSync(repositoryRoot)
  const parent = path.dirname(resolvedTarget)
  let parentStat
  try {
    parentStat = fs.statSync(parent)
  } catch {
    throw new Error('receipt target parent directory must already exist')
  }
  if (!parentStat.isDirectory()) throw new Error('receipt target parent must be a directory')
  const realParent = fs.realpathSync(parent)
  const realTarget = path.join(realParent, path.basename(resolvedTarget))
  if (pathIsInside(resolvedRepository, resolvedTarget) || pathIsInside(resolvedRepository, realTarget)) {
    throw new Error('receipt target must stay outside the repository')
  }
  try {
    fs.lstatSync(resolvedTarget)
    throw new Error('receipt target already exists; overwrite is forbidden')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  return resolvedTarget
}

function writeCanonicalReceiptAtomic(target, receipt, {
  repositoryRoot = ROOT,
  beforePublish,
} = {}) {
  verifyCanonicalGateReceipt(receipt)
  const resolvedTarget = validateReceiptTarget(target, { repositoryRoot })
  const partial = path.join(
    path.dirname(resolvedTarget),
    `.${path.basename(resolvedTarget)}.partial-${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
  )
  const bytes = Buffer.from(canonicalJson(receipt), 'utf8')
  let descriptor
  try {
    descriptor = fs.openSync(partial, 'wx', 0o600)
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    if (beforePublish) beforePublish()
    fs.linkSync(partial, resolvedTarget)
    fs.unlinkSync(partial)
    return resolvedTarget
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { fs.unlinkSync(partial) } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') throw cleanupError
    }
    throw error
  }
}

function createReleaseEnvironment(source = process.env, overrides = {}) {
  const environment = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && SAFE_ENVIRONMENT_KEYS.has(key.toUpperCase())) {
      environment[key] = String(value)
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) environment[key] = String(value)
  }
  environment.NPM_CONFIG_OFFLINE = 'true'
  environment.NPM_CONFIG_AUDIT = 'false'
  environment.NPM_CONFIG_FUND = 'false'
  environment.NPM_CONFIG_UPDATE_NOTIFIER = 'false'
  environment.NPM_CONFIG_USERCONFIG = os.devNull
  environment.NPM_CONFIG_GLOBALCONFIG = path.join(
    os.tmpdir(),
    `.coreone-absent-global-npmrc-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  )
  environment.COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  return environment
}

function createSelftestEnvironment(source = process.env, platform = process.platform) {
  return createReleaseEnvironment(source, {
    GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'file',
  })
}

function resolveNpmCli({
  execPath = process.execPath,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const executableDir = pathApi.dirname(execPath)
  const candidates = []
  if (platform === 'win32') {
    candidates.push(pathApi.join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  } else {
    candidates.push(
      pathApi.join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pathApi.resolve(executableDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pathApi.resolve(executableDir, '..', 'share', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    )
  }
  return candidates.filter(Boolean).find((candidate) => exists(candidate)) || null
}

// Human output is diagnostic only. PASS/FAIL words and OS line endings never
// decide the gate; the child-process contract does.
function classifySpawnResult(result) {
  if (['ENOENT', 'EACCES', 'EINVAL'].includes(result?.error?.code)) return 'BLOCKED'
  if (result?.error) return 'FAIL'
  return result?.status === 0 ? 'PASS' : 'FAIL'
}

function classifySecretScanResult(result) {
  const processStatus = classifySpawnResult(result)
  if (processStatus === 'BLOCKED') return 'BLOCKED'
  if (result?.error) return 'FAIL'
  if (result?.status === 0) return 'PASS'
  if (result?.status === 1) return 'FAIL'
  if (result?.status === 2) return 'BLOCKED'
  return 'FAIL'
}

function classifyDependencyCheck(result, mode) {
  const processStatus = classifySpawnResult(result)
  if (processStatus === 'PASS') return { status: 'PASS' }
  if (processStatus === 'BLOCKED') return { status: 'BLOCKED' }
  if (result?.error) return { status: 'FAIL' }
  const diagnostics = normalizeNewlines(`${result?.stdout || ''}\n${result?.stderr || ''}`)
  if (/\b(?:ENOTCACHED|ELSPROBLEMS)\b/i.test(diagnostics)) return { status: 'BLOCKED' }
  if (
    mode === 'lock'
    && /\b(?:EUSAGE|EJSONPARSE|ERESOLVE|ELOCKVERIFY)\b|package(?:\.json)? and package-lock\.json .*not in sync/i.test(diagnostics)
  ) {
    return { status: 'FAIL' }
  }
  return { status: 'BLOCKED' }
}

function spawnEvidence(result) {
  return {
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    stdoutSha256: sha256Hex(result?.stdout == null ? '' : result.stdout),
    stderrSha256: sha256Hex(result?.stderr == null ? '' : result.stderr),
  }
}

function classifyDockerVersionResult(result) {
  if (result?.error) {
    return {
      status: 'BLOCKED',
      detail: `Docker CLI could not run: ${result.error.code || result.error.message}`,
      capability: { clientVersion: null, serverVersion: null },
    }
  }
  if (result?.status !== 0) {
    const diagnostics = normalizeNewlines(`${result?.stderr || ''}\n${result?.stdout || ''}`).trim()
    return {
      status: 'BLOCKED',
      detail: diagnostics
        ? `Docker daemon is unavailable: ${diagnostics.split('\n').at(-1)}`
        : `Docker daemon probe exited ${result?.status}`,
      capability: { clientVersion: null, serverVersion: null },
    }
  }

  let payload
  try {
    payload = JSON.parse(normalizeNewlines(result.stdout).trim())
  } catch {
    return {
      status: 'FAIL',
      detail: 'Docker version probe did not return the required JSON contract',
      capability: { clientVersion: null, serverVersion: null },
    }
  }
  const clientVersion = String(payload?.Client?.Version || '').trim()
  const serverVersion = String(payload?.Server?.Version || '').trim()
  if (!clientVersion) {
    return {
      status: 'BLOCKED',
      detail: 'Docker client identity is unavailable',
      capability: { clientVersion: null, serverVersion: null },
    }
  }
  if (!serverVersion) {
    return {
      status: 'BLOCKED',
      detail: `Docker client ${clientVersion} is present but the daemon/server is unavailable`,
      capability: { clientVersion, serverVersion: null },
    }
  }
  return {
    status: 'PASS',
    detail: `Docker client ${clientVersion}; server ${serverVersion}`,
    capability: { clientVersion, serverVersion },
  }
}

function runDockerDaemonCheck(step) {
  const result = spawnCaptured(step.command, step.args || DOCKER_VERSION_ARGS, {
    cwd: step.cwd,
    timeoutMs: step.timeoutMs,
  })
  return { ...classifyDockerVersionResult(result), ...spawnEvidence(result) }
}

function canonicalAuthorityDigest(entries) {
  const digest = crypto.createHash('sha256')
  const ordered = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
  for (const [file, content] of ordered) {
    digest.update(file, 'utf8')
    digest.update('\0')
    digest.update(normalizeNewlines(content), 'utf8')
    digest.update('\0')
  }
  return digest.digest('hex')
}

function classifyPreflightReport(report, offlineBase) {
  const checks = Array.isArray(report?.checks) ? report.checks : []
  const failed = checks.filter((check) => check.status === 'FAIL')
  if (report?.verdict === 'FAIL' || failed.length) {
    return { status: 'FAIL', detail: `preflight failed: ${failed.map((check) => check.id).join(', ') || 'unknown check'}` }
  }

  const validBase = /^[0-9a-f]{40}$/i.test(report?.repository?.baseSha || '')
  const validHead = /^[0-9a-f]{40}$/i.test(report?.repository?.head || '')
    && report.repository.head === report.repository.targetSha
  const checkIds = checks.map((check) => check.id)
  const missingChecks = REQUIRED_PREFLIGHT_CHECKS.filter((id) => !checkIds.includes(id))
  const scopeChecks = checks.filter((check) => ['scope.dirty', 'scope.owned-dirty'].includes(check.id))
  const validScopeCheck = scopeChecks.length === 1 && (
    (scopeChecks[0].id === 'scope.dirty' && scopeChecks[0].status === 'PASS')
    || (scopeChecks[0].id === 'scope.owned-dirty' && scopeChecks[0].status === 'WARN')
  )
  const duplicateChecks = new Set(checkIds).size !== checkIds.length
  const invalidStatus = checks.some((check) => !['PASS', 'WARN', 'FAIL'].includes(check.status))
  const warnings = checks.filter((check) => check.status === 'WARN')
  const expectedVerdict = warnings.length ? 'WARN' : 'PASS'
  if (
    !Array.isArray(report?.checks)
    || !validBase
    || !validHead
    || report?.repository?.baseRef !== 'origin/master'
    || missingChecks.length
    || !validScopeCheck
    || duplicateChecks
    || invalidStatus
    || report?.verdict !== expectedVerdict
  ) {
    return { status: 'FAIL', detail: 'preflight returned an incomplete or inconsistent report' }
  }

  if (offlineBase && report?.repository?.baseSha !== offlineBase) {
    return { status: 'FAIL', detail: 'cached origin/master does not match --offline-base' }
  }

  const unaccepted = warnings.filter((check) => !(
    offlineBase
    && report?.repository?.baseSha === offlineBase
    && check.id === 'git.fetch-age'
  ))
  if (unaccepted.length) {
    return { status: 'BLOCKED', detail: `preflight warning requires resolution: ${unaccepted.map((check) => check.id).join(', ')}` }
  }

  return {
    status: 'PASS',
    detail: warnings.length ? 'accepted stale-fetch warning at exact offline base' : undefined,
    head: report.repository.head.toLowerCase(),
    base: report.repository.baseSha.toLowerCase(),
  }
}

function overallExitCode(results) {
  if (results.some((result) => result.status === 'FAIL')) return 1
  if (results.some((result) => !['PASS', 'BLOCKED'].includes(result.status))) return 1
  if (results.some((result) => result.status === 'BLOCKED')) return 2
  return 0
}

function compareGitState(initial, current) {
  const fullSha = /^[0-9a-f]{40}$/i
  if (
    !fullSha.test(initial?.head || '')
    || !fullSha.test(initial?.base || '')
    || !fullSha.test(current?.head || '')
    || !fullSha.test(current?.base || '')
  ) {
    return { status: 'FAIL', detail: 'cannot prove full-SHA repository state' }
  }
  if (initial.head !== current.head) {
    return { status: 'FAIL', detail: 'HEAD changed while the local release gate was running' }
  }
  if (initial.base !== current.base) {
    return { status: 'FAIL', detail: 'origin/master changed while the local release gate was running' }
  }
  if (typeof initial.headReflog === 'string' && initial.headReflog !== current.headReflog) {
    return { status: 'FAIL', detail: 'HEAD reflog changed while the local release gate was running' }
  }
  if (typeof initial.baseReflog === 'string' && initial.baseReflog !== current.baseReflog) {
    return { status: 'FAIL', detail: 'origin/master reflog changed while the local release gate was running' }
  }
  return { status: 'PASS' }
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function walkSelftests(directory) {
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...walkSelftests(absolute))
    else if (entry.isFile() && entry.name.endsWith('.selftest.cjs')) found.push(absolute)
  }
  return found.sort((left, right) => toPosix(left).localeCompare(toPosix(right), 'en'))
}

function selftestId(root, absolute) {
  const relative = toPosix(path.relative(path.join(root, 'scripts'), absolute))
  if (relative.endsWith('/selftest.cjs')) {
    return `selftest:${relative.slice(0, -'/selftest.cjs'.length)}`
  }
  return `selftest:${relative.slice(0, -'.selftest.cjs'.length)}`
}

function commandStep(id, label, command, args, cwd, extra = {}) {
  return {
    id,
    label,
    kind: 'command',
    command,
    args,
    cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
    ...extra,
  }
}

function buildPlan({
  root = ROOT,
  platform = process.platform,
  nodeExecutable = process.execPath,
  npmCli = resolveNpmCli({ execPath: nodeExecutable, platform }),
  dockerCommand = 'docker',
  offlineBase,
  owned,
  excluded,
}) {
  if (!Array.isArray(owned) || owned.length === 0) throw new Error('at least one --owned path is required')
  if (!Array.isArray(excluded) || excluded.length === 0) throw new Error('at least one --excluded path is required')

  const frontend = path.join(root, '前端代码')
  const backend = path.join(root, '后端代码', 'server')
  const frontendRequiredPackages = [
    'node_modules/vite/package.json',
    'node_modules/vitest/package.json',
    'node_modules/typescript/package.json',
    'node_modules/@playwright/test/package.json',
  ]
  const backendRequiredPackages = [
    'node_modules/typescript/package.json',
    'node_modules/vitest/package.json',
    'node_modules/tsx/package.json',
  ]
  const runtimePathApi = platform === 'win32' ? path.win32 : path.posix
  if (!runtimePathApi.isAbsolute(nodeExecutable)) throw new Error('the selected Node executable must be an absolute path')
  const runtimeDirectory = runtimePathApi.dirname(nodeExecutable)
  const npmLauncher = runtimePathApi.join(runtimeDirectory, platform === 'win32' ? 'npm.cmd' : 'npm')
  const npmCliArg = npmCli || path.join(root, '.npm-cli-unavailable')
  const releaseEnvironment = createReleaseEnvironment()
  const selftestEnvironment = createSelftestEnvironment(process.env, platform)
  const backendUnitJwtSecret = crypto.randomBytes(48).toString('base64url')
  const e2eEnvironment = createReleaseEnvironment(process.env, {
    CI: '1',
    E2E_REUSE_EXISTING_SERVER: '0',
  })
  const prependRuntimeToPath = (environment) => {
    const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH') || 'PATH'
    environment[pathKey] = [runtimeDirectory, environment[pathKey]]
      .filter(Boolean)
      .join(platform === 'win32' ? ';' : ':')
  }
  prependRuntimeToPath(releaseEnvironment)
  prependRuntimeToPath(e2eEnvironment)
  for (const key of [
    'E2E_BACKEND_PORT',
    'E2E_FRONTEND_PORT',
    'PLAYWRIGHT_BROWSERS_PATH',
    'PLAYWRIGHT_CHROMIUM_PATH',
  ]) {
    if (process.env[key]?.trim()) e2eEnvironment[key] = process.env[key].trim()
  }
  const npmStep = (id, label, args, cwd, extra = {}) => commandStep(
    id,
    label,
    nodeExecutable,
    [npmCliArg, ...args],
    cwd,
    { usesNpm: true, env: releaseEnvironment, ...extra },
  )
  const npmDependencyIntegrityStep = (id, label, cwd, requires, requiredPackages) => ({
    id,
    label,
    kind: 'npm-dependency-integrity',
    command: nodeExecutable,
    npmCli: npmCliArg,
    cwd,
    env: releaseEnvironment,
    timeoutMs: 5 * 60 * 1000,
    requires,
    requiredPackages,
    isolatedInstallProof: true,
    checks: [
      { mode: 'tree', args: ['ls', '--all', '--json'] },
    ],
  })
  const preflightArgs = [
    path.join(root, 'scripts', 'agent-preflight.cjs'),
    '--mode=develop',
    '--json',
    '--no-worktree-report',
    ...owned.map((value) => `--owned=${value}`),
    ...excluded.map((value) => `--excluded=${value}`),
  ]

  const plan = [
    {
      id: 'preflight',
      label: 'develop preflight',
      kind: 'preflight',
      command: nodeExecutable,
      args: preflightArgs,
      cwd: root,
      offlineBase,
      timeoutMs: COMMAND_TIMEOUT_MS,
      hardStop: true,
    },
    {
      id: 'git:state-pin',
      label: 'pin HEAD and cached origin/master for this gate run',
      kind: 'git-state-pin',
      cwd: root,
      offlineBase,
      preflightStep: 'preflight',
      hardStop: true,
    },
    {
      id: 'git:committed-scope',
      label: 'committed branch diff stays inside owned and outside excluded paths',
      kind: 'committed-scope',
      cwd: root,
      owned: [...owned],
      excluded: [...excluded],
      initialStep: 'git:state-pin',
      hardStop: true,
    },
    {
      id: 'authority:eol-contract',
      label: 'authority digest with LF/CRLF normalization',
      kind: 'authority-eol',
      root,
      hardStop: true,
    },
    {
      id: 'git:clean-release-tree',
      label: 'clean and fully tracked release tree',
      kind: 'git-clean',
      cwd: root,
      hardStop: true,
    },
    {
      id: 'environment:local-config',
      label: 'no ambient local env or npm configuration files',
      kind: 'absent-paths',
      root,
      paths: [root, frontend, backend].flatMap((directory) => [
        '.npmrc',
        '.env',
        '.env.local',
        '.env.development',
        '.env.development.local',
        '.env.production',
        '.env.production.local',
        '.env.test',
        '.env.test.local',
      ].map((name) => path.join(directory, name))),
      hardStop: true,
    },
    commandStep(
      'selftest:check-no-secrets',
      'scripts/check-no-secrets.selftest.cjs',
      nodeExecutable,
      [path.join(root, 'scripts', 'check-no-secrets.selftest.cjs')],
      root,
      { hardStop: true, env: selftestEnvironment },
    ),
    {
      id: 'secret-scan',
      label: 'tracked tree and pinned branch-range secret scan',
      kind: 'secret-scan',
      command: nodeExecutable,
      scanner: path.join(root, 'scripts', 'check-no-secrets.cjs'),
      cwd: root,
      initialStep: 'git:state-pin',
      timeoutMs: COMMAND_TIMEOUT_MS,
      hardStop: true,
    },
  ]

  plan.push(
    {
      id: 'runtime:node',
      label: `Node ${REQUIRED_NODE_MAJOR}.x release runtime`,
      kind: 'node-runtime',
      root,
    },
    {
      id: 'runtime:npm',
      label: 'npm CLI without shell shims',
      kind: 'npm-runtime',
      nodeExecutable,
      npmCli,
      npmLauncher,
    },
    {
      id: 'runtime:docker-daemon',
      label: 'Docker CLI and daemon/server contract',
      kind: 'docker-daemon',
      command: dockerCommand,
      args: [...DOCKER_VERSION_ARGS],
      cwd: root,
      timeoutMs: 15 * 1000,
      hardStop: true,
    },
  )

  for (const selftest of walkSelftests(path.join(root, 'scripts'))) {
    if (selftestId(root, selftest) === 'selftest:check-no-secrets') continue
    plan.push(commandStep(
      selftestId(root, selftest),
      toPosix(path.relative(root, selftest)),
      nodeExecutable,
      [selftest],
      root,
      { requires: ['runtime:node'], env: selftestEnvironment },
    ))
  }

  plan.push(
    commandStep(
      'build-discipline',
      'build-discipline regression ratchet',
      nodeExecutable,
      [path.join(root, 'scripts', 'build-discipline', 'run-all.cjs'), '--block=C1,C2,C3'],
      root,
      { requires: ['runtime:node'] },
    ),
    {
      id: 'frontend:dependencies',
      label: 'frontend dependency contract',
      kind: 'paths',
      root,
      paths: [
        ...frontendRequiredPackages.map((relative) => path.join(frontend, ...relative.split('/').slice(0, -1))),
      ],
    },
    npmDependencyIntegrityStep(
      'frontend:dependencies:integrity',
      'frontend installed tree and real isolated offline install proof',
      frontend,
      ['runtime:node', 'runtime:npm', 'frontend:dependencies'],
      frontendRequiredPackages,
    ),
    npmStep('frontend:typecheck', 'frontend application TypeScript', ['exec', '--offline', '--', 'tsc', '--noEmit', '--project', 'tsconfig.app.json'], frontend, {
      requires: ['runtime:node', 'runtime:npm', 'frontend:dependencies', 'frontend:dependencies:integrity'],
    }),
    npmStep('frontend:typecheck:config', 'frontend tool configuration TypeScript', ['exec', '--offline', '--', 'tsc', '--noEmit', '--project', 'tsconfig.node.json'], frontend, {
      requires: ['runtime:node', 'runtime:npm', 'frontend:dependencies', 'frontend:dependencies:integrity'],
    }),
    npmStep('frontend:build', 'frontend build', ['run', 'build'], frontend, {
      requires: ['runtime:node', 'runtime:npm', 'frontend:dependencies', 'frontend:dependencies:integrity'],
    }),
    npmStep('frontend:unit', 'frontend unit suite', ['run', 'test'], frontend, {
      requires: ['runtime:node', 'runtime:npm', 'frontend:dependencies', 'frontend:dependencies:integrity'],
    }),
    {
      id: 'backend:dependencies',
      label: 'backend dependency contract',
      kind: 'paths',
      root,
      paths: [
        ...backendRequiredPackages.map((relative) => path.join(backend, ...relative.split('/').slice(0, -1))),
      ],
    },
    npmDependencyIntegrityStep(
      'backend:dependencies:integrity',
      'backend installed tree and real isolated offline install proof',
      backend,
      ['runtime:node', 'runtime:npm', 'backend:dependencies'],
      backendRequiredPackages,
    ),
    npmStep('backend:build', 'backend build', ['run', 'build'], backend, {
      requires: ['runtime:node', 'runtime:npm', 'backend:dependencies', 'backend:dependencies:integrity'],
    }),
    npmStep('backend:unit', 'backend unit suite', ['run', 'test:node'], backend, {
      env: {
        ...releaseEnvironment,
        NODE_ENV: 'test',
        JWT_SECRET: backendUnitJwtSecret,
        DATABASE_PATH: ':memory:',
      },
      requires: ['runtime:node', 'runtime:npm', 'backend:dependencies', 'backend:dependencies:integrity'],
    }),
    {
      id: 'e2e:specs',
      label: 'critical E2E source-file contract',
      kind: 'e2e-spec-contract',
      root,
      paths: DEFAULT_E2E_SPECS.map((spec) => path.join(frontend, spec)),
    },
    {
      id: 'e2e:browser',
      label: 'Playwright Chromium environment contract',
      kind: 'browser',
      frontend,
      requires: ['runtime:node', 'frontend:dependencies', 'frontend:dependencies:integrity'],
    },
    npmStep('e2e:critical', 'critical E2E subset (auth + supplier returns + users)', ['run', 'test:e2e:critical'], frontend, {
      env: e2eEnvironment,
      requires: [
        'runtime:node',
        'runtime:npm',
        'frontend:dependencies',
        'frontend:dependencies:integrity',
        'backend:dependencies',
        'backend:dependencies:integrity',
        'e2e:specs',
        'e2e:browser',
      ],
    }),
    {
      id: 'git:diff-check',
      label: 'Git whitespace check (committed range + working tree)',
      kind: 'git-diff-check',
      cwd: root,
      initialStep: 'git:state-pin',
    },
    {
      id: 'git:clean-release-tree:final',
      label: 'final clean and fully tracked release tree',
      kind: 'git-clean',
      cwd: root,
    },
    {
      id: 'git:state-stability:final',
      label: 'verify HEAD and cached origin/master stayed fixed',
      kind: 'git-state-stability',
      cwd: root,
      initialStep: 'git:state-pin',
    },
  )

  return plan
}

function formatMissingPath(root, absolute) {
  const relative = path.relative(root, absolute)
  return relative && !relative.startsWith('..') ? toPosix(relative) : path.basename(absolute)
}

function runPathCheck(step) {
  const missing = step.paths.filter((candidate) => !fs.existsSync(candidate))
  return missing.length
    ? {
        status: 'BLOCKED',
        detail: `missing local dependencies: ${missing.map((item) => formatMissingPath(step.root, item)).join(', ')}`,
      }
    : { status: 'PASS' }
}

function runE2eSpecContract(step) {
  const invalid = step.paths.filter((candidate) => {
    try {
      return !fs.statSync(candidate).isFile()
    } catch {
      return true
    }
  })
  if (invalid.length) {
    return {
      status: 'FAIL',
      detail: `required source files are missing or not regular files: ${invalid.map((item) => formatMissingPath(step.root, item)).join(', ')}`,
    }
  }

  const violations = []
  for (const candidate of step.paths) {
    let source
    try {
      source = normalizeNewlines(fs.readFileSync(candidate, 'utf8'))
    } catch {
      return { status: 'FAIL', detail: `cannot read required source file: ${formatMissingPath(step.root, candidate)}` }
    }
    for (const rule of E2E_SOURCE_RULES) {
      for (const match of source.matchAll(rule.pattern)) {
        const line = source.slice(0, match.index).split('\n').length
        violations.push(`${formatMissingPath(step.root, candidate)}:${line} ${rule.label}`)
      }
    }
  }
  if (violations.length) {
    const shown = violations.slice(0, 20).join(', ')
    return {
      status: 'FAIL',
      detail: `critical E2E contract violations (${violations.length}): ${shown}${violations.length > 20 ? ', ...' : ''}`,
    }
  }
  return { status: 'PASS' }
}

function runAbsentPathCheck(step) {
  const present = step.paths.filter((candidate) => fs.existsSync(candidate))
  return present.length
    ? {
        status: 'BLOCKED',
        detail: `ambient local config must be removed from the release worktree: ${present.map((item) => formatMissingPath(step.root, item)).join(', ')}`,
      }
    : { status: 'PASS' }
}

function validateBrowserExecutable(candidate, {
  platform = process.platform,
  stat = fs.statSync,
  access = fs.accessSync,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!candidate || !pathApi.isAbsolute(candidate)) {
    return { status: 'BLOCKED', detail: 'browser executable override must be an absolute path' }
  }
  try {
    if (!stat(candidate).isFile()) {
      return { status: 'BLOCKED', detail: 'configured Chromium executable is not a regular file' }
    }
    access(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
    return { status: 'PASS' }
  } catch {
    return { status: 'BLOCKED', detail: 'Chromium executable is not installed, accessible, or executable' }
  }
}

function validateBrowsersPath(value, platform = process.platform) {
  if (value == null || value === '') return { status: 'PASS' }
  if (value !== value.trim()) {
    return { status: 'BLOCKED', detail: 'PLAYWRIGHT_BROWSERS_PATH must not contain surrounding whitespace' }
  }
  const configured = value
  if (configured === '0') return { status: 'PASS' }
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  return pathApi.isAbsolute(configured)
    ? { status: 'PASS' }
    : { status: 'BLOCKED', detail: 'PLAYWRIGHT_BROWSERS_PATH must be 0 or an absolute path' }
}

function runBrowserCheck(step) {
  const browsersPathContract = validateBrowsersPath(process.env.PLAYWRIGHT_BROWSERS_PATH)
  if (browsersPathContract.status !== 'PASS') {
    return { ...browsersPathContract, capability: { executableVerified: false } }
  }
  const explicitPath = process.env.PLAYWRIGHT_CHROMIUM_PATH?.trim()
  if (explicitPath) {
    const outcome = validateBrowserExecutable(explicitPath)
    return { ...outcome, capability: { executableVerified: outcome.status === 'PASS' } }
  }
  try {
    const requireFromFrontend = createRequire(path.join(step.frontend, 'package.json'))
    const { chromium } = requireFromFrontend('playwright')
    const outcome = validateBrowserExecutable(chromium.executablePath())
    return { ...outcome, capability: { executableVerified: outcome.status === 'PASS' } }
  } catch {
    return {
      status: 'BLOCKED',
      detail: 'Playwright-managed Chromium is not installed or accessible',
      capability: { executableVerified: false },
    }
  }
}

function spawnCaptured(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || createReleaseEnvironment(),
    encoding: options.encoding || 'utf8',
    maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    shell: false,
    windowsHide: true,
    timeout: options.timeoutMs || COMMAND_TIMEOUT_MS,
  })
}

function runPreflight(step) {
  const result = spawnCaptured(step.command, step.args, {
    cwd: step.cwd,
    timeoutMs: step.timeoutMs,
  })
  const evidence = spawnEvidence(result)
  const processStatus = classifySpawnResult(result)
  if (processStatus !== 'PASS') {
    return {
      status: processStatus,
      detail: result.error
        ? normalizeNewlines(result.error.message).trim()
        : `preflight process exited ${result.status}`,
      ...evidence,
    }
  }
  try {
    const report = JSON.parse(normalizeNewlines(result.stdout))
    return { ...classifyPreflightReport(report, step.offlineBase), ...evidence }
  } catch {
    return { status: 'FAIL', detail: 'preflight did not return valid JSON', ...evidence }
  }
}

function runAuthorityEolCheck(step) {
  const workingTree = new Map()
  const head = new Map()
  for (const file of AUTHORITY_FILES) {
    try {
      workingTree.set(file, fs.readFileSync(path.join(step.root, ...file.split('/'))))
    } catch {
      return { status: 'FAIL', detail: `cannot read authority file from working tree: ${file}` }
    }

    const blob = spawnCaptured('git', ['show', `HEAD:${file}`], {
      cwd: step.root,
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
    })
    const status = classifySpawnResult(blob)
    if (status !== 'PASS') {
      return { status, detail: `cannot read authority file from HEAD: ${file}` }
    }
    head.set(file, blob.stdout)
  }

  const workingDigest = canonicalAuthorityDigest(workingTree)
  const headDigest = canonicalAuthorityDigest(head)
  return workingDigest === headDigest
    ? { status: 'PASS', detail: `canonical digest ${workingDigest.slice(0, 12)}` }
    : { status: 'FAIL', detail: 'authority content differs from HEAD after LF/CRLF normalization' }
}

function runGitCleanCheck(step) {
  const result = spawnCaptured('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: step.cwd,
    encoding: 'buffer',
  })
  const status = classifySpawnResult(result)
  if (status !== 'PASS') return { status, detail: 'cannot establish clean release-tree state' }
  if (result.stdout.length) {
    return { status: 'FAIL', detail: 'release tree has tracked or untracked changes; no release-ready PASS is allowed' }
  }
  return { status: 'PASS' }
}

function readGitState(cwd) {
  const readRef = (ref) => {
    const result = spawnCaptured('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd })
    const status = classifySpawnResult(result)
    return status === 'PASS'
      ? { status, value: normalizeNewlines(result.stdout).trim().toLowerCase() }
      : { status, detail: `cannot resolve ${ref}` }
  }
  const head = readRef('HEAD')
  if (head.status !== 'PASS') return head
  const base = readRef('origin/master')
  if (base.status !== 'PASS') return base
  const reflogFingerprint = (ref) => {
    const result = spawnCaptured('git', ['reflog', 'show', '--format=%H', ref], { cwd })
    const status = classifySpawnResult(result)
    return status === 'PASS'
      ? { status, value: crypto.createHash('sha256').update(normalizeNewlines(result.stdout), 'utf8').digest('hex') }
      : { status, detail: `cannot fingerprint ${ref} reflog` }
  }
  const headReflog = reflogFingerprint('HEAD')
  if (headReflog.status !== 'PASS') return headReflog
  const baseReflog = reflogFingerprint('refs/remotes/origin/master')
  if (baseReflog.status !== 'PASS') return baseReflog
  return {
    status: 'PASS',
    head: head.value,
    base: base.value,
    headReflog: headReflog.value,
    baseReflog: baseReflog.value,
  }
}

function runGitStatePin(step, preflight) {
  if (preflight?.status !== 'PASS') {
    return { status: 'FAIL', detail: 'preflight repository state was not available for pinning' }
  }
  const state = readGitState(step.cwd)
  if (state.status !== 'PASS') return state
  const shape = compareGitState(state, state)
  if (shape.status !== 'PASS') return shape
  const preflightMatch = compareGitState(preflight, state)
  if (preflightMatch.status !== 'PASS') {
    return { status: 'FAIL', detail: `repository state changed after preflight: ${preflightMatch.detail}` }
  }
  if (step.offlineBase && state.base !== step.offlineBase) {
    return { status: 'FAIL', detail: 'cached origin/master does not match the pinned offline base' }
  }
  return {
    status: 'PASS',
    head: state.head,
    base: state.base,
    headReflog: state.headReflog,
    baseReflog: state.baseReflog,
    detail: `HEAD ${state.head}; base ${state.base}`,
  }
}

function runGitStateStability(step, initial) {
  if (initial?.status !== 'PASS') {
    return { status: 'FAIL', detail: 'initial repository state was not pinned' }
  }
  const current = readGitState(step.cwd)
  if (current.status !== 'PASS') return current
  const comparison = compareGitState(initial, current)
  return comparison.status === 'PASS'
    ? { status: 'PASS', head: current.head, base: current.base }
    : comparison
}

function runCommittedScope(step, initial) {
  const state = compareGitState(initial, initial)
  if (state.status !== 'PASS') return state
  const result = spawnCaptured(
    'git',
    ['diff', '--no-renames', '--name-only', '-z', `${initial.base}...${initial.head}`],
    { cwd: step.cwd, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 },
  )
  const processStatus = classifySpawnResult(result)
  if (processStatus !== 'PASS') {
    return { status: processStatus, detail: 'cannot enumerate the pinned committed branch diff' }
  }
  const files = result.stdout.toString('utf8').split('\0').filter(Boolean)
  const excluded = files.filter((file) => matchesAny(file, step.excluded))
  const foreign = files.filter((file) => !matchesAny(file, step.owned) && !matchesAny(file, step.excluded))
  if (excluded.length || foreign.length) {
    const problems = [
      ...excluded.map((file) => `excluded:${file}`),
      ...foreign.map((file) => `foreign:${file}`),
    ]
    return {
      status: 'FAIL',
      detail: `committed diff violates ownership: ${problems.slice(0, 20).join(', ')}${problems.length > 20 ? ', ...' : ''}`,
    }
  }
  return { status: 'PASS', detail: `${files.length} committed path(s) inside owned scope` }
}

function runNodeRuntimeCheck(step) {
  let configuredMajor
  try {
    const configured = fs.readFileSync(path.join(step.root, '.nvmrc'), 'utf8').trim()
    const match = /^v?(\d+)(?:\.\d+(?:\.\d+)?)?$/.exec(configured)
    configuredMajor = match ? Number(match[1]) : NaN
  } catch {
    return {
      status: 'FAIL',
      detail: 'missing root .nvmrc runtime contract',
      capability: { version: process.versions.node },
    }
  }
  if (configuredMajor !== REQUIRED_NODE_MAJOR) {
    return {
      status: 'FAIL',
      detail: `.nvmrc must pin Node ${REQUIRED_NODE_MAJOR}.x`,
      capability: { version: process.versions.node },
    }
  }
  return isSupportedLocalReleaseNodeVersion(process.versions.node)
    ? {
        status: 'PASS',
        detail: `Node ${process.versions.node} satisfies local release >=${MINIMUM_LOCAL_RELEASE_NODE_VERSION} <23.0.0`,
        capability: { version: process.versions.node },
      }
    : {
        status: 'BLOCKED',
        detail: `local release requires Node >=${MINIMUM_LOCAL_RELEASE_NODE_VERSION} <23.0.0; current runtime is ${process.versions.node}`,
        capability: { version: process.versions.node },
      }
}

function runNpmRuntimeCheck(step) {
  if (!step.npmCli || !fs.existsSync(step.npmCli) || !fs.existsSync(step.npmLauncher)) {
    return {
      status: 'BLOCKED',
      detail: 'npm-cli.js is not installed beside the selected Node runtime',
      capability: { version: null },
    }
  }
  const result = spawnCaptured(step.nodeExecutable, [step.npmCli, '--version'])
  const status = classifySpawnResult(result)
  const version = status === 'PASS' ? normalizeNewlines(result.stdout).trim() : null
  return status === 'PASS'
    ? { status: 'PASS', capability: { version }, ...spawnEvidence(result) }
    : {
        status,
        detail: result.error ? normalizeNewlines(result.error.message).trim() : `npm CLI exited ${result.status}`,
        capability: { version },
        ...spawnEvidence(result),
      }
}

function runNpmDependencyIntegrity(step) {
  for (const check of step.checks) {
    const result = spawnCaptured(step.command, [step.npmCli, ...check.args], {
      cwd: step.cwd,
      env: step.env,
      timeoutMs: step.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    })
    const outcome = classifyDependencyCheck(result, check.mode)
    if (outcome.status !== 'PASS') {
      return {
        status: outcome.status,
        detail: check.mode === 'tree'
          ? 'installed dependency tree does not match the package contract'
          : 'package lock cannot be reproduced from the local offline cache',
      }
    }
  }
  const isolated = runIsolatedOfflineNpmCi(step.cwd, step.command, {
    environment: step.env,
    required: step.requiredPackages,
    timeoutMs: step.timeoutMs,
  })
  return isolated.status === 'PASS'
    ? isolated
    : {
        status: isolated.status,
        detail: isolated.detail || 'package lock cannot be reproduced by a real isolated offline install',
      }
}

function spawnCommand(step, { returnCapturedText = false } = {}) {
  const started = Date.now()
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: step.env || createReleaseEnvironment(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
    timeout: step.timeoutMs,
  })
  const stdout = result.stdout == null ? '' : String(result.stdout)
  const stderr = result.stderr == null ? '' : String(result.stderr)
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  const status = classifySpawnResult(result)
  let detail
  if (result.error) detail = normalizeNewlines(result.error.message).trim()
  else if (result.signal) detail = `terminated by ${result.signal}`
  else if (status !== 'PASS') detail = `exit ${result.status}`
  const outcome = {
    status,
    detail,
    durationMs: Date.now() - started,
    ...spawnEvidence(result),
  }
  if (returnCapturedText) {
    outcome.capturedStdout = stdout
    outcome.capturedStderr = stderr
  }
  return outcome
}

function runGitDiffCheck(step, initial) {
  const state = compareGitState(initial, initial)
  if (state.status !== 'PASS') return state
  const checks = [
    ['diff', '--check', `${initial.base}...${initial.head}`],
    ['diff', '--check'],
  ]
  const outcomes = checks.map((args) => spawnCommand({
    command: 'git',
    args,
    cwd: step.cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
  }, { returnCapturedText: true }))
  const status = overallExitCode(outcomes) === 0
    ? 'PASS'
    : outcomes.some((outcome) => outcome.status === 'FAIL') ? 'FAIL' : 'BLOCKED'
  const firstNonPass = outcomes.find((outcome) => outcome.status !== 'PASS')
  return {
    status,
    detail: firstNonPass?.detail,
    durationMs: outcomes.reduce((total, outcome) => total + (outcome.durationMs || 0), 0),
    exitCode: firstNonPass?.exitCode ?? 0,
    stdoutSha256: sha256Hex(outcomes.map((outcome) => outcome.capturedStdout).join('')),
    stderrSha256: sha256Hex(outcomes.map((outcome) => outcome.capturedStderr).join('')),
  }
}

function readReceiptRepositorySnapshot(cwd) {
  const state = readGitState(cwd)
  if (state.status !== 'PASS') throw new Error(state.detail || 'cannot read repository state for receipt')
  const read = (args, label) => {
    const result = spawnCaptured('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
    if (classifySpawnResult(result) !== 'PASS') throw new Error(`cannot read ${label} for receipt`)
    return normalizeNewlines(result.stdout).trim()
  }
  const headTreeSha = read(['show', '-s', '--format=%T', state.head], 'HEAD tree').toLowerCase()
  const commitsText = read(['rev-list', '--reverse', '--topo-order', `${state.base}..${state.head}`], 'commit list')
  const commits = commitsText ? commitsText.split('\n').map((commit) => commit.toLowerCase()) : []
  const repository = {
    baseSha: state.base,
    headSha: state.head,
    headTreeSha,
    commits,
  }
  validateReceiptRepository(repository)
  return repository
}

function receiptResultItems(results) {
  return results.map((result) => ({
    id: result.id,
    status: RECEIPT_STATUSES.includes(result.status) ? result.status : 'UNVERIFIED',
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    durationMs: Number.isInteger(result.durationMs) && result.durationMs >= 0 ? result.durationMs : 0,
    stdoutSha256: SHA256_PATTERN.test(result.stdoutSha256 || '') ? result.stdoutSha256 : EMPTY_SHA256,
    stderrSha256: SHA256_PATTERN.test(result.stderrSha256 || '') ? result.stderrSha256 : EMPTY_SHA256,
  }))
}

function safeCapabilityVersion(value) {
  return typeof value === 'string' && /^[0-9A-Za-z.+_-]{1,64}$/.test(value) ? value : null
}

function buildReceiptCapabilities(results) {
  const byId = new Map(results.map((result) => [result.id, result]))
  const read = (id) => byId.get(id) || { status: 'UNVERIFIED' }
  const node = read(RECEIPT_CAPABILITY_ITEMS.node)
  const npm = read(RECEIPT_CAPABILITY_ITEMS.npm)
  const browser = read(RECEIPT_CAPABILITY_ITEMS.browser)
  const docker = read(RECEIPT_CAPABILITY_ITEMS.docker)
  return {
    node: {
      status: node.status,
      version: safeCapabilityVersion(node.capability?.version || process.versions.node),
    },
    npm: {
      status: npm.status,
      version: safeCapabilityVersion(npm.capability?.version),
    },
    browser: {
      status: browser.status,
      executableVerified: browser.status === 'PASS' && browser.capability?.executableVerified === true,
    },
    docker: {
      status: docker.status,
      clientVersion: safeCapabilityVersion(docker.capability?.clientVersion),
      serverVersion: safeCapabilityVersion(docker.capability?.serverVersion),
    },
  }
}

function allowlistConfigDigest(owned, excluded) {
  return sha256Hex(canonicalJson({
    owned: [...owned].sort((left, right) => left.localeCompare(right, 'en')),
    excluded: [...excluded].sort((left, right) => left.localeCompare(right, 'en')),
  }))
}

function runSecretScan(step, initial) {
  const state = compareGitState(initial, initial)
  if (state.status !== 'PASS') return state
  const started = Date.now()
  const result = spawnSync(step.command, [step.scanner, '--range', `${initial.base}..${initial.head}`], {
    cwd: step.cwd,
    env: step.env || createReleaseEnvironment(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
    timeout: step.timeoutMs,
  })
  const stdout = result.stdout == null ? '' : String(result.stdout)
  const stderr = result.stderr == null ? '' : String(result.stderr)
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  const status = classifySecretScanResult(result)
  let detail
  if (result.error) detail = normalizeNewlines(result.error.message).trim()
  else if (result.signal) detail = `terminated by ${result.signal}`
  else if (status !== 'PASS') detail = `secret scanner exit ${result.status}`
  return { status, detail, durationMs: Date.now() - started, ...spawnEvidence(result) }
}

function evaluateCriticalTests(tests, requiredSpecs = DEFAULT_E2E_SPECS) {
  const counts = {
    total: tests.length,
    passed: 0,
    skipped: 0,
    flaky: 0,
    unexpected: 0,
    nonPassedExpectation: 0,
    outsideClaimedSpecs: 0,
  }
  const passedBySpec = new Map(requiredSpecs.map((spec) => [toPosix(spec), 0]))

  for (const test of tests) {
    const outcome = typeof test.outcome === 'function' ? test.outcome() : test.outcome
    const expectedStatus = test.expectedStatus || 'passed'
    const location = toPosix(test.location?.file || '')
    const claimedSpec = [...passedBySpec.keys()].find((spec) => location === spec || location.endsWith(`/${spec}`))
    if (!claimedSpec) counts.outsideClaimedSpecs += 1
    if (expectedStatus !== 'passed') counts.nonPassedExpectation += 1
    if (outcome === 'skipped') counts.skipped += 1
    else if (outcome === 'flaky') counts.flaky += 1
    else if (outcome !== 'expected') counts.unexpected += 1
    if (outcome === 'expected' && expectedStatus === 'passed') {
      counts.passed += 1
      if (claimedSpec) passedBySpec.set(claimedSpec, passedBySpec.get(claimedSpec) + 1)
    }
  }

  const missingSpecs = [...passedBySpec.entries()].filter(([, count]) => count === 0).map(([spec]) => spec)
  const detail = [
    ...Object.entries(counts).map(([key, value]) => `${key}=${value}`),
    `missingSpecs=${missingSpecs.length ? missingSpecs.join('|') : 'none'}`,
  ].join(', ')
  return counts.total > 0
    && counts.passed === counts.total
    && counts.outsideClaimedSpecs === 0
    && missingSpecs.length === 0
    ? { status: 'PASS', detail, counts, missingSpecs }
    : { status: 'FAIL', detail, counts, missingSpecs }
}

class LocalReleasePlaywrightReporter {
  onBegin(_config, suite) {
    this.suite = suite
  }

  onEnd() {
    const tests = this.suite?.allTests?.() || []
    const result = evaluateCriticalTests(tests)
    if (result.status === 'PASS') return undefined
    process.stderr.write(`[FAIL] critical E2E result contract - ${result.detail}\n`)
    return { status: 'failed' }
  }
}

function executeStep(step) {
  if (step.kind === 'preflight') return runPreflight(step)
  if (step.kind === 'authority-eol') return runAuthorityEolCheck(step)
  if (step.kind === 'git-clean') return runGitCleanCheck(step)
  if (step.kind === 'node-runtime') return runNodeRuntimeCheck(step)
  if (step.kind === 'npm-runtime') return runNpmRuntimeCheck(step)
  if (step.kind === 'docker-daemon') return runDockerDaemonCheck(step)
  if (step.kind === 'npm-dependency-integrity') return runNpmDependencyIntegrity(step)
  if (step.kind === 'paths') return runPathCheck(step)
  if (step.kind === 'e2e-spec-contract') return runE2eSpecContract(step)
  if (step.kind === 'absent-paths') return runAbsentPathCheck(step)
  if (step.kind === 'browser') return runBrowserCheck(step)
  return spawnCommand(step)
}

function executePlan(plan) {
  const results = []
  const byId = new Map()
  let hardStop

  for (const step of plan) {
    process.stdout.write(`\n==> ${step.id}: ${step.label}\n`)
    const started = Date.now()
    const unmet = (step.requires || []).filter((id) => byId.get(id)?.status !== 'PASS')
    let outcome
    if (hardStop) {
      outcome = { status: 'BLOCKED', detail: `hard-stopped by ${hardStop}` }
    } else if (unmet.length) {
      outcome = { status: 'BLOCKED', detail: `blocked by ${unmet.join(', ')}` }
    } else if (step.kind === 'git-state-pin') {
      outcome = runGitStatePin(step, byId.get(step.preflightStep))
    } else if (step.kind === 'committed-scope') {
      outcome = runCommittedScope(step, byId.get(step.initialStep))
    } else if (step.kind === 'secret-scan') {
      outcome = runSecretScan(step, byId.get(step.initialStep))
    } else if (step.kind === 'git-diff-check') {
      outcome = runGitDiffCheck(step, byId.get(step.initialStep))
    } else if (step.kind === 'git-state-stability') {
      outcome = runGitStateStability(step, byId.get(step.initialStep))
    } else {
      outcome = executeStep(step)
    }

    const result = {
      id: step.id,
      label: step.label,
      ...outcome,
      durationMs: outcome.durationMs ?? (Date.now() - started),
      exitCode: outcome.exitCode ?? null,
      stdoutSha256: outcome.stdoutSha256 || EMPTY_SHA256,
      stderrSha256: outcome.stderrSha256 || EMPTY_SHA256,
    }
    results.push(result)
    byId.set(step.id, result)
    process.stdout.write(`[${result.status}] ${step.id}${result.detail ? ` - ${result.detail}` : ''}\n`)
    if (!hardStop && step.hardStop && result.status !== 'PASS') hardStop = step.id
  }

  return results
}

function assertSafeScopeValue(flag, value) {
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`${flag} requires a non-empty single-line path pattern`)
  return value
}

function assertOfflineBase(value) {
  if (!/^[0-9a-f]{40}$/i.test(value || '')) throw new Error('--offline-base requires a full 40-character commit SHA')
  return value.toLowerCase()
}

function parseArgs(argv) {
  const options = { owned: [], excluded: [], offlineBase: null, receiptTarget: null, help: false }
  const setReceiptTarget = (value) => {
    if (options.receiptTarget !== null) throw new Error('--receipt may be provided only once')
    options.receiptTarget = assertSafeScopeValue('--receipt', value)
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg.startsWith('--owned=')) options.owned.push(assertSafeScopeValue('--owned', arg.slice(8)))
    else if (arg === '--owned') options.owned.push(assertSafeScopeValue('--owned', argv[++index]))
    else if (arg.startsWith('--excluded=')) options.excluded.push(assertSafeScopeValue('--excluded', arg.slice(11)))
    else if (arg === '--excluded') options.excluded.push(assertSafeScopeValue('--excluded', argv[++index]))
    else if (arg.startsWith('--offline-base=')) options.offlineBase = assertOfflineBase(arg.slice(15))
    else if (arg === '--offline-base') options.offlineBase = assertOfflineBase(argv[++index])
    else if (arg.startsWith('--receipt=')) setReceiptTarget(arg.slice(10))
    else if (arg === '--receipt') setReceiptTarget(argv[++index])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function printUsage(stream = process.stdout) {
  stream.write([
    'Usage:',
    '  node scripts/local-release-gate.cjs [--offline-base=<full-sha>] [--receipt=<absolute-outside-repo-path>] --owned=<path/glob> [...] --excluded=<path/glob> [...]',
    '',
    'The gate is offline and fail-closed. Missing dependencies, Chromium, or Docker daemon are BLOCKED (exit 2).',
    'Test/build failures are FAIL (exit 1). All PASS returns exit 0.',
    'When --receipt is provided, one canonical JSON receipt is atomically created without overwrite.',
    '',
  ].join('\n'))
}

function printSummary(results) {
  process.stdout.write('\nLocal release gate summary\n')
  for (const result of results) {
    const duration = result.durationMs == null ? '' : ` (${(result.durationMs / 1000).toFixed(1)}s)`
    process.stdout.write(`  ${result.status.padEnd(7)} ${result.id}${duration}\n`)
  }
  process.stdout.write(
    `  SCOPE   critical E2E only: ${DEFAULT_E2E_SPECS.join(', ')}; full E2E was NOT RUN and is not claimed green.\n`,
  )
  const verifiedState = results.find((result) => result.id === 'git:state-stability:final' && result.status === 'PASS')
  if (verifiedState) {
    process.stdout.write(`  VERIFIED HEAD ${verifiedState.head}; base ${verifiedState.base}\n`)
  }
}

function main(argv = process.argv.slice(2)) {
  let options
  let plan
  let receiptContext
  try {
    options = parseArgs(argv)
    if (options.help) {
      printUsage()
      return 0
    }
    if (!options.owned.length || !options.excluded.length) {
      throw new Error('both --owned and --excluded are required by the local ownership contract')
    }
    plan = buildPlan({
      root: ROOT,
      offlineBase: options.offlineBase,
      owned: options.owned,
      excluded: options.excluded,
    })
    if (options.receiptTarget) {
      receiptContext = {
        target: validateReceiptTarget(options.receiptTarget, { repositoryRoot: ROOT }),
        repository: readReceiptRepositorySnapshot(ROOT),
        gateToolSha256: sha256Hex(fs.readFileSync(__filename)),
        allowlistConfigSha256: allowlistConfigDigest(options.owned, options.excluded),
        deliveryId: crypto.randomUUID(),
        nonce: crypto.randomBytes(32).toString('hex'),
      }
    }
  } catch (error) {
    process.stderr.write(`local-release-gate: ${normalizeNewlines(error.message).trim()}\n`)
    printUsage(process.stderr)
    return 2
  }

  const results = executePlan(plan)
  printSummary(results)
  const gateExitCode = overallExitCode(results)
  if (receiptContext) {
    try {
      const finalRepository = readReceiptRepositorySnapshot(ROOT)
      if (canonicalJson(finalRepository) !== canonicalJson(receiptContext.repository)) {
        throw new Error('repository base/head/tree/commit list changed before receipt publication')
      }
      const finalToolSha256 = sha256Hex(fs.readFileSync(__filename))
      if (finalToolSha256 !== receiptContext.gateToolSha256) {
        throw new Error('gate tool SHA-256 changed before receipt publication')
      }
      const items = receiptResultItems(results)
      const receipt = buildCanonicalGateReceipt({
        repository: receiptContext.repository,
        gateToolSha256: receiptContext.gateToolSha256,
        allowlistConfigSha256: receiptContext.allowlistConfigSha256,
        deliveryId: receiptContext.deliveryId,
        nonce: receiptContext.nonce,
        gateExitCode,
        planItemIds: plan.map((step) => step.id),
        results: items,
        capabilities: buildReceiptCapabilities(results),
      })
      writeCanonicalReceiptAtomic(receiptContext.target, receipt, { repositoryRoot: ROOT })
      process.stdout.write(
        `  RECEIPT deliveryId=${receipt.deliveryId} rootSha256=${receipt.receiptRootSha256} admissible=${receipt.admissible}\n`,
      )
    } catch (error) {
      process.stderr.write(`local-release-gate receipt: ${normalizeNewlines(error.message).trim()}\n`)
      return 1
    }
  }
  return gateExitCode
}

if (require.main === module) process.exitCode = main()

module.exports = {
  default: LocalReleasePlaywrightReporter,
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
  classifyPreflightReport,
  classifyDependencyCheck,
  classifySpawnResult,
  classifySecretScanResult,
  compareGitState,
  createReleaseEnvironment,
  createSelftestEnvironment,
  executePlan,
  evaluateCriticalTests,
  main,
  normalizeNewlines,
  overallExitCode,
  parseArgs,
  resolveNpmCli,
  runCommittedScope,
  runDockerDaemonCheck,
  runE2eSpecContract,
  validateReceiptTarget,
  validateBrowserExecutable,
  validateBrowsersPath,
  verifyCanonicalGateReceipt,
  writeCanonicalReceiptAtomic,
}
