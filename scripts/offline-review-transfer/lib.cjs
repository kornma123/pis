#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { TextDecoder } = require('node:util')

const DELIVERY_SCHEMA = 'coreone-offline-review-delivery/v1'
const FINDINGS_SCHEMA = 'coreone-offline-review-findings/v1'
const PATH_POLICY = 'coreone-offline-review-paths/v1'
const REVIEW_INSTRUCTIONS_VERSION = 'coreone-fixed-sha-review/v1'
const BASE_ANCHOR = 'refs/remotes/origin/master'
const PACKAGE_FILES = ['SHA256SUMS', 'delivery.bundle', 'manifest.json']
const RETURN_FILES = ['SHA256SUMS', 'findings.json']
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_FINDINGS_BYTES = 1024 * 1024
const MAX_CHECKSUM_BYTES = 4096
const MAX_BUNDLE_BYTES = 128 * 1024 * 1024
const MAX_COMMITS = 128
const MAX_FILES = 1000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_RANGE_BYTES = 64 * 1024 * 1024
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const SHA1_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const SAFE_OUTPUT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const DANGEROUS_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
  '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3',
  '.bundle', '.zip', '.7z', '.rar', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.zst', '.lz4',
])
const METADATA_SECRET_RULES = [
  { name: 'github-token', re: /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/ },
  { name: 'openai-style-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/ },
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/ },
  { name: 'compact-jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{16,}\b/ },
]
const GIT_ENV = Object.freeze({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_NO_REPLACE_OBJECTS: '1',
})

class ContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ContractError'
  }
}

function fail(message) {
  throw new ContractError(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: options.encoding === undefined ? 'utf8' : options.encoding,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout || 120_000,
    maxBuffer: options.maxBuffer || 256 * 1024 * 1024,
    env: options.env || GIT_ENV,
  })
  if (result.error) fail(`${options.label || command} could not run: ${result.error.message}`)
  if (result.signal) fail(`${options.label || command} terminated by ${result.signal}`)
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : Buffer.from(result.stderr || '').toString('utf8').trim()
    const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : Buffer.from(result.stdout || '').toString('utf8').trim()
    fail(`${options.label || command} failed (exit ${result.status}): ${stderr || stdout || 'no diagnostic'}`)
  }
  return result
}

function git(repo, args, options = {}) {
  return run('git', ['-c', 'core.quotepath=false', '-c', 'core.excludesFile=', '-C', repo, ...args], {
    ...options,
    label: options.label || `git ${args[0]}`,
  })
}

function gitText(repo, args, options = {}) {
  return git(repo, args, options).stdout.trim()
}

