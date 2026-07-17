#!/usr/bin/env node
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..')
const FRONTEND_DIRECTORY = path.join(REPOSITORY_ROOT, '前端代码')
const WORKSPACE_DIST_DIRECTORY = path.join(FRONTEND_DIRECTORY, 'dist')
const FRONTEND_LOCKFILE = path.join(FRONTEND_DIRECTORY, 'package-lock.json')
const INSTALLED_LOCKFILE = path.join(FRONTEND_DIRECTORY, 'node_modules', '.package-lock.json')
const VITE_ENTRYPOINT = path.join(FRONTEND_DIRECTORY, 'node_modules', 'vite', 'bin', 'vite.js')
const BUILD_METADATA_FILE = 'build-meta.json'
const LOCAL_BUILD_IDENTITY = Object.freeze({ releaseSha: 'local', buildId: 'local' })
const EXPLICIT_BUILD_IDENTITY = Object.freeze({
  releaseSha: 'repro-release-a',
  buildId: 'repro-build-a',
})
const ALTERNATE_BUILD_IDENTITY = Object.freeze({
  releaseSha: 'repro-release-b',
  buildId: 'repro-build-b',
})

function parseArguments(argv) {
  const options = {
    sameInputOnly: false,
    keepTemporaryBuilds: false,
    viteConfig: undefined,
  }

  for (const argument of argv) {
    if (argument === '--same-input-only') options.sameInputOnly = true
    else if (argument === '--keep-temp') options.keepTemporaryBuilds = true
    else if (argument.startsWith('--vite-config=')) {
      options.viteConfig = path.resolve(argument.slice('--vite-config='.length))
    } else if (argument === '--help') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }

  return options
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function collectFiles(directory, relativeDirectory = '') {
  const currentDirectory = path.join(directory, relativeDirectory)
  const entries = fs.readdirSync(currentDirectory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(directory, relativePath))
    else if (entry.isFile()) files.push(relativePath)
    else throw new Error(`unsupported build output entry: ${relativePath}`)
  }

  return files
}

