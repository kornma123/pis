#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { verifyCanonicalGateReceipt } = require('../local-release-gate.cjs')
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..', '..')
const exporterPath = fileURLToPath(import.meta.url)
const gateToolPath = path.resolve(here, '..', 'local-release-gate.cjs')
const buildToolPath = path.resolve(here, 'build-local-images.mjs')
const SHA40 = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u
const REPO_DIGEST = /^[^@\s]+@sha256:[0-9a-f]{64}$/u
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const REVISION_LABEL = 'org.opencontainers.image.revision'
const MAX_RECEIPT_BYTES = 1024 * 1024

export const EXPORT_RECEIPT_SCHEMA_VERSION = 'coreone.local-image-export-receipt/v1'
function fail(message, exitCode = 1) {
  const error = new Error(message)
  error.exitCode = exitCode
  throw error
}

const object = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
function exact(value, keys, label) {
  if (!object(value)) fail(`${label} must be an object`)
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${label} fields are invalid`)
  }
  return value
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

export const canonicalJson = (value) => JSON.stringify(canonical(value))
const hashText = (value) => createHash('sha256').update(value).digest('hex')
function hashFile(file) {
  const descriptor = fs.openSync(file, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let count
    do {
      count = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (count) hash.update(buffer.subarray(0, count))
    } while (count)
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}
function sha40(value, label) {
  if (typeof value !== 'string' || !SHA40.test(value)) fail(`${label} must be a full lowercase Git SHA`)
  return value
}
function sha256(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${label} must be a SHA-256 digest`)
  return value
}
function imageId(value, label) {
  if (typeof value !== 'string' || !IMAGE_ID.test(value)) fail(`${label} must be an immutable sha256 image identity`)
  return value
}
function timestamp(value, label) {
  try {
    if (typeof value !== 'string' || new Date(value).toISOString() !== value) throw new Error()
  } catch {
    fail(`${label} must be an ISO timestamp`)
  }
  return value
}
function inside(parent, candidate) {
  const rel = path.relative(parent, candidate)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}