function gitSucceeds(repo, args) {
  return git(repo, args, { allowFailure: true }).status === 0
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function sha256File(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`artifact is not a regular file: ${file}`)
  if (stat.size > MAX_BUNDLE_BYTES) fail(`artifact exceeds size limit: ${path.basename(file)}`)
  return sha256Bytes(fs.readFileSync(file))
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) fail('canonical JSON only accepts plain objects')
  const keys = Object.keys(value).sort()
  for (const key of keys) {
    if (value[key] === undefined) fail(`canonical JSON rejects undefined at ${key}`)
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

function writeCanonical(file, value) {
  fs.writeFileSync(file, canonicalJson(value), { encoding: 'utf8', flag: 'wx' })
}

function samePath(left, right) {
  const normalize = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
  return normalize(left) === normalize(right)
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveExistingDirectory(input, label) {
  if (typeof input !== 'string' || !input) fail(`${label} path is required`)
  const requested = path.resolve(input)
  let stat
  try {
    stat = fs.lstatSync(requested)
  } catch (error) {
    fail(`${label} does not exist: ${requested}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a real directory, not a link: ${requested}`)
  const real = fs.realpathSync(requested)
  if (!samePath(real, requested)) fail(`${label} path aliases are not accepted: ${requested}`)
  return real
}

function planNewDirectory(input, label, forbiddenRoots = []) {
  if (typeof input !== 'string' || !input) fail(`${label} path is required`)
  const requested = path.resolve(input)
  if (fs.existsSync(requested)) fail(`${label} already exists; refusing overwrite: ${requested}`)
  const basename = path.basename(requested)
  if (!SAFE_OUTPUT_NAME_RE.test(basename) || basename === '.' || basename === '..') fail(`${label} has an unsafe directory name: ${basename}`)
  const parent = resolveExistingDirectory(path.dirname(requested), `${label} parent`)
  const planned = path.join(parent, basename)
  const enclosing = git(parent, ['rev-parse', '--show-toplevel'], { allowFailure: true, label: 'detect enclosing worktree' })
  if (enclosing.status === 0) {
    const enclosingRoot = fs.realpathSync(enclosing.stdout.trim())
    if (isWithin(enclosingRoot, planned)) fail(`${label} must not be created inside any live Git worktree`)
  }
  for (const forbidden of forbiddenRoots) {
    if (isWithin(forbidden, planned)) fail(`${label} must be outside ${forbidden}`)
  }
  return { path: planned, parent, basename }
}

function makeStagingDirectory(plan, suffix) {
  return fs.mkdtempSync(path.join(plan.parent, `.${plan.basename}.${suffix}-`))
}

function cleanupOwnedDirectory(directory) {
  if (!directory || !fs.existsSync(directory)) return
  fs.rmSync(directory, { recursive: true, force: true })
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (canonicalJson(actual) !== canonicalJson(wanted)) fail(`${label} keys do not match the contract`)
}

function assertString(value, label, min = 1, max = 4096) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${label} must be a string of length ${min}..${max}`)
  if (/\u0000/.test(value)) fail(`${label} contains NUL`)
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.join(', ')}`)
}

function assertInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer in ${min}..${max}`)
}

function assertSha1(value, label) {
  if (typeof value !== 'string' || !SHA1_RE.test(value)) fail(`${label} must be a lowercase SHA-1 object id`)
}

function assertSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_RE.test(value)) fail(`${label} must be a lowercase SHA-256 digest`)
}

function assertIsoTime(value, label) {
  assertString(value, label, 20, 40)
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(`${label} must be canonical UTC ISO-8601`)
}

function normalizeOriginLocator(raw) {
  assertString(raw, 'remote.origin.url', 3, 2048)
  if (/\s|[\u0000-\u001f\u007f]/.test(raw)) fail('remote.origin.url contains unsafe whitespace or controls')
  const scp = raw.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/)
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    const host = scp[1].toLowerCase()
    const pathname = scp[2].replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    if (!host || !pathname || pathname.includes('..') || pathname.includes('\\')) fail('remote.origin.url cannot form a stable repository identity')
    return `${host}/${pathname}`
  }
  let url
  try {
    url = new URL(raw)
  } catch (error) {
    fail('remote.origin.url must be an http(s), ssh, or scp-style stable locator')
  }
  if (!['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) fail(`remote.origin.url protocol is not identity-safe: ${url.protocol}`)
  if (!url.hostname || url.search || url.hash) fail('remote.origin.url must not contain query/fragment data')
  const defaultPort = (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80') || (url.protocol === 'ssh:' && url.port === '22')
  const host = `${url.hostname.toLowerCase()}${url.port && !defaultPort ? `:${url.port}` : ''}`
  const pathname = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!pathname || pathname.split('/').some((segment) => !segment || segment === '.' || segment === '..')) fail('remote.origin.url path is not identity-safe')
  return `${host}/${pathname}`
}

function repositoryIdentity(originLocatorSha256, base, baseTree, objectFormat) {
  return sha256Bytes(Buffer.from(`${DELIVERY_SCHEMA}\0${objectFormat}\0${originLocatorSha256}\0${base}\0${baseTree}`, 'utf8'))
}

function deliveryId(identity, base, head) {
  return sha256Bytes(Buffer.from(`${DELIVERY_SCHEMA}\0${identity}\0${base}\0${head}`, 'utf8'))
}

function resolveRepo(input, options = {}) {
  const requested = resolveExistingDirectory(input, options.label || 'repository')
  const inside = gitText(requested, ['rev-parse', '--is-inside-work-tree'])
  if (inside !== 'true') fail('repository must be a non-bare Git worktree')
  const root = fs.realpathSync(gitText(requested, ['rev-parse', '--show-toplevel']))
  if (!samePath(root, requested)) fail(`--repo must name the worktree root exactly: ${root}`)
  if (gitText(root, ['rev-parse', '--is-bare-repository']) !== 'false') fail('bare repositories are not accepted as the target worktree')
  const objectFormat = gitText(root, ['rev-parse', '--show-object-format'])
  if (objectFormat !== 'sha1') fail(`unsupported Git object format: ${objectFormat}`)
  if (gitText(root, ['rev-parse', '--is-shallow-repository']) !== 'false') fail('shallow repositories are not accepted')
  if (gitText(root, ['for-each-ref', '--format=%(refname)', 'refs/replace'])) fail('replace refs are forbidden for fixed-history transfer')
  const graftsRaw = gitText(root, ['rev-parse', '--git-path', 'info/grafts'])
  const grafts = path.isAbsolute(graftsRaw) ? graftsRaw : path.resolve(root, graftsRaw)
  if (fs.existsSync(grafts) && fs.lstatSync(grafts).size > 0) fail('Git grafts are forbidden for fixed-history transfer')
  const originRaw = gitText(root, ['config', '--get', 'remote.origin.url'])
  const originLocatorSha256 = sha256Bytes(Buffer.from(normalizeOriginLocator(originRaw), 'utf8'))
  const cachedBase = gitText(root, ['rev-parse', '--verify', `${BASE_ANCHOR}^{commit}`])
  assertSha1(cachedBase, BASE_ANCHOR)
  const baseTree = gitText(root, ['show', '-s', '--format=%T', cachedBase])
  assertSha1(baseTree, 'base tree')
  const identity = repositoryIdentity(originLocatorSha256, cachedBase, baseTree, objectFormat)
  if (options.requireClean) {
    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], { encoding: null }).stdout
    if (status.length !== 0) {
      const summary = Buffer.from(status).toString('utf8').replaceAll('\0', ' | ').slice(0, 1000)
      fail(`source/target worktree and index must be clean; dirty state blocks this operation: ${summary}`)
    }
  }
  return { root, objectFormat, originLocatorSha256, cachedBase, baseTree, identity }
}

function requireCommit(repo, requested, label) {
  assertSha1(requested, label)
  const resolved = gitText(repo, ['rev-parse', '--verify', `${requested}^{commit}`])
  if (resolved !== requested) fail(`${label} does not resolve to the exact requested commit`)
}

function linearCommitList(repo, base, head) {
  if (base === head) fail('head must be a strict descendant of base; empty deliveries are refused')
  const ancestor = git(repo, ['merge-base', '--is-ancestor', base, head], { allowFailure: true })
  if (ancestor.status !== 0) fail('base is not an ancestor of head')
  const lines = gitText(repo, ['rev-list', '--reverse', '--topo-order', '--parents', `${base}..${head}`]).split(/\r?\n/).filter(Boolean)
  if (!lines.length || lines.length > MAX_COMMITS) fail(`commit count must be 1..${MAX_COMMITS}`)
  const commits = []
  let expectedParent = base
  for (const line of lines) {
    const parts = line.trim().split(/ +/)
    if (parts.length !== 2) fail('delivery history must be one linear ancestor chain; merge commits are forbidden')
    const [sha, parent] = parts
    assertSha1(sha, 'commit sha')
    assertSha1(parent, 'commit parent')
    if (parent !== expectedParent) fail('delivery history is not one contiguous ancestor chain')
    const tree = gitText(repo, ['show', '-s', '--format=%T', sha])
    assertSha1(tree, 'commit tree')
    commits.push({ parent, sha, tree })
    expectedParent = sha
  }
  if (expectedParent !== head) fail('linear commit chain does not terminate at head')
  return commits
}

function decodeUtf8(buffer, label) {
  try {
    return UTF8.decode(buffer)
  } catch (error) {
    fail(`${label} is not valid UTF-8`)
  }
}

function assertSafeRepoPath(value, label = 'repository path') {
  assertString(value, label, 1, 240)
  if (value !== value.normalize('NFC')) fail(`${label} must use NFC Unicode normalization`)
  if (Buffer.byteLength(value, 'utf8') > 240) fail(`${label} is too long for safe cross-device transfer`)
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\')) fail(`${label} is absolute or uses a backslash`)
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${label} contains control characters`)
  const segments = value.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) fail(`${label} contains traversal or empty segments`)
  for (const segment of segments) {
    if (segment.length > 120 || /[ .]$/.test(segment) || WINDOWS_RESERVED.test(segment)) fail(`${label} is unsafe on Windows: ${value}`)
    const lower = segment.toLowerCase()
    if (lower === '.git' || lower === '.gitmodules' || lower === 'node_modules') fail(`${label} contains a dangerous path segment: ${segment}`)
    if (lower === '.env' || lower.startsWith('.env.')) fail(`${label} contains a forbidden environment file: ${segment}`)
    if (lower === 'id_rsa' || lower === 'id_ed25519' || lower === 'credentials' || lower === 'credentials.json') fail(`${label} contains a credential-bearing name: ${segment}`)
  }
  const lowerPath = value.toLowerCase()
  for (const extension of DANGEROUS_EXTENSIONS) {
    if (lowerPath.endsWith(extension)) fail(`${label} has a forbidden dangerous extension: ${extension}`)
  }
}