function createManifest(directory) {
  return collectFiles(directory)
    .map((relativePath) => {
      const content = fs.readFileSync(path.join(directory, relativePath))
      return {
        path: relativePath.split(path.sep).join('/'),
        size: content.length,
        sha256: sha256(content),
      }
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function manifestDigest(manifest) {
  const serialized = manifest
    .map((entry) => `${entry.path}\0${entry.size}\0${entry.sha256}`)
    .join('\n')
  return sha256(Buffer.from(serialized, 'utf8'))
}

function diffManifests(reference, candidate) {
  const referenceByPath = new Map(reference.map((entry) => [entry.path, entry]))
  const candidateByPath = new Map(candidate.map((entry) => [entry.path, entry]))
  const missing = [...referenceByPath.keys()].filter((file) => !candidateByPath.has(file)).sort()
  const unexpected = [...candidateByPath.keys()].filter((file) => !referenceByPath.has(file)).sort()
  const changed = [...referenceByPath.keys()]
    .filter((file) => {
      const other = candidateByPath.get(file)
      const current = referenceByPath.get(file)
      return other && (other.size !== current.size || other.sha256 !== current.sha256)
    })
    .sort()

  return { missing, unexpected, changed }
}

function hasManifestDifferences(diff) {
  return diff.missing.length > 0 || diff.unexpected.length > 0 || diff.changed.length > 0
}

function formatManifestDiff(diff) {
  return [
    diff.missing.length ? `missing: ${diff.missing.join(', ')}` : '',
    diff.unexpected.length ? `unexpected: ${diff.unexpected.join(', ')}` : '',
    diff.changed.length ? `changed: ${diff.changed.join(', ')}` : '',
  ].filter(Boolean).join('; ')
}

function assertMatchingManifests(label, reference, candidate) {
  const diff = diffManifests(reference, candidate)
  if (hasManifestDifferences(diff)) {
    throw new Error(`${label} file manifest/hash mismatch (${formatManifestDiff(diff)})`)
  }
}

function optionalManifest(directory) {
  return fs.existsSync(directory) ? createManifest(directory) : null
}

function assertOptionalManifestUnchanged(label, reference, candidate) {
  if (reference === null && candidate === null) return
  if (reference === null || candidate === null) throw new Error(`${label} presence changed during the check`)
  assertMatchingManifests(label, reference, candidate)
}

function assertOnlyMetadataChanged(reference, candidate) {
  const diff = diffManifests(reference, candidate)
  const expectedChangedFiles = [BUILD_METADATA_FILE]
  if (
    diff.missing.length > 0 ||
    diff.unexpected.length > 0 ||
    JSON.stringify(diff.changed) !== JSON.stringify(expectedChangedFiles)
  ) {
    throw new Error(
      `different identity changed files outside ${BUILD_METADATA_FILE} (${formatManifestDiff(diff) || 'no change'})`,
    )
  }
}

function readBuildMetadata(directory) {
  const metadataPath = path.join(directory, BUILD_METADATA_FILE)
  if (!fs.existsSync(metadataPath)) throw new Error(`${BUILD_METADATA_FILE} was not emitted`)
  return JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
}

function assertBuildMetadata(directory, expectedIdentity) {
  const metadata = readBuildMetadata(directory)
  const expected = { schemaVersion: 1, ...expectedIdentity }
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) {
    throw new Error(
      `${BUILD_METADATA_FILE} mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(metadata)}`,
    )
  }
}

function buildEnvironment(identity, reproducibilityEnvDir, sourceEnvironment = process.env) {
  const environment = { ...sourceEnvironment }
  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase()
    if (
      normalizedName.startsWith('VITE_') ||
      normalizedName === 'RELEASE_SHA' ||
      normalizedName === 'BUILD_ID'
    ) {
      delete environment[name]
    }
  }
  environment.COREONE_REPRO_ENV_DIR = reproducibilityEnvDir
  environment.NODE_ENV = 'production'
  if (identity) {
    environment.RELEASE_SHA = identity.releaseSha
    environment.BUILD_ID = identity.buildId
  }
  return environment
}

function runBuild({ label, outputDirectory, identity, viteConfig }) {
  fs.mkdirSync(outputDirectory, { recursive: true })
  const reproducibilityEnvDir = path.join(path.dirname(outputDirectory), 'empty-vite-env')
  fs.mkdirSync(reproducibilityEnvDir, { recursive: true })
  const argumentsList = [
    VITE_ENTRYPOINT,
    'build',
    '--outDir',
    outputDirectory,
    '--emptyOutDir',
    '--logLevel',
    'warn',
  ]
  if (viteConfig) argumentsList.push('--config', viteConfig)

  const result = spawnSync(process.execPath, argumentsList, {
    cwd: FRONTEND_DIRECTORY,
    env: buildEnvironment(identity, reproducibilityEnvDir),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${label} build failed with exit ${result.status}\n${result.stdout || ''}${result.stderr || ''}`,
    )
  }

  const manifest = createManifest(outputDirectory)
  process.stdout.write(`PASS ${label}: ${manifest.length} files, manifest ${manifestDigest(manifest)}\n`)
  return manifest
}

function runGit(argumentsList) {
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const result = spawnSync('git', argumentsList, {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  return result
}

function assertDistBoundary() {
  const tracked = runGit(['ls-files', '--', '前端代码/dist'])
  if (tracked.status !== 0) throw new Error(`git ls-files failed: ${tracked.stderr}`)
  if (tracked.stdout.trim()) throw new Error(`dist contains tracked files: ${tracked.stdout.trim()}`)

  const ignored = runGit(['check-ignore', '--quiet', '--', '前端代码/dist/.reproducibility-probe'])
  if (ignored.status !== 0) throw new Error('前端代码/dist is not ignored by repository rules')
}

function isPathInside(parentDirectory, candidate) {
  const relative = path.relative(parentDirectory, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function createTemporaryRoot() {
  const repositoryRealPath = fs.realpathSync(REPOSITORY_ROOT)
  const temporaryBase = fs.realpathSync(os.tmpdir())
  if (isPathInside(repositoryRealPath, temporaryBase)) {
    throw new Error(`refusing to place temporary build output inside the repository: ${temporaryBase}`)
  }
  return fs.mkdtempSync(path.join(temporaryBase, 'coreone-frontend-repro-'))
}

function lockRecord(record) {
  return JSON.stringify([
    record.version ?? null,
    record.resolved ?? null,
    record.integrity ?? null,
    record.link ?? null,
  ])
}

function assertInstalledDependenciesMatchLock() {
  if (!fs.existsSync(INSTALLED_LOCKFILE)) {
    throw new Error('node_modules/.package-lock.json is missing; run clean npm ci before this check')
  }
  const repositoryLock = JSON.parse(fs.readFileSync(FRONTEND_LOCKFILE, 'utf8'))
  const installedLock = JSON.parse(fs.readFileSync(INSTALLED_LOCKFILE, 'utf8'))
  const repositoryPackages = repositoryLock.packages ?? {}
  const installedPackages = installedLock.packages ?? {}
  const installedPackageCount = Object.keys(installedPackages).length
  if (repositoryLock.lockfileVersion !== installedLock.lockfileVersion || installedPackageCount === 0) {
    throw new Error('installed dependency lock metadata does not match package-lock.json')
  }

  for (const [packagePath, installedRecord] of Object.entries(installedPackages)) {
    const expectedRecord = repositoryPackages[packagePath]
    if (!expectedRecord || lockRecord(expectedRecord) !== lockRecord(installedRecord)) {
      throw new Error(`installed dependency does not match package-lock.json: ${packagePath}`)
    }
  }
  return installedPackageCount
}

function printBuildInputs(installedPackageCount) {
  const lockfileDigest = sha256(fs.readFileSync(FRONTEND_LOCKFILE))
  process.stdout.write(
    `INPUT lockfile sha256 ${lockfileDigest}; ${installedPackageCount} locked packages; ` +
      `node ${process.version}; ${process.platform}-${process.arch}; isolated VITE env\n`,
  )
}

function runSameIdentityChecks(temporaryRoot, viteConfig) {
  const firstDirectory = path.join(temporaryRoot, 'same-identity-1')
  const secondDirectory = path.join(temporaryRoot, 'same-identity-2')
  const first = runBuild({
    label: 'same identity build 1',
    outputDirectory: firstDirectory,
    identity: EXPLICIT_BUILD_IDENTITY,
    viteConfig,
  })
  const second = runBuild({
    label: 'same identity build 2',
    outputDirectory: secondDirectory,
    identity: EXPLICIT_BUILD_IDENTITY,
    viteConfig,
  })
  assertBuildMetadata(firstDirectory, EXPLICIT_BUILD_IDENTITY)
  assertBuildMetadata(secondDirectory, EXPLICIT_BUILD_IDENTITY)
  assertMatchingManifests('same identity', first, second)
  return first
}

function runAlternateIdentityCheck(temporaryRoot, viteConfig, reference) {
  const directory = path.join(temporaryRoot, 'alternate-identity')
  const alternate = runBuild({
    label: 'alternate identity build',
    outputDirectory: directory,
    identity: ALTERNATE_BUILD_IDENTITY,
    viteConfig,
  })
  assertBuildMetadata(directory, ALTERNATE_BUILD_IDENTITY)
  assertOnlyMetadataChanged(reference, alternate)
}

function runDefaultIdentityChecks(temporaryRoot, viteConfig, explicitReference) {
  const firstDirectory = path.join(temporaryRoot, 'default-identity-1')
  const secondDirectory = path.join(temporaryRoot, 'default-identity-2')
  const first = runBuild({
    label: 'default identity build 1',
    outputDirectory: firstDirectory,
    identity: null,
    viteConfig,
  })
  const second = runBuild({
    label: 'default identity build 2',
    outputDirectory: secondDirectory,
    identity: null,
    viteConfig,
  })
  assertBuildMetadata(firstDirectory, LOCAL_BUILD_IDENTITY)
  assertBuildMetadata(secondDirectory, LOCAL_BUILD_IDENTITY)
  assertMatchingManifests('default identity', first, second)
  assertOnlyMetadataChanged(explicitReference, first)
}

function runChecks(options = {}) {
  if (!fs.existsSync(VITE_ENTRYPOINT)) {
    throw new Error(`Vite is not installed at ${VITE_ENTRYPOINT}; install the lockfile dependencies first`)
  }
  if (options.viteConfig && !fs.existsSync(options.viteConfig)) {
    throw new Error(`Vite config does not exist: ${options.viteConfig}`)
  }

  const installedPackageCount = assertInstalledDependenciesMatchLock()
  printBuildInputs(installedPackageCount)
  const workspaceDistBefore = optionalManifest(WORKSPACE_DIST_DIRECTORY)
  const temporaryRoot = createTemporaryRoot()
  try {
    const reference = runSameIdentityChecks(temporaryRoot, options.viteConfig)
    if (!options.sameInputOnly) {
      runAlternateIdentityCheck(temporaryRoot, options.viteConfig, reference)
      runDefaultIdentityChecks(temporaryRoot, options.viteConfig, reference)
    }
    assertDistBoundary()
    assertOptionalManifestUnchanged(
      'workspace dist',
      workspaceDistBefore,
      optionalManifest(WORKSPACE_DIST_DIRECTORY),
    )
    process.stdout.write('PASS frontend build reproducibility contract\n')
  } finally {
    if (options.keepTemporaryBuilds) process.stdout.write(`temporary builds kept at ${temporaryRoot}\n`)
    else fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

function printHelp() {
  process.stdout.write([
    'Usage: node scripts/reproducibility/frontend-build-repro.cjs [options]',
    '',
    '  --same-input-only        only compare two builds with the same explicit identity',
    '  --vite-config=<path>     use an alternate Vite config (for mutation selftests)',
    '  --keep-temp              retain temporary build output for investigation',
    '',
  ].join('\n'))
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) printHelp()
    else runChecks(options)
  } catch (error) {
    process.stderr.write(`FAIL frontend build reproducibility contract: ${error.stack || error.message}\n`)
    process.exitCode = 1
  }
}

module.exports = {
  BUILD_METADATA_FILE,
  buildEnvironment,
  createManifest,
  diffManifests,
  hasManifestDifferences,
  manifestDigest,
  runChecks,
}
