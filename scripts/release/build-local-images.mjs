#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ReleaseContractError,
  assertAbsolute,
  assertReleaseSha,
  atomicWriteJson,
  parseArgs,
  printResult,
  rejectUnknown,
  requireOption,
  runCli,
} from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const backendSourceDirectory = '后端代码/server'
const backendArchivePaths = [
  `${backendSourceDirectory}/.dockerignore`,
  `${backendSourceDirectory}/Dockerfile`,
  `${backendSourceDirectory}/package.json`,
  `${backendSourceDirectory}/package-lock.json`,
  `${backendSourceDirectory}/tsconfig.json`,
  `${backendSourceDirectory}/src`,
  `${backendSourceDirectory}/scripts/check-runtime-contract.mjs`,
  `${backendSourceDirectory}/scripts/reset-passwords.ts`,
  `${backendSourceDirectory}/scripts/approved-account-provisioning.ts`,
  `${backendSourceDirectory}/scripts/start-production.mjs`,
  'scripts/release/lib.mjs',
  'scripts/release/verify-volume-migration.mjs',
]
const frontendSourceDirectory = '前端代码'
const frontendArchivePaths = [
  `${frontendSourceDirectory}/Dockerfile`,
  `${frontendSourceDirectory}/package.json`,
  `${frontendSourceDirectory}/package-lock.json`,
  `${frontendSourceDirectory}/index.html`,
  `${frontendSourceDirectory}/nginx.conf`,
  `${frontendSourceDirectory}/postcss.config.js`,
  `${frontendSourceDirectory}/tailwind.config.ts`,
  `${frontendSourceDirectory}/tsconfig.json`,
  `${frontendSourceDirectory}/tsconfig.app.json`,
  `${frontendSourceDirectory}/tsconfig.node.json`,
  `${frontendSourceDirectory}/vite.config.ts`,
  `${frontendSourceDirectory}/src`,
]

function safeChildEnvironment() {
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function capture(program, args, label) {
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: 'utf8',
    env: safeChildEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `${label} exited ${result.status}`
    throw new ReleaseContractError(`${label} failed: ${detail}`, 20)
  }
  return result.stdout.trim()
}

function runVisible(program, args, label) {
  const result = spawnSync(program, args, {
    cwd: root,
    env: safeChildEnvironment(),
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new ReleaseContractError(`${label} failed`, 20)
  }
}

function assertCleanFixedSource(release) {
  const head = capture('git', ['rev-parse', '--verify', 'HEAD'], 'git HEAD verification')
  if (head !== release) throw new ReleaseContractError('release does not equal the current fixed HEAD', 21)
  const dirty = capture('git', ['status', '--porcelain=v1', '--untracked-files=all'], 'git cleanliness check')
  if (dirty) throw new ReleaseContractError('source tree must be clean before building release images', 21)
}

function assertReceiptOutsideRepository(value) {
  const output = assertAbsolute(value, 'build receipt output')
  const rel = relative(root, output)
  const inside = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  if (inside) throw new ReleaseContractError('build receipt output must stay outside the source repository', 21)
  return output
}

function removeIsolatedContext(stagingRoot, component) {
  const absolute = resolve(stagingRoot)
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith(`coreone-${component}-build-`)) {
    throw new ReleaseContractError('refusing to remove an unexpected build-context path', 21)
  }
  rmSync(absolute, { recursive: true, force: true })
}

function prepareIsolatedBackendContext(release) {
  // The isolated backend build context is materialized from the fixed commit,
  // not from the working tree. The archive allowlist and backend .dockerignore
  // both gate the context, so approved runtime scripts are explicit while
  // unrelated files remain unavailable to the Docker daemon.
  const stagingRoot = mkdtempSync(join(tmpdir(), 'coreone-backend-build-'))
  const archivePath = join(stagingRoot, 'context.tar')
  const extractionRoot = join(stagingRoot, 'checkout')
  mkdirSync(extractionRoot)
  try {
    const shrinkwrapPath = `${backendSourceDirectory}/npm-shrinkwrap.json`
    if (capture('git', ['ls-tree', '--name-only', release, '--', shrinkwrapPath], 'fixed backend shrinkwrap check')) {
      throw new ReleaseContractError('fixed backend release must not contain npm-shrinkwrap.json', 21)
    }
    runVisible('git', ['archive', '--format=tar', `--output=${archivePath}`, release, '--', ...backendArchivePaths], 'fixed backend context archive')
    runVisible('tar', ['-xf', archivePath, '-C', extractionRoot], 'fixed backend context extraction')
    const contextPath = resolve(extractionRoot, backendSourceDirectory)
    const releaseDirectory = resolve(contextPath, 'release')
    mkdirSync(releaseDirectory)
    copyFileSync(resolve(extractionRoot, 'scripts/release/lib.mjs'), resolve(releaseDirectory, 'lib.mjs'))
    copyFileSync(
      resolve(extractionRoot, 'scripts/release/verify-volume-migration.mjs'),
      resolve(releaseDirectory, 'verify-volume-migration.mjs'),
    )
    for (const required of [
      '.dockerignore',
      'Dockerfile',
      'scripts/check-runtime-contract.mjs',
      'scripts/reset-passwords.ts',
      'scripts/approved-account-provisioning.ts',
      'release/lib.mjs',
      'release/verify-volume-migration.mjs',
    ]) {
      if (!existsSync(resolve(contextPath, required))) {
        throw new ReleaseContractError(`isolated backend build context is missing ${required}`, 21)
      }
    }
    return { contextPath, stagingRoot }
  } catch (error) {
    removeIsolatedContext(stagingRoot, 'backend')
    throw error
  }
}