function parseNameStatus(buffer) {
  const fields = buffer.toString('binary').split('\0')
  if (fields.at(-1) !== '') fail('git name-status output was not NUL terminated')
  fields.pop()
  if (fields.length % 2 !== 0) fail('git name-status output is malformed')
  const items = []
  for (let index = 0; index < fields.length; index += 2) {
    const status = Buffer.from(fields[index], 'binary').toString('ascii')
    const file = decodeUtf8(Buffer.from(fields[index + 1], 'binary'), 'changed path')
    if (!/^[AMDT]$/.test(status)) fail(`unsupported diff status: ${status}`)
    items.push({ path: file, status })
  }
  return items
}

function treeEntry(repo, commit, file) {
  const result = git(repo, ['ls-tree', '-z', '-l', commit, '--', file], { encoding: null }).stdout
  if (!result.length) return null
  const records = result.subarray(0, result.length - 1).toString('binary').split('\0')
  if (records.length !== 1) fail(`tree lookup is ambiguous for ${file}`)
  const tab = records[0].indexOf('\t')
  if (tab < 0) fail(`tree lookup is malformed for ${file}`)
  const header = Buffer.from(records[0].slice(0, tab), 'binary').toString('ascii').trim().split(/ +/)
  const decodedPath = decodeUtf8(Buffer.from(records[0].slice(tab + 1), 'binary'), 'tree path')
  if (decodedPath !== file || header.length !== 4) fail(`tree lookup mismatch for ${file}`)
  const [mode, type, object, sizeText] = header
  if (type !== 'blob' || !['100644', '100755'].includes(mode)) fail(`dangerous symlink, submodule, or non-regular path is forbidden: ${file}`)
  assertSha1(object, `object for ${file}`)
  const bytes = Number(sizeText)
  assertInteger(bytes, `size for ${file}`, 0, MAX_FILE_BYTES)
  return { bytes, mode, object }
}

function changedFileList(repo, base, head) {
  const diff = git(repo, ['diff', '--name-status', '-z', '--no-renames', '--diff-filter=AMDT', base, head], { encoding: null }).stdout
  const changes = parseNameStatus(diff)
  if (!changes.length || changes.length > MAX_FILES) fail(`changed file count must be 1..${MAX_FILES}`)
  let totalBytes = 0
  const files = changes.map(({ path: file, status }) => {
    assertSafeRepoPath(file, 'changed path')
    const before = treeEntry(repo, base, file)
    const after = treeEntry(repo, head, file)
    if (status === 'A' && (before || !after)) fail(`added path does not match trees: ${file}`)
    if (status === 'D' && (!before || after)) fail(`deleted path does not match trees: ${file}`)
    if (['M', 'T'].includes(status) && (!before || !after)) fail(`modified path does not match trees: ${file}`)
    const selected = status === 'D' ? before : after
    totalBytes += selected.bytes
    if (totalBytes > MAX_RANGE_BYTES) fail(`changed file payload exceeds ${MAX_RANGE_BYTES} bytes`)
    return { bytes: selected.bytes, mode: selected.mode, object: selected.object, path: file, status }
  })
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].path === files[index].path) fail(`duplicate changed path: ${files[index].path}`)
  }
  return files
}

function assertNoSecretText(text, label) {
  for (const rule of METADATA_SECRET_RULES) {
    if (rule.re.test(text)) fail(`secret scan blocked ${label}: ${rule.name}`)
  }
}

function scanCommitMetadata(repo, commits) {
  for (const commit of commits) {
    const size = Number(gitText(repo, ['cat-file', '-s', commit.sha]))
    assertInteger(size, `commit object size ${commit.sha}`, 1, MAX_MANIFEST_BYTES)
    const raw = git(repo, ['cat-file', 'commit', commit.sha], { encoding: null, maxBuffer: MAX_MANIFEST_BYTES + 1 }).stdout
    assertNoSecretText(Buffer.from(raw).toString('latin1'), `export: commit metadata ${commit.sha}`)
  }
}

function runSecretScan(repo, base, head, commits) {
  const scanner = path.resolve(__dirname, '..', 'check-no-secrets.cjs')
  const toolRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'))
  const stat = fs.lstatSync(scanner)
  if (!stat.isFile() || stat.isSymbolicLink()) fail('repository secret scanner is missing or unsafe')
  if (samePath(toolRoot, repo)) {
    const scannerAtBase = gitText(repo, ['rev-parse', `${base}:scripts/check-no-secrets.cjs`])
    const scannerAtHead = gitText(repo, ['rev-parse', `${head}:scripts/check-no-secrets.cjs`])
    if (scannerAtBase !== scannerAtHead) fail('secret scanner cannot be changed inside the delivery it is scanning')
  }
  const result = run(process.execPath, [scanner, '--range', `${base}..${head}`], {
    cwd: repo,
    allowFailure: true,
    label: 'secret scan',
  })
  if (result.status !== 0) fail(`secret scan blocked export: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`)
  scanCommitMetadata(repo, commits)
  return sha256File(scanner)
}

function bundleHeads(repo, bundleFile) {
  const output = gitText(repo, ['bundle', 'list-heads', bundleFile])
  if (!output) fail('bundle advertises no refs')
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^([0-9a-f]{40})\s+(.+)$/)
    if (!match) fail('bundle advertised-ref output is malformed')
    return { name: match[2], sha: match[1] }
  })
}

function makeFindingsTemplate(manifest, manifestSha256) {
  return {
    base: manifest.range.base,
    deliveryId: manifest.deliveryId,
    deliveryManifestSha256: manifestSha256,
    evidence: [],
    findings: [],
    head: manifest.range.head,
    reviewRef: manifest.range.reviewRef,
    reviewedAt: null,
    reviewer: {
      identity: '',
      independence: '',
      kind: 'manual-claude-trigger',
      model: '',
    },
    schema: FINDINGS_SCHEMA,
    status: 'NOT_REVIEWED',
    summary: { confirmed: 0, refuted: 0, unverified: 0 },
    unverifiedBoundaries: ['Claude review has not been run; this file is only a template.'],
    verdict: 'UNVERIFIED',
  }
}