function external(value, repositoryRoot, label, mode) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`)
  const absolute = path.resolve(value)
  const repository = fs.realpathSync(path.resolve(repositoryRoot))
  let parentStat
  try { parentStat = fs.lstatSync(path.dirname(absolute)) } catch { fail(`${label} parent directory must exist`) }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail(`${label} parent must be a real directory`)
  const realCandidate = path.resolve(fs.realpathSync(path.dirname(absolute)), path.basename(absolute))
  if (inside(repository, absolute) || inside(repository, realCandidate)) fail(`${label} must stay outside the repository`)
  if (mode === 'target') {
    if (fs.existsSync(absolute)) fail(`${label} already exists; overwrite is forbidden`)
    return absolute
  }
  let stat
  try { stat = fs.lstatSync(absolute) } catch { fail(`${label} does not exist`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-link file`)
  if (stat.size > MAX_RECEIPT_BYTES) fail(`${label} exceeds the 1 MiB limit`)
  return absolute
}
function jsonFile(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail(`${label} is not valid JSON`) }
}
function repositoryEvidence(repository, release) {
  exact(repository, ['baseSha', 'headSha', 'headTreeSha', 'commits'], 'repository')
  const result = {
    baseSha: sha40(repository.baseSha, 'base SHA'),
    headSha: sha40(repository.headSha, 'head SHA'),
    headTreeSha: sha40(repository.headTreeSha, 'head tree SHA'),
    commits: repository.commits,
  }
  if (!Array.isArray(result.commits)) fail('repository commits must be an array')
  result.commits.forEach((commit) => sha40(commit, 'repository commit'))
  if (new Set(result.commits).size !== result.commits.length) fail('repository commits contain duplicates')
  if (result.headSha !== release) fail('release SHA must equal the exact repository head SHA')
  if (result.baseSha === result.headSha && result.commits.length) fail('base=head requires an empty commit list')
  if (result.baseSha !== result.headSha && result.commits.at(-1) !== result.headSha) {
    fail('repository commit list must terminate at the exact head SHA')
  }
  return structuredClone(result)
}
function toolEvidence(value) {
  exact(value, ['gate', 'build', 'exporter'], 'tool SHA input')
  return {
    gate: sha256(value.gate, 'gate tool SHA-256'),
    build: sha256(value.build, 'build tool SHA-256'),
    exporter: sha256(value.exporter, 'exporter tool SHA-256'),
  }
}
function buildComponent(value, name, release) {
  exact(value, ['tag', 'image'], `build receipt ${name}`)
  if (value.tag !== `coreone-${name}:${release}`) fail(`build receipt ${name} tag does not match release`)
  return { tag: value.tag, image: imageId(value.image, `build receipt ${name} image`) }
}
function readBuildReceipt(receiptPath, repositoryRoot, release) {
  const file = external(receiptPath, repositoryRoot, 'build receipt', 'input')
  const receipt = jsonFile(file, 'build receipt')
  exact(receipt, [
    'schema', 'createdAt', 'release', 'sourceTreeClean', 'backend', 'frontend',
    'productionExecutionAuthorized',
  ], 'build receipt')
  if (receipt.schema !== 'coreone.local-image-build-receipt/v1') fail('build receipt schema is unsupported')
  timestamp(receipt.createdAt, 'build receipt createdAt')
  if (receipt.release !== release) fail('build receipt release does not match the exact release SHA')
  if (receipt.sourceTreeClean !== true || receipt.productionExecutionAuthorized !== false) {
    fail('build receipt state is not admissible')
  }
  return {
    backend: buildComponent(receipt.backend, 'backend', release),
    frontend: buildComponent(receipt.frontend, 'frontend', release),
    receiptSha256: hashFile(file),
  }
}
function readGateReceipt(receiptPath, repositoryRoot, repository, gateToolSha256) {
  const receipt = jsonFile(external(receiptPath, repositoryRoot, 'gate receipt', 'input'), 'gate receipt')
  try {
    verifyCanonicalGateReceipt(receipt, {
      baseSha: repository.baseSha,
      headSha: repository.headSha,
      headTreeSha: repository.headTreeSha,
      commits: repository.commits,
      gateToolSha256,
    })
  } catch (error) {
    fail(`gate receipt verification failed: ${error.message}`)
  }
  if (
    receipt.admissible !== true || receipt.aggregateVerdict !== 'PASS' || receipt.gateExitCode !== 0
    || !receipt.items.every((item) => item.status === 'PASS')
  ) fail('gate receipt is not admissible PASS evidence')
  return receipt
}
function normalized(result, label, exitCode = 2) {
  if (result?.error || !Number.isInteger(result?.status) || result.status !== 0) fail(`${label} failed`, exitCode)
  return result
}
function dockerJson(result, label) {
  try { return JSON.parse(String(result.stdout || '').trim()) } catch { fail(`${label} returned invalid JSON`, 2) }
}
function inspect(runner, identity, release, name) {
  const data = dockerJson(normalized(runner('docker', [
    'image', 'inspect', identity, '--format', '{{json .}}',
  ]), `${name} image inspect`), `${name} image inspect`)
  if (data?.Id !== identity || !IMAGE_ID.test(data.Id || '')) fail(`${name} image ID drifted`)
  if (!object(data?.Config?.Labels) || data.Config.Labels[REVISION_LABEL] !== release) {
    fail(`${name} image revision drifted`)
  }
  if (!Array.isArray(data.RepoDigests) || !data.RepoDigests.length) fail(`${name} RepoDigest identity is unknown`)
  if (data.RepoDigests.some((digest) => typeof digest !== 'string' || !REPO_DIGEST.test(digest))) {
    fail(`${name} RepoDigest identity is invalid`)
  }
  const repoDigests = [...new Set(data.RepoDigests)].sort()
  if (repoDigests.length !== data.RepoDigests.length) fail(`${name} RepoDigest identity contains duplicates`)
  return { imageId: identity, revision: release, repoDigests }
}
function dockerVersions(runner) {
  const data = dockerJson(normalized(runner('docker', [
    'version', '--format', '{{json .}}',
  ]), 'Docker daemon probe'), 'Docker daemon probe')
  const clientVersion = String(data?.Client?.Version || '').trim()
  const serverVersion = String(data?.Server?.Version || '').trim()
  if (!clientVersion || !serverVersion) fail('Docker client or daemon identity is unavailable', 2)
  return { clientVersion, serverVersion }
}
function receiptImage(value, name, release) {
  exact(value, ['imageId', 'revision', 'repoDigests'], `export receipt ${name} image`)
  imageId(value.imageId, `export receipt ${name} image ID`)
  if (value.revision !== release) fail(`export receipt ${name} revision does not match release`)
  if (!Array.isArray(value.repoDigests) || !value.repoDigests.length
    || value.repoDigests.some((digest) => typeof digest !== 'string' || !REPO_DIGEST.test(digest))) {
    fail(`export receipt ${name} RepoDigests are invalid`)
  }
}
export function verifyCanonicalExportReceipt(receipt, expected = {}) {
  exact(receipt, [
    'schemaVersion', 'deliveryId', 'createdAt', 'repository', 'tools', 'inputs', 'docker',
    'images', 'archive', 'admissible', 'receiptRootSha256',
  ], 'export receipt')
  const unsigned = { ...receipt }
  delete unsigned.receiptRootSha256
  sha256(receipt.receiptRootSha256, 'export receipt root digest')
  if (hashText(canonicalJson(unsigned)) !== receipt.receiptRootSha256) fail('export receipt root digest mismatch')
  if (receipt.schemaVersion !== EXPORT_RECEIPT_SCHEMA_VERSION) fail('export receipt schemaVersion is unsupported')
  if (typeof receipt.deliveryId !== 'string' || !UUID_V4.test(receipt.deliveryId)) fail('deliveryId must be a UUID v4')
  timestamp(receipt.createdAt, 'export receipt createdAt')
  exact(receipt.repository, ['releaseSha', 'baseSha', 'headSha', 'headTreeSha', 'commits'], 'export receipt repository')
  const repository = repositoryEvidence({
    baseSha: receipt.repository.baseSha,
    headSha: receipt.repository.headSha,
    headTreeSha: receipt.repository.headTreeSha,
    commits: receipt.repository.commits,
  }, sha40(receipt.repository.releaseSha, 'export receipt release SHA'))
  exact(receipt.tools, ['exporterSha256', 'buildToolSha256', 'gateToolSha256'], 'export receipt tools')
  sha256(receipt.tools.exporterSha256, 'exporter tool SHA-256')
  sha256(receipt.tools.buildToolSha256, 'build tool SHA-256')
  sha256(receipt.tools.gateToolSha256, 'gate tool SHA-256')
  exact(receipt.inputs, ['buildReceiptSha256', 'gateReceiptRootSha256'], 'export receipt inputs')
  sha256(receipt.inputs.buildReceiptSha256, 'build receipt SHA-256')
  sha256(receipt.inputs.gateReceiptRootSha256, 'gate receipt root SHA-256')
  exact(receipt.docker, ['clientVersion', 'serverVersion'], 'export receipt Docker')
  if (!String(receipt.docker.clientVersion || '').trim() || !String(receipt.docker.serverVersion || '').trim()) {
    fail('export receipt Docker identity is unavailable')
  }
  exact(receipt.images, ['backend', 'frontend'], 'export receipt images')
  receiptImage(receipt.images.backend, 'backend', repository.headSha)
  receiptImage(receipt.images.frontend, 'frontend', repository.headSha)
  exact(receipt.archive, ['format', 'sha256', 'sizeBytes'], 'export receipt archive')
  if (receipt.archive.format !== 'docker-save-tar') fail('export receipt archive format is unsupported')
  sha256(receipt.archive.sha256, 'export receipt archive SHA-256')
  if (!Number.isSafeInteger(receipt.archive.sizeBytes) || receipt.archive.sizeBytes <= 0) fail('export receipt archive size is invalid')
  if (receipt.admissible !== true) fail('export receipt is not admissible')
  if (expected.repository && canonicalJson(receipt.repository) !== canonicalJson(expected.repository)) {
    fail('export receipt repository does not match expected repository')
  }
  if (expected.toolSha256) {
    const tools = toolEvidence(expected.toolSha256)
    if (receipt.tools.gateToolSha256 !== tools.gate || receipt.tools.buildToolSha256 !== tools.build
      || receipt.tools.exporterSha256 !== tools.exporter) fail('export receipt tool SHA does not match expected tool SHA')
  }
  if (expected.archivePath) {
    let stat
    try { stat = fs.statSync(expected.archivePath) } catch { fail('export receipt archive is unavailable') }
    if (!stat.isFile() || stat.size !== receipt.archive.sizeBytes || hashFile(expected.archivePath) !== receipt.archive.sha256) {
      fail('export receipt archive digest or size mismatch')
    }
  }
  return { status: 'PASS', receiptRootSha256: receipt.receiptRootSha256 }
}
function runner(program, args, options = {}) {
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return spawnSync(program, args, {
    cwd: options.cwd || root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}
function writeReceipt(file, receipt) {
  const descriptor = fs.openSync(file, 'wx', 0o600)
  const bytes = Buffer.from(canonicalJson(receipt), 'utf8')
  try {
    let offset = 0
    while (offset < bytes.length) offset += fs.writeSync(descriptor, bytes, offset, bytes.length - offset)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}
function remove(file) {
  try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
}
export function exportLocalImages(options) {
  const release = sha40(options.releaseSha, 'release SHA')
  const repository = repositoryEvidence(options.repository, release)
  const tools = toolEvidence(options.toolSha256)
  const archiveTarget = external(options.archivePath, options.repositoryRoot, 'archive target', 'target')
  const receiptTarget = external(options.receiptPath, options.repositoryRoot, 'receipt target', 'target')
  if (archiveTarget === receiptTarget) fail('archive and receipt targets must be different')
  const gate = readGateReceipt(options.gateReceiptPath, options.repositoryRoot, repository, tools.gate)
  const build = readBuildReceipt(options.buildReceiptPath, options.repositoryRoot, release)
  const run = options.runner || runner
  const docker = dockerVersions(run)
  const before = {
    backend: inspect(run, build.backend.image, release, 'backend'),
    frontend: inspect(run, build.frontend.image, release, 'frontend'),
  }
  const suffix = `${process.pid}-${randomUUID()}`
  const archivePartial = path.resolve(path.dirname(archiveTarget), `.${path.basename(archiveTarget)}.partial-${suffix}`)
  const receiptPartial = path.resolve(path.dirname(receiptTarget), `.${path.basename(receiptTarget)}.partial-${suffix}`)
  let archivePublished = false
  let receiptPublished = false
  try {
    fs.closeSync(fs.openSync(archivePartial, 'wx', 0o600))
    normalized(run('docker', ['save', '--output', archivePartial, before.backend.imageId, before.frontend.imageId]), 'docker save')
    const archiveStat = fs.statSync(archivePartial)
    if (!archiveStat.isFile() || archiveStat.size <= 0) fail('docker save archive is missing or empty')
    const after = {
      backend: inspect(run, build.backend.image, release, 'backend'),
      frontend: inspect(run, build.frontend.image, release, 'frontend'),
    }
    if (canonicalJson(before) !== canonicalJson(after)) fail('image identity drifted during docker save')
    const receipt = {
      schemaVersion: EXPORT_RECEIPT_SCHEMA_VERSION,
      deliveryId: (options.deliveryId || randomUUID)(),
      createdAt: (options.now || (() => new Date().toISOString()))(),
      repository: { releaseSha: release, ...repository },
      tools: { exporterSha256: tools.exporter, buildToolSha256: tools.build, gateToolSha256: tools.gate },
      inputs: { buildReceiptSha256: build.receiptSha256, gateReceiptRootSha256: gate.receiptRootSha256 },
      docker,
      images: after,
      archive: { format: 'docker-save-tar', sha256: hashFile(archivePartial), sizeBytes: archiveStat.size },
      admissible: true,
    }
    receipt.receiptRootSha256 = hashText(canonicalJson(receipt))
    verifyCanonicalExportReceipt(receipt, { archivePath: archivePartial, repository: receipt.repository, toolSha256: tools })
    writeReceipt(receiptPartial, receipt)
    fs.linkSync(archivePartial, archiveTarget)
    archivePublished = true
    fs.linkSync(receiptPartial, receiptTarget)
    receiptPublished = true
    remove(archivePartial)
    remove(receiptPartial)
    return receipt
  } catch (error) {
    if (receiptPublished) remove(receiptTarget)
    if (archivePublished) remove(archiveTarget)
    remove(receiptPartial)
    remove(archivePartial)
    throw error
  }
}
function git(args, label) {
  const result = runner('git', args, { cwd: root })
  if (result.error || result.status !== 0) fail(`${label} failed`)
  return result.stdout.trim()
}
function currentRepository(baseSha, headSha, treeSha) {
  if (git(['rev-parse', '--verify', 'HEAD'], 'Git HEAD verification') !== headSha) fail('current HEAD does not equal --head')
  if (git(['rev-parse', '--verify', 'HEAD^{tree}'], 'Git tree verification') !== treeSha) fail('current HEAD tree does not equal --tree')
  if (git(['rev-parse', '--verify', `${baseSha}^{commit}`], 'Git base verification') !== baseSha) fail('Git base does not equal --base')
  if (git(['status', '--porcelain=v1', '--untracked-files=all'], 'Git cleanliness verification')) {
    fail('repository must be clean before image export')
  }
  const commits = git(['rev-list', '--reverse', `${baseSha}..${headSha}`], 'Git commit-list verification')
  return { baseSha, headSha, headTreeSha: treeSha, commits: commits ? commits.split(/\r?\n/u) : [] }
}
function args(argv) {
  const values = new Map()
  const allowed = new Set(['release', 'base', 'head', 'tree', 'gate-receipt', 'build-receipt', 'archive', 'receipt'])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help') return { help: true, values }
    if (!arg.startsWith('--')) fail('unknown command argument')
    const equal = arg.indexOf('=')
    const name = arg.slice(2, equal < 0 ? undefined : equal)
    if (!allowed.has(name) || values.has(name)) fail('unknown or duplicate command argument')
    const value = equal < 0 ? argv[++index] : arg.slice(equal + 1)
    if (!value || value.startsWith('--')) fail(`--${name} requires a value`)
    values.set(name, value)
  }
  for (const name of allowed) if (!values.has(name)) fail(`--${name} is required`)
  return { help: false, values }
}
const usage = () => [
  'Usage:',
  '  node scripts/release/export-local-images.mjs --release=<sha> --base=<sha> --head=<sha> --tree=<sha>',
  '    --gate-receipt=<absolute-external-json> --build-receipt=<absolute-external-json>',
  '    --archive=<absolute-external-new-tar> --receipt=<absolute-external-new-json>',
  '',
  'Exports receipt-bound immutable image IDs with docker save; never loads, runs, or touches volumes.',
].join('\n')
async function main(argv = process.argv.slice(2)) {
  const parsed = args(argv)
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  const releaseSha = sha40(parsed.values.get('release'), 'release SHA')
  const baseSha = sha40(parsed.values.get('base'), 'base SHA')
  const headSha = sha40(parsed.values.get('head'), 'head SHA')
  const treeSha = sha40(parsed.values.get('tree'), 'head tree SHA')
  if (releaseSha !== headSha) fail('--release must equal --head')
  const receipt = exportLocalImages({
    repositoryRoot: root,
    repository: currentRepository(baseSha, headSha, treeSha),
    releaseSha,
    gateReceiptPath: parsed.values.get('gate-receipt'),
    buildReceiptPath: parsed.values.get('build-receipt'),
    archivePath: parsed.values.get('archive'),
    receiptPath: parsed.values.get('receipt'),
    toolSha256: { gate: hashFile(gateToolPath), build: hashFile(buildToolPath), exporter: hashFile(exporterPath) },
  })
  process.stdout.write(`${canonicalJson({
    status: 'LOCAL_IMAGES_EXPORTED',
    schemaVersion: receipt.schemaVersion,
    deliveryId: receipt.deliveryId,
    releaseSha: receipt.repository.releaseSha,
    archiveSha256: receipt.archive.sha256,
    archiveSizeBytes: receipt.archive.sizeBytes,
    receiptRootSha256: receipt.receiptRootSha256,
    admissible: receipt.admissible,
  })}\n`)
  return 0
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(exporterPath)) {
  main().then(
    (code) => { process.exitCode = code },
    (error) => {
      const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1
      process.stderr.write(`${canonicalJson({ status: exitCode === 2 ? 'BLOCKED' : 'FAIL', message: error?.message || 'image export failed' })}\n`)
      process.exitCode = exitCode
    },
  )
}