function prepareIsolatedFrontendContext(release) {
  // The isolated frontend build context is an allowlisted archive of the same
  // fixed commit, so a concurrent working-tree edit can never enter the image.
  const stagingRoot = mkdtempSync(join(tmpdir(), 'coreone-frontend-build-'))
  const archivePath = join(stagingRoot, 'context.tar')
  const extractionRoot = join(stagingRoot, 'checkout')
  mkdirSync(extractionRoot)
  try {
    runVisible('git', ['archive', '--format=tar', `--output=${archivePath}`, release, '--', ...frontendArchivePaths], 'fixed frontend context archive')
    runVisible('tar', ['-xf', archivePath, '-C', extractionRoot], 'fixed frontend context extraction')
    const contextPath = resolve(extractionRoot, frontendSourceDirectory)
    for (const required of ['Dockerfile', 'package.json', 'package-lock.json', 'index.html', 'nginx.conf', 'src']) {
      if (!existsSync(resolve(contextPath, required))) {
        throw new ReleaseContractError(`isolated frontend build context is missing ${required}`, 21)
      }
    }
    return { contextPath, stagingRoot }
  } catch (error) {
    removeIsolatedContext(stagingRoot, 'frontend')
    throw error
  }
}

function inspectImage(tag, release) {
  let image
  try {
    image = JSON.parse(capture('docker', ['image', 'inspect', tag], `inspect ${tag}`))[0]
  } catch (error) {
    if (error instanceof ReleaseContractError) throw error
    throw new ReleaseContractError(`inspect ${tag} returned invalid JSON`, 20)
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(image?.Id || '')) {
    throw new ReleaseContractError(`${tag} did not produce an immutable sha256 image ID`, 20)
  }
  if (image?.Config?.Labels?.['org.opencontainers.image.revision'] !== release) {
    throw new ReleaseContractError(`${tag} revision label does not match the fixed release`, 20)
  }
  return image.Id
}

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2), new Set(['json', 'execute']))
  rejectUnknown(args, new Set(['release', 'output', 'json', 'execute']))
  const release = assertReleaseSha(requireOption(args, 'release'))
  const execute = Boolean(args.get('execute'))
  assertCleanFixedSource(release)

  const backendTag = `coreone-backend:${release}`
  const frontendTag = `coreone-frontend:${release}`
  if (!execute) {
    printResult({
      schema: 'coreone.local-image-build-plan/v1',
      status: 'BUILD_PLAN_ONLY',
      release,
      sourceTreeClean: true,
      buildExecuted: false,
      productionExecutionAuthorized: false,
      backendTag,
      frontendTag,
    }, args.get('json'))
    return
  }

  const receiptPath = assertReceiptOutsideRepository(requireOption(args, 'output'))
  const backendContext = prepareIsolatedBackendContext(release)
  try {
    runVisible('docker', [
      'build', '--pull=false', '--build-arg', `COREONE_RELEASE_SHA=${release}`,
      '--tag', backendTag, '--file', resolve(backendContext.contextPath, 'Dockerfile'), backendContext.contextPath,
    ], 'backend image build')
  } finally {
    removeIsolatedContext(backendContext.stagingRoot, 'backend')
  }
  const frontendContext = prepareIsolatedFrontendContext(release)
  try {
    runVisible('docker', [
      'build', '--pull=false', '--build-arg', `COREONE_RELEASE_SHA=${release}`,
      '--tag', frontendTag, '--file', resolve(frontendContext.contextPath, 'Dockerfile'), frontendContext.contextPath,
    ], 'frontend image build')
  } finally {
    removeIsolatedContext(frontendContext.stagingRoot, 'frontend')
  }

  // Refuse a receipt if the checkout drifted while Docker consumed it. The
  // images may remain as local diagnostic artifacts, but Compose cannot use
  // them through this contract without a verified receipt.
  assertCleanFixedSource(release)

  const receipt = {
    schema: 'coreone.local-image-build-receipt/v1',
    createdAt: new Date().toISOString(),
    release,
    sourceTreeClean: true,
    backend: { tag: backendTag, image: inspectImage(backendTag, release) },
    frontend: { tag: frontendTag, image: inspectImage(frontendTag, release) },
    productionExecutionAuthorized: false,
  }
  atomicWriteJson(receiptPath, receipt)
  printResult({ ...receipt, status: 'LOCAL_IMAGES_VERIFIED', receiptPath }, args.get('json'))
})