function createManifest(repoInfo, base, head, commits, files, generatedAt, bundleMeta, scannerSha256) {
  const id = deliveryId(repoInfo.identity, base, head)
  return {
    bundle: bundleMeta,
    deliveryId: id,
    generatedAt,
    range: {
      base,
      commits,
      files,
      head,
      reviewRef: `refs/review/offline/${head}`,
    },
    repository: {
      baseAnchor: BASE_ANCHOR,
      baseTree: repoInfo.baseTree,
      identity: repoInfo.identity,
      objectFormat: repoInfo.objectFormat,
      originLocatorSha256: repoInfo.originLocatorSha256,
    },
    review: {
      findingsSchema: FINDINGS_SCHEMA,
      instructionsVersion: REVIEW_INSTRUCTIONS_VERSION,
      mode: 'MANUAL_CLAUDE_TRIGGER_ONLY',
      status: 'NOT_REVIEWED',
    },
    schema: DELIVERY_SCHEMA,
    security: {
      dangerousPathPolicy: { policy: PATH_POLICY, status: 'PASS' },
      secretScan: { scanner: 'scripts/check-no-secrets.cjs', scannerSha256, scope: 'changed-blobs-and-commit-metadata', status: 'PASS' },
      singleAncestorChain: { status: 'PASS' },
      sourceWorktree: { status: 'CLEAN' },
    },
    testEvidence: {
      claims: [],
      note: 'No test result is asserted by this manifest; add only independently verified evidence to the manual findings.',
      status: 'NOT_PROVIDED',
    },
  }
}

function validateManifestRepository(manifest) {
  assertKeys(manifest.repository, ['baseAnchor', 'baseTree', 'identity', 'objectFormat', 'originLocatorSha256'], 'repository')
  if (manifest.repository.baseAnchor !== BASE_ANCHOR || manifest.repository.objectFormat !== 'sha1') fail('manifest repository anchor/object format is invalid')
  assertSha1(manifest.repository.baseTree, 'repository.baseTree')
  assertSha256(manifest.repository.identity, 'repository.identity')
  assertSha256(manifest.repository.originLocatorSha256, 'repository.originLocatorSha256')
  const expectedIdentity = repositoryIdentity(
    manifest.repository.originLocatorSha256,
    manifest.range.base,
    manifest.repository.baseTree,
    manifest.repository.objectFormat,
  )
  if (manifest.repository.identity !== expectedIdentity) fail('manifest repository identity is inconsistent')
  if (manifest.deliveryId !== deliveryId(expectedIdentity, manifest.range.base, manifest.range.head)) fail('manifest deliveryId is inconsistent')
}

function validateManifestRange(manifest) {
  assertKeys(manifest.range, ['base', 'commits', 'files', 'head', 'reviewRef'], 'range')
  assertSha1(manifest.range.base, 'range.base')
  assertSha1(manifest.range.head, 'range.head')
  if (manifest.range.base === manifest.range.head) fail('manifest describes an empty delivery')
  const expectedRef = `refs/review/offline/${manifest.range.head}`
  if (manifest.range.reviewRef !== expectedRef || !gitCheckRefFormat(expectedRef)) fail('manifest reviewRef is invalid')

  if (!Array.isArray(manifest.range.commits) || manifest.range.commits.length < 1 || manifest.range.commits.length > MAX_COMMITS) fail('manifest commit list size is invalid')
  let expectedParent = manifest.range.base
  for (const [index, commit] of manifest.range.commits.entries()) {
    assertKeys(commit, ['parent', 'sha', 'tree'], `commit[${index}]`)
    assertSha1(commit.parent, `commit[${index}].parent`)
    assertSha1(commit.sha, `commit[${index}].sha`)
    assertSha1(commit.tree, `commit[${index}].tree`)
    if (commit.parent !== expectedParent) fail('manifest commit list is not one contiguous chain')
    expectedParent = commit.sha
  }
  if (expectedParent !== manifest.range.head) fail('manifest commit list does not terminate at head')

  if (!Array.isArray(manifest.range.files) || manifest.range.files.length < 1 || manifest.range.files.length > MAX_FILES) fail('manifest file list size is invalid')
  let priorPath = null
  let totalBytes = 0
  for (const [index, file] of manifest.range.files.entries()) {
    assertKeys(file, ['bytes', 'mode', 'object', 'path', 'status'], `file[${index}]`)
    assertSafeRepoPath(file.path, `file[${index}].path`)
    assertEnum(file.status, ['A', 'M', 'D', 'T'], `file[${index}].status`)
    assertEnum(file.mode, ['100644', '100755'], `file[${index}].mode`)
    assertSha1(file.object, `file[${index}].object`)
    assertInteger(file.bytes, `file[${index}].bytes`, 0, MAX_FILE_BYTES)
    totalBytes += file.bytes
    if (totalBytes > MAX_RANGE_BYTES) fail('manifest file payload exceeds limit')
    if (priorPath !== null && priorPath >= file.path) fail('manifest file list must be sorted and unique')
    priorPath = file.path
  }
}

function validateManifestBundle(manifest) {
  assertKeys(manifest.bundle, ['advertisedRefs', 'bytes', 'file', 'format', 'sha256'], 'bundle')
  if (manifest.bundle.file !== 'delivery.bundle' || manifest.bundle.format !== 'git-bundle-v2') fail('manifest bundle metadata is invalid')
  assertInteger(manifest.bundle.bytes, 'bundle.bytes', 1, MAX_BUNDLE_BYTES)
  assertSha256(manifest.bundle.sha256, 'bundle.sha256')
  if (!Array.isArray(manifest.bundle.advertisedRefs) || manifest.bundle.advertisedRefs.length !== 1) fail('bundle must advertise exactly one ref')
  assertKeys(manifest.bundle.advertisedRefs[0], ['name', 'sha'], 'bundle.advertisedRefs[0]')
  if (manifest.bundle.advertisedRefs[0].name !== 'HEAD' || manifest.bundle.advertisedRefs[0].sha !== manifest.range.head) fail('bundle advertised head does not match manifest head')
}

function validateManifestSecurity(manifest) {
  assertKeys(manifest.security, ['dangerousPathPolicy', 'secretScan', 'singleAncestorChain', 'sourceWorktree'], 'security')
  assertKeys(manifest.security.dangerousPathPolicy, ['policy', 'status'], 'security.dangerousPathPolicy')
  if (manifest.security.dangerousPathPolicy.policy !== PATH_POLICY || manifest.security.dangerousPathPolicy.status !== 'PASS') fail('dangerous-path policy evidence is invalid')
  assertKeys(manifest.security.secretScan, ['scanner', 'scannerSha256', 'scope', 'status'], 'security.secretScan')
  if (manifest.security.secretScan.scanner !== 'scripts/check-no-secrets.cjs' || manifest.security.secretScan.scope !== 'changed-blobs-and-commit-metadata' || manifest.security.secretScan.status !== 'PASS') fail('secret scan evidence is invalid')
  assertSha256(manifest.security.secretScan.scannerSha256, 'security.secretScan.scannerSha256')
  assertKeys(manifest.security.singleAncestorChain, ['status'], 'security.singleAncestorChain')
  assertKeys(manifest.security.sourceWorktree, ['status'], 'security.sourceWorktree')
  if (manifest.security.singleAncestorChain.status !== 'PASS' || manifest.security.sourceWorktree.status !== 'CLEAN') fail('source safety evidence is invalid')
}

function validateManifestReviewAndEvidence(manifest) {
  assertKeys(manifest.testEvidence, ['claims', 'note', 'status'], 'testEvidence')
  if (manifest.testEvidence.status !== 'NOT_PROVIDED' || !Array.isArray(manifest.testEvidence.claims) || manifest.testEvidence.claims.length !== 0) fail('manifest must not fabricate test evidence')
  assertString(manifest.testEvidence.note, 'testEvidence.note', 20, 1000)

  assertKeys(manifest.review, ['findingsSchema', 'instructionsVersion', 'mode', 'status'], 'review')
  if (manifest.review.findingsSchema !== FINDINGS_SCHEMA || manifest.review.instructionsVersion !== REVIEW_INSTRUCTIONS_VERSION || manifest.review.mode !== 'MANUAL_CLAUDE_TRIGGER_ONLY' || manifest.review.status !== 'NOT_REVIEWED') fail('manual review contract is invalid')
}

function validateManifest(manifest) {
  assertKeys(manifest, ['bundle', 'deliveryId', 'generatedAt', 'range', 'repository', 'review', 'schema', 'security', 'testEvidence'], 'manifest')
  if (manifest.schema !== DELIVERY_SCHEMA) fail('unsupported delivery schema')
  assertSha256(manifest.deliveryId, 'deliveryId')
  assertIsoTime(manifest.generatedAt, 'generatedAt')
  validateManifestRange(manifest)
  validateManifestRepository(manifest)
  validateManifestBundle(manifest)
  validateManifestSecurity(manifest)
  validateManifestReviewAndEvidence(manifest)
}

function gitCheckRefFormat(ref) {
  return run('git', ['check-ref-format', ref], { allowFailure: true, label: 'git check-ref-format' }).status === 0
}

function strictDirectoryFiles(directory, expected, label) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  const names = entries.map((entry) => entry.name).sort()
  if (canonicalJson(names) !== canonicalJson([...expected].sort())) fail(`${label} must contain exactly: ${expected.join(', ')}`)
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    const stat = fs.lstatSync(file)
    if (!entry.isFile() || stat.isSymbolicLink() || !stat.isFile()) fail(`${label} contains a link or non-regular artifact: ${entry.name}`)
  }
}

function readBoundedFile(file, maxBytes, label) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`)
  if (stat.size < 1 || stat.size > maxBytes) fail(`${label} has an invalid size`)
  const bytes = fs.readFileSync(file)
  if (bytes.length !== stat.size) fail(`${label} changed while being read`)
  return bytes
}

function readDeliveryPackage(input) {
  const directory = resolveExistingDirectory(input, 'package')
  strictDirectoryFiles(directory, PACKAGE_FILES, 'delivery package')
  const bundle = readBoundedFile(path.join(directory, 'delivery.bundle'), MAX_BUNDLE_BYTES, 'delivery.bundle')
  const manifestBytes = readBoundedFile(path.join(directory, 'manifest.json'), MAX_MANIFEST_BYTES, 'manifest.json')
  const checksums = readBoundedFile(path.join(directory, 'SHA256SUMS'), MAX_CHECKSUM_BYTES, 'SHA256SUMS')
  const bundleSha256 = sha256Bytes(bundle)
  const manifestSha256 = sha256Bytes(manifestBytes)
  const expectedSums = `${bundleSha256}  delivery.bundle\n${manifestSha256}  manifest.json\n`
  if (checksums.toString('ascii') !== expectedSums) fail('SHA-256 checksum mismatch in delivery package')
  const manifestText = decodeUtf8(manifestBytes, 'manifest.json')
  if (manifestText.charCodeAt(0) === 0xfeff) fail('manifest.json must not contain a BOM')
  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    fail(`manifest.json is invalid JSON: ${error.message}`)
  }
  if (canonicalJson(manifest) !== manifestText) fail('manifest.json is not canonical JSON')
  validateManifest(manifest)
  if (manifest.bundle.bytes !== bundle.length || manifest.bundle.sha256 !== bundleSha256) fail('manifest bundle size/hash does not match delivery.bundle')
  return { bundle, bundleSha256, directory, manifest, manifestBytes, manifestSha256 }
}

function writeDeliveryPackage(repo, options, evidence, outputPlan) {
  let staging
  try {
    staging = makeStagingDirectory(outputPlan, 'staging')
    const bundleFile = path.join(staging, 'delivery.bundle')
    git(repo.root, ['bundle', 'create', '--version=2', bundleFile, 'HEAD', `^${options.base}`], { label: 'git bundle create' })
    git(repo.root, ['bundle', 'verify', bundleFile], { label: 'git bundle verify' })
    const heads = bundleHeads(repo.root, bundleFile)
    if (canonicalJson(heads) !== canonicalJson([{ name: 'HEAD', sha: options.head }])) fail('exported bundle must advertise exactly HEAD at the requested head')
    const bundleStat = fs.lstatSync(bundleFile)
    if (!bundleStat.isFile() || bundleStat.size < 1 || bundleStat.size > MAX_BUNDLE_BYTES) fail('generated bundle has an invalid size')
    const bundleSha256 = sha256File(bundleFile)
    const manifest = createManifest(
      repo,
      options.base,
      options.head,
      evidence.commits,
      evidence.files,
      new Date().toISOString(),
      { advertisedRefs: heads, bytes: bundleStat.size, file: 'delivery.bundle', format: 'git-bundle-v2', sha256: bundleSha256 },
      evidence.scannerSha256,
    )
    validateManifest(manifest)
    const manifestFile = path.join(staging, 'manifest.json')
    writeCanonical(manifestFile, manifest)
    const manifestSha256 = sha256File(manifestFile)
    fs.writeFileSync(path.join(staging, 'SHA256SUMS'), `${bundleSha256}  delivery.bundle\n${manifestSha256}  manifest.json\n`, { encoding: 'ascii', flag: 'wx' })
    strictDirectoryFiles(staging, PACKAGE_FILES, 'generated delivery package')
    fs.renameSync(staging, outputPlan.path)
    staging = null
    return {
      base: options.base,
      bundleSha256,
      deliveryId: manifest.deliveryId,
      head: options.head,
      manifestSha256,
      package: outputPlan.path,
      reviewRef: manifest.range.reviewRef,
      testEvidence: 'NOT_PROVIDED',
    }
  } finally {
    cleanupOwnedDirectory(staging)
  }
}

function exportDelivery(options) {
  const repo = resolveRepo(options.repo, { label: 'source repository', requireClean: true })
  requireCommit(repo.root, options.base, 'base')
  requireCommit(repo.root, options.head, 'head')
  if (repo.cachedBase !== options.base) fail(`base must equal cached ${BASE_ANCHOR}; expected ${repo.cachedBase}`)
  const currentHead = gitText(repo.root, ['rev-parse', 'HEAD'])
  if (currentHead !== options.head) fail(`head must equal the clean worktree HEAD; expected ${currentHead}`)
  const commits = linearCommitList(repo.root, options.base, options.head)
  const evidence = {
    commits,
    files: changedFileList(repo.root, options.base, options.head),
    scannerSha256: runSecretScan(repo.root, options.base, options.head, commits),
  }
  const gitCommonDir = gitText(repo.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const outputPlan = planNewDirectory(options.out, 'output package', [repo.root, gitCommonDir])
  return writeDeliveryPackage(repo, options, evidence, outputPlan)
}

function verifyRepoMatchesManifest(repo, manifest) {
  if (repo.cachedBase !== manifest.range.base) fail(`target cached ${BASE_ANCHOR} does not equal manifest base`)
  if (repo.baseTree !== manifest.repository.baseTree) fail('target base tree does not match manifest repository')
  if (repo.originLocatorSha256 !== manifest.repository.originLocatorSha256 || repo.identity !== manifest.repository.identity) fail('target repository identity does not match manifest')
  requireCommit(repo.root, manifest.range.base, 'manifest base')
}

function assertReviewRefAbsent(repo, reviewRef) {
  if (!gitCheckRefFormat(reviewRef) || !reviewRef.startsWith('refs/review/')) fail('review ref is outside refs/review/*')
  const reviewRefs = gitText(repo, ['for-each-ref', '--format=%(refname)', 'refs/review']).split(/\r?\n/).filter(Boolean)
  const collision = reviewRefs.find((existing) => existing === reviewRef || existing.startsWith(`${reviewRef}/`) || reviewRef.startsWith(`${existing}/`))
  if (collision || gitSucceeds(repo, ['show-ref', '--verify', '--quiet', reviewRef])) {
    fail(`review ref collision: ${collision || reviewRef} conflicts with ${reviewRef}; force overwrite is forbidden`)
  }
}

function verifyBundleInQuarantine(delivery, targetRepo) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'coreone-offline-quarantine-'))
  const bare = path.join(root, 'review.git')
  const bundleCopy = path.join(root, 'delivery.bundle')
  const sanitizedBundle = path.join(root, 'sanitized.bundle')
  try {
    fs.writeFileSync(bundleCopy, delivery.bundle, { flag: 'wx' })
    if (sha256File(bundleCopy) !== delivery.bundleSha256) fail('quarantine bundle copy hash mismatch')
    run('git', ['init', '--bare', '-q', bare], { label: 'initialize quarantine repository' })
    const targetObjects = fs.realpathSync(gitText(targetRepo.root, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']))
    const alternatesDir = path.join(bare, 'objects', 'info')
    fs.mkdirSync(alternatesDir, { recursive: true })
    fs.writeFileSync(path.join(alternatesDir, 'alternates'), `${targetObjects.replaceAll('\\', '/')}\n`, { encoding: 'utf8', flag: 'wx' })
    git(bare, ['bundle', 'verify', bundleCopy], { label: 'verify bundle in quarantine' })
    const heads = bundleHeads(bare, bundleCopy)
    if (canonicalJson(heads) !== canonicalJson(delivery.manifest.bundle.advertisedRefs)) fail('bundle advertises extra or mismatched refs')
    git(bare, ['bundle', 'unbundle', bundleCopy], { label: 'unbundle into quarantine' })
    const zero = '0'.repeat(40)
    git(bare, ['update-ref', 'refs/heads/base', delivery.manifest.range.base, zero], { label: 'anchor quarantine base ref' })
    git(bare, ['update-ref', 'refs/heads/candidate', delivery.manifest.range.head, zero], { label: 'anchor quarantine candidate ref' })
    const candidate = gitText(bare, ['rev-parse', 'refs/heads/candidate'])
    if (candidate !== delivery.manifest.range.head) fail('bundle HEAD does not match manifest head')
    const commits = linearCommitList(bare, delivery.manifest.range.base, candidate)
    const files = changedFileList(bare, delivery.manifest.range.base, candidate)
    if (canonicalJson(commits) !== canonicalJson(delivery.manifest.range.commits)) fail('bundle commit list does not match manifest')
    if (canonicalJson(files) !== canonicalJson(delivery.manifest.range.files)) fail('bundle file scope does not match manifest')
    git(bare, ['symbolic-ref', 'HEAD', 'refs/heads/candidate'], { label: 'anchor quarantine HEAD' })
    // The alternate exposes the target's existing object store. An
    // --unreachable scan would therefore report unrelated target objects as
    // bundle findings. Strict fsck checks integrity; the sanitized bundle
    // below then carries only candidate objects reachable beyond base.
    git(bare, ['fsck', '--strict', '--full', '--no-reflogs'], { label: 'git fsck quarantine' })
    git(bare, ['bundle', 'create', '--version=2', sanitizedBundle, 'refs/heads/candidate', `^${delivery.manifest.range.base}`], { label: 'create sanitized quarantine bundle' })
    const sanitizedHeads = bundleHeads(bare, sanitizedBundle)
    if (canonicalJson(sanitizedHeads) !== canonicalJson([{ name: 'refs/heads/candidate', sha: delivery.manifest.range.head }])) fail('sanitized bundle ref contract failed')
    return { bare, sanitizedBundle, cleanup: () => cleanupOwnedDirectory(root) }
  } catch (error) {
    cleanupOwnedDirectory(root)
    throw error
  }
}

function renderReviewInstructions(manifest) {
  return [
    '# COREONE offline fixed-SHA review instructions',
    '',
    '> Manual trigger only. The transfer tool did not run Claude and did not complete a review.',
    '',
    `- Base: \`${manifest.range.base}\``,
    `- Head: \`${manifest.range.head}\``,
    `- Read-only review ref: \`${manifest.range.reviewRef}\``,
    `- Delivery ID: \`${manifest.deliveryId}\``,
    '',
    'On the Claude device, keep the current worktree checked out exactly as-is. Do not checkout, merge, rebase, fetch, push, or access production/real databases.',
    '',
    'Run these local read-only checks from the target repository:',
    '',
    '```powershell',
    `git rev-parse "${manifest.range.reviewRef}"`,
    `node scripts/agent-preflight.cjs --mode=review --target-ref="${manifest.range.reviewRef}" --entry=CLAUDE.md --no-worktree-report`,
    `git diff --stat "${manifest.range.base}...${manifest.range.head}"`,
    `git diff --no-renames "${manifest.range.base}...${manifest.range.head}"`,
    '```',
    '',
    `The first command must print exactly \`${manifest.range.head}\`. Ask Claude manually to review only that fixed SHA/ref, then fill \`findings.template.json\`. Keep findings tied to this delivery ID and head; do not claim review completion before the manual session actually finishes.`,
    '',
  ].join('\n')
}

function writeReviewMaterial(staging, manifest, manifestSha256) {
  const instructions = renderReviewInstructions(manifest)
  fs.writeFileSync(path.join(staging, 'review-instructions.md'), instructions, { encoding: 'utf8', flag: 'wx' })
  const template = makeFindingsTemplate(manifest, manifestSha256)
  validateFindings(template, manifest, { completed: false })
  writeCanonical(path.join(staging, 'findings.template.json'), template)
  strictDirectoryFiles(staging, ['findings.template.json', 'review-instructions.md'], 'review material')
}

function refSnapshot(repo) {
  return gitText(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])
}

function installIsolatedReviewRef(repo, manifest, quarantine) {
  const before = { head: gitText(repo, ['rev-parse', 'HEAD']), refs: refSnapshot(repo) }
  git(repo, ['bundle', 'verify', quarantine.sanitizedBundle], { label: 'verify sanitized bundle against target' })
  git(repo, ['bundle', 'unbundle', quarantine.sanitizedBundle], { label: 'install reviewed objects without refs' })
  git(repo, [
    '-c', `core.hooksPath=${path.join(quarantine.bare, 'empty-hooks')}`,
    'update-ref', manifest.range.reviewRef, manifest.range.head, '0'.repeat(40),
  ], { label: 'create isolated review ref without force' })
  return before
}

function verifyImportedTargetState(repo, manifest, before) {
  const installed = gitText(repo, ['rev-parse', manifest.range.reviewRef])
  if (installed !== manifest.range.head) fail('installed review ref does not equal manifest head')
  if (gitText(repo, ['rev-parse', 'HEAD']) !== before.head) fail('import unexpectedly changed target HEAD')
  const statusAfter = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], { encoding: null }).stdout
  if (statusAfter.length !== 0) fail('import unexpectedly changed target worktree/index')
  const expectedRefLine = `${manifest.range.reviewRef} ${manifest.range.head}`
  const beforeLines = before.refs ? before.refs.split(/\r?\n/) : []
  const refsAfter = refSnapshot(repo)
  const afterLines = refsAfter ? refsAfter.split(/\r?\n/) : []
  const added = afterLines.filter((line) => !beforeLines.includes(line))
  const removed = beforeLines.filter((line) => !afterLines.includes(line))
  if (canonicalJson(added) !== canonicalJson([expectedRefLine]) || removed.length !== 0) fail('import changed refs outside the single isolated review ref')
}

function verifyImport(options) {
  const delivery = readDeliveryPackage(options.package)
  const repo = resolveRepo(options.repo, { label: 'target repository', requireClean: true })
  if (isWithin(repo.root, delivery.directory)) fail('delivery package must be outside the target worktree')
  verifyRepoMatchesManifest(repo, delivery.manifest)
  assertReviewRefAbsent(repo.root, delivery.manifest.range.reviewRef)
  const outputPlan = planNewDirectory(options.reviewOut, 'review output', [repo.root, delivery.directory])
  const quarantine = verifyBundleInQuarantine(delivery, repo)
  let staging
  let published = false
  try {
    staging = makeStagingDirectory(outputPlan, 'staging')
    writeReviewMaterial(staging, delivery.manifest, delivery.manifestSha256)
    verifyRepoMatchesManifest(resolveRepo(repo.root, { label: 'target repository', requireClean: true }), delivery.manifest)
    assertReviewRefAbsent(repo.root, delivery.manifest.range.reviewRef)
    fs.renameSync(staging, outputPlan.path)
    staging = null
    published = true
    try {
      const before = installIsolatedReviewRef(repo.root, delivery.manifest, quarantine)
      verifyImportedTargetState(repo.root, delivery.manifest, before)
    } catch (error) {
      cleanupOwnedDirectory(outputPlan.path)
      published = false
      throw error
    }
    return {
      base: delivery.manifest.range.base,
      deliveryId: delivery.manifest.deliveryId,
      head: delivery.manifest.range.head,
      reviewOut: outputPlan.path,
      reviewRef: delivery.manifest.range.reviewRef,
      reviewStatus: 'NOT_REVIEWED',
    }
  } finally {
    quarantine.cleanup()
    cleanupOwnedDirectory(staging)
    if (!published && fs.existsSync(outputPlan.path)) cleanupOwnedDirectory(outputPlan.path)
  }
}

function validateStringArray(value, label, maxItems, requireNonEmpty = false) {
  if (!Array.isArray(value) || value.length > maxItems || (requireNonEmpty && value.length === 0)) fail(`${label} must be an array with ${requireNonEmpty ? '1' : '0'}..${maxItems} items`)
  for (const [index, item] of value.entries()) assertString(item, `${label}[${index}]`, 1, 4000)
}

function validateFindings(findings, manifest, options = {}) {
  assertKeys(findings, ['base', 'deliveryId', 'deliveryManifestSha256', 'evidence', 'findings', 'head', 'reviewRef', 'reviewedAt', 'reviewer', 'schema', 'status', 'summary', 'unverifiedBoundaries', 'verdict'], 'findings')
  if (findings.schema !== FINDINGS_SCHEMA) fail('unsupported findings schema')
  if (findings.deliveryId !== manifest.deliveryId || findings.base !== manifest.range.base || findings.head !== manifest.range.head || findings.reviewRef !== manifest.range.reviewRef) fail('findings target does not match delivery manifest')
  assertSha256(findings.deliveryManifestSha256, 'findings.deliveryManifestSha256')
  assertKeys(findings.reviewer, ['identity', 'independence', 'kind', 'model'], 'findings.reviewer')
  if (findings.reviewer.kind !== 'manual-claude-trigger') fail('findings reviewer kind must remain manual-claude-trigger')
  for (const field of ['identity', 'independence', 'model']) {
    const min = options.completed ? 1 : 0
    assertString(findings.reviewer[field], `findings.reviewer.${field}`, min, 1000)
  }
  assertKeys(findings.summary, ['confirmed', 'refuted', 'unverified'], 'findings.summary')
  for (const field of ['confirmed', 'refuted', 'unverified']) assertInteger(findings.summary[field], `findings.summary.${field}`, 0, 1000)
  if (!Array.isArray(findings.findings) || findings.findings.length > 500) fail('findings.findings must be an array of at most 500 entries')
  const changedPaths = new Set(manifest.range.files.map((file) => file.path))
  const ids = new Set()
  const counts = { confirmed: 0, refuted: 0, unverified: 0 }
  for (const [index, finding] of findings.findings.entries()) {
    assertKeys(finding, ['evidence', 'file', 'id', 'line', 'remediation', 'severity', 'status', 'title', 'trigger'], `finding[${index}]`)
    assertString(finding.id, `finding[${index}].id`, 1, 80)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(finding.id) || ids.has(finding.id)) fail(`finding[${index}].id is unsafe or duplicated`)
    ids.add(finding.id)
    assertEnum(finding.severity, ['P0', 'P1', 'P2', 'P3'], `finding[${index}].severity`)
    assertEnum(finding.status, ['CONFIRMED', 'REFUTED', 'UNVERIFIED'], `finding[${index}].status`)
    counts[finding.status.toLowerCase()] += 1
    assertString(finding.title, `finding[${index}].title`, 1, 500)
    assertSafeRepoPath(finding.file, `finding[${index}].file`)
    if (!changedPaths.has(finding.file)) fail(`finding[${index}].file is outside the delivered file scope`)
    if (finding.line !== null) assertInteger(finding.line, `finding[${index}].line`, 1, 10_000_000)
    for (const field of ['trigger', 'evidence', 'remediation']) assertString(finding[field], `finding[${index}].${field}`, 1, 4000)
  }
  if (canonicalJson(findings.summary) !== canonicalJson(counts)) fail('findings summary counts do not match individual findings')
  validateStringArray(findings.evidence, 'findings.evidence', 100, options.completed)
  validateStringArray(findings.unverifiedBoundaries, 'findings.unverifiedBoundaries', 100)
  if (options.completed) {
    if (findings.status !== 'COMPLETED') fail('manual findings status must be COMPLETED before sealing')
    assertEnum(findings.verdict, ['PASS', 'BLOCK'], 'findings.verdict')
    assertIsoTime(findings.reviewedAt, 'findings.reviewedAt')
    if (new Date(findings.reviewedAt).getTime() > Date.now() + 5 * 60_000) fail('findings.reviewedAt is implausibly in the future')
    if (findings.unverifiedBoundaries.includes('Claude review has not been run; this file is only a template.')) fail('manual review placeholder boundary must be replaced before sealing')
    const blocking = findings.findings.some((finding) => finding.status === 'CONFIRMED' && ['P0', 'P1'].includes(finding.severity))
    if (findings.verdict === 'PASS' && blocking) fail('PASS cannot contain a confirmed P0/P1 finding')
  } else {
    if (findings.status !== 'NOT_REVIEWED' || findings.verdict !== 'UNVERIFIED' || findings.reviewedAt !== null) fail('generated findings template must remain NOT_REVIEWED/UNVERIFIED')
  }
}

function sealFindings(options) {
  const delivery = readDeliveryPackage(options.package)
  const input = readBoundedFile(path.resolve(options.input), MAX_FINDINGS_BYTES, 'findings input')
  let findings
  try {
    findings = JSON.parse(decodeUtf8(input, 'findings input'))
  } catch (error) {
    if (error instanceof ContractError) throw error
    fail(`findings input is invalid JSON: ${error.message}`)
  }
  assertKeys(findings, ['base', 'deliveryId', 'deliveryManifestSha256', 'evidence', 'findings', 'head', 'reviewRef', 'reviewedAt', 'reviewer', 'schema', 'status', 'summary', 'unverifiedBoundaries', 'verdict'], 'findings input')
  findings.summary = { confirmed: 0, refuted: 0, unverified: 0 }
  if (Array.isArray(findings.findings)) {
    for (const finding of findings.findings) {
      if (finding && finding.status === 'CONFIRMED') findings.summary.confirmed += 1
      else if (finding && finding.status === 'REFUTED') findings.summary.refuted += 1
      else if (finding && finding.status === 'UNVERIFIED') findings.summary.unverified += 1
    }
  }
  if (findings.deliveryManifestSha256 !== delivery.manifestSha256) fail('findings delivery manifest hash does not match the package')
  validateFindings(findings, delivery.manifest, { completed: true })
  assertNoSecretText(canonicalJson(findings), 'findings return package')
  const outputPlan = planNewDirectory(options.out, 'findings return package', [delivery.directory])
  let staging
  try {
    staging = makeStagingDirectory(outputPlan, 'staging')
    const findingsFile = path.join(staging, 'findings.json')
    writeCanonical(findingsFile, findings)
    const digest = sha256File(findingsFile)
    fs.writeFileSync(path.join(staging, 'SHA256SUMS'), `${digest}  findings.json\n`, { encoding: 'ascii', flag: 'wx' })
    strictDirectoryFiles(staging, RETURN_FILES, 'findings return package')
    fs.renameSync(staging, outputPlan.path)
    staging = null
    return { deliveryId: findings.deliveryId, findingsSha256: digest, head: findings.head, returnPackage: outputPlan.path, verdict: findings.verdict }
  } finally {
    cleanupOwnedDirectory(staging)
  }
}

function readReturnPackage(input) {
  const directory = resolveExistingDirectory(input, 'findings return package')
  strictDirectoryFiles(directory, RETURN_FILES, 'findings return package')
  const bytes = readBoundedFile(path.join(directory, 'findings.json'), MAX_FINDINGS_BYTES, 'findings.json')
  const sums = readBoundedFile(path.join(directory, 'SHA256SUMS'), MAX_CHECKSUM_BYTES, 'findings SHA256SUMS')
  const digest = sha256Bytes(bytes)
  if (sums.toString('ascii') !== `${digest}  findings.json\n`) fail('SHA-256 checksum mismatch in findings return package')
  const text = decodeUtf8(bytes, 'findings.json')
  let findings
  try {
    findings = JSON.parse(text)
  } catch (error) {
    fail(`findings.json is invalid JSON: ${error.message}`)
  }
  if (canonicalJson(findings) !== text) fail('findings.json is not canonical JSON')
  return { digest, directory, findings }
}

function verifyFindings(options) {
  const delivery = readDeliveryPackage(options.package)
  const returned = readReturnPackage(options.returnPackage)
  if (returned.findings.deliveryManifestSha256 !== delivery.manifestSha256) fail('returned findings refer to a different delivery manifest')
  validateFindings(returned.findings, delivery.manifest, { completed: true })
  assertNoSecretText(canonicalJson(returned.findings), 'returned findings')
  return {
    deliveryId: returned.findings.deliveryId,
    findingsSha256: returned.digest,
    head: returned.findings.head,
    status: returned.findings.status,
    summary: returned.findings.summary,
    verdict: returned.findings.verdict,
  }
}

module.exports = {
  ContractError,
  canonicalJson,
  exportDelivery,
  sealFindings,
  verifyFindings,
  verifyImport,
}
