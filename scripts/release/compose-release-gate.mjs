#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ReleaseContractError,
  assertOutsideRepository,
  assertRegularFile,
  assertReleaseSha,
  parseArgs,
  printResult,
  rejectUnknown,
  requireOption,
  runCli,
  sha256File,
  validateDockerVolumeName,
} from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const revisionLabel = 'org.opencontainers.image.revision'
const supportedProfiles = new Set([
  'normal',
  'operator-r3-first-install',
  'operator-r3-volume-migration',
])

function admissionError(message, exitCode = 1) {
  return new ReleaseContractError(message, exitCode)
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw admissionError(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw admissionError(`${label} fields are invalid`)
  }
  return value
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text || '').trim())
  } catch {
    throw admissionError(`${label} did not return valid JSON`)
  }
}

function normalizeRunnerResult(result, label, unavailableExitCode = 2) {
  if (result?.error) {
    throw admissionError(`${label} could not run: ${result.error.code || result.error.message}`, unavailableExitCode)
  }
  if (!Number.isInteger(result?.status)) {
    throw admissionError(`${label} returned an unknown process status`, unavailableExitCode)
  }
  return result
}

export function dockerRunner(program, args, options = {}) {
  return spawnSync(program, args, {
    cwd: options.cwd || root,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

export function validateImmutableImageReference(value, label = 'image') {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw admissionError(`${label} must be exactly sha256:<64 lowercase hexadecimal characters>`)
  }
  return value
}

function validateReceiptComponent(component, name, expectedRelease, expectedImage) {
  exactKeys(component, ['image', 'tag'], `build receipt ${name}`)
  const image = validateImmutableImageReference(component.image, `build receipt ${name} image`)
  if (image !== expectedImage) {
    throw admissionError(`build receipt ${name} image does not equal the admitted image`)
  }
  if (component.tag !== `coreone-${name}:${expectedRelease}`) {
    throw admissionError(`build receipt ${name} tag does not equal the fixed release tag`)
  }
  return { tag: component.tag, image }
}

export function readBuildReceipt(receiptPath, { release, backendImage, frontendImage }) {
  const outside = assertOutsideRepository(receiptPath, 'build receipt')
  const absolute = assertRegularFile(outside, 'build receipt')
  if (statSync(absolute).size > 1024 * 1024) {
    throw admissionError('build receipt exceeds the 1 MiB limit')
  }

  let receipt
  try {
    receipt = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch {
    throw admissionError('build receipt is not valid JSON')
  }
  exactKeys(receipt, [
    'backend',
    'createdAt',
    'frontend',
    'productionExecutionAuthorized',
    'release',
    'schema',
    'sourceTreeClean',
  ], 'build receipt')
  if (receipt.schema !== 'coreone.local-image-build-receipt/v1') {
    throw admissionError('build receipt schema is unsupported')
  }
  const expectedRelease = assertReleaseSha(release)
  if (receipt.release !== expectedRelease) {
    throw admissionError('build receipt release does not equal COREONE_RELEASE_SHA')
  }
  try {
    if (new Date(receipt.createdAt).toISOString() !== receipt.createdAt) throw new Error()
  } catch {
    throw admissionError('build receipt timestamp is invalid')
  }
  if (receipt.sourceTreeClean !== true || receipt.productionExecutionAuthorized !== false) {
    throw admissionError('build receipt source or authorization state is invalid')
  }
  const backend = validateReceiptComponent(receipt.backend, 'backend', expectedRelease, backendImage)
  const frontend = validateReceiptComponent(receipt.frontend, 'frontend', expectedRelease, frontendImage)
  return {
    ...receipt,
    backend,
    frontend,
    receiptPath: absolute,
    receiptSha256: sha256File(absolute),
  }
}

function assertDockerDaemon(runner, env) {
  const result = normalizeRunnerResult(runner('docker', [
    'version',
    '--format',
    '{{json .}}',
  ], { cwd: root, env }), 'Docker daemon probe')
  if (result.status !== 0) {
    throw admissionError('Docker daemon/server is unavailable', 2)
  }
  const version = parseJson(result.stdout, 'Docker daemon probe')
  const clientVersion = String(version?.Client?.Version || '').trim()
  const serverVersion = String(version?.Server?.Version || '').trim()
  if (!clientVersion || !serverVersion) {
    throw admissionError('Docker client or daemon/server identity is unavailable', 2)
  }
  return { clientVersion, serverVersion }
}

function inspectImageIdentity(runner, env, image, release, component) {
  const result = normalizeRunnerResult(runner('docker', [
    'image',
    'inspect',
    image,
    '--format',
    '{{json .}}',
  ], { cwd: root, env }), `${component} image inspection`)
  if (result.status !== 0) {
    throw admissionError(`${component} image inspection is unavailable`, 2)
  }
  const inspection = parseJson(result.stdout, `${component} image inspection`)
  if (inspection?.Id !== image || !/^sha256:[0-9a-f]{64}$/u.test(inspection.Id || '')) {
    throw admissionError(`${component} image ID does not equal the receipt-bound image`)
  }
  if (!Array.isArray(inspection.RepoDigests)) {
    throw admissionError(`${component} RepoDigests identity is unknown`)
  }
  for (const repoDigest of inspection.RepoDigests) {
    if (typeof repoDigest !== 'string' || !/^[^@\s]+@sha256:[0-9a-f]{64}$/u.test(repoDigest)) {
      throw admissionError(`${component} RepoDigests contains an invalid identity`)
    }
  }
  const labels = inspection?.Config?.Labels
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) {
    throw admissionError(`${component} image labels are unknown`)
  }
  if (labels[revisionLabel] !== release) {
    throw admissionError(`${component} image revision label does not equal COREONE_RELEASE_SHA`)
  }
  return { imageId: inspection.Id, repoDigests: [...inspection.RepoDigests] }
}

function expectedServices(profile) {
  const services = ['backend', 'frontend']
  if (profile === 'operator-r3-first-install') services.push('database-init')
  if (profile === 'operator-r3-volume-migration') services.push('volume-permission-migration')
  return services
}

function validateRenderedCompose(model, { profile, release, backendImage, frontendImage, dataVolume }) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw admissionError('rendered Compose model is invalid')
  }
  const services = model.services
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    throw admissionError('rendered Compose services are invalid')
  }
  const expected = expectedServices(profile).sort()
  if (JSON.stringify(Object.keys(services).sort()) !== JSON.stringify(expected)) {
    throw admissionError(`rendered Compose services do not equal the ${profile} profile contract`)
  }
  for (const serviceName of expected) {
    const service = services[serviceName]
    if (!service || typeof service !== 'object' || Array.isArray(service)) {
      throw admissionError(`rendered Compose service ${serviceName} is invalid`)
    }
    if ('build' in service && service.build != null) {
      throw admissionError(`rendered Compose service ${serviceName} must not contain build configuration`)
    }
    const expectedImage = serviceName === 'frontend' ? frontendImage : backendImage
    if (service.image !== expectedImage) {
      throw admissionError(`rendered Compose service ${serviceName} image does not equal the receipt`)
    }
    if (service?.labels?.[revisionLabel] !== release) {
      throw admissionError(`rendered Compose service ${serviceName} revision label does not equal the receipt release`)
    }
  }
  const volume = model?.volumes?.['coreone-data']
  if (!volume || volume.external !== true || volume.name !== dataVolume) {
    throw admissionError('rendered Compose external data volume does not equal COREONE_DATA_VOLUME_NAME')
  }
  return { projectName: String(model.name || ''), serviceNames: expected }
}

function renderCompose(runner, env, profile, expected) {
  const args = ['compose']
  if (profile !== 'normal') args.push('--profile', profile)
  args.push('config', '--format', 'json')
  const result = normalizeRunnerResult(
    runner('docker', args, { cwd: root, env }),
    `${profile} Compose config`,
  )
  if (result.status !== 0) {
    throw admissionError(`${profile} Compose config did not parse`)
  }
  return validateRenderedCompose(parseJson(result.stdout, `${profile} Compose config`), expected)
}

function requireProfile(profile) {
  if (!supportedProfiles.has(profile)) {
    throw admissionError('profile must be normal, operator-r3-first-install, or operator-r3-volume-migration')
  }
  return profile
}

function assertCleanFixedCheckout(runner, env, release) {
  const headResult = normalizeRunnerResult(
    runner('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, env }),
    'fixed release HEAD verification',
  )
  if (headResult.status !== 0 || String(headResult.stdout || '').trim() !== release) {
    throw admissionError('current HEAD does not equal the receipt-bound release')
  }
  const statusResult = normalizeRunnerResult(
    runner('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root, env }),
    'fixed release working tree verification',
  )
  if (statusResult.status !== 0 || String(statusResult.stdout || '').trim()) {
    throw admissionError('release working tree must be clean before Compose admission or execution')
  }
}

export async function admitComposeRelease({
  profile,
  receiptPath,
  env = process.env,
  runner = dockerRunner,
}) {
  const selectedProfile = requireProfile(profile)
  const release = assertReleaseSha(env.COREONE_RELEASE_SHA || '')
  const backendImage = validateImmutableImageReference(env.COREONE_BACKEND_IMAGE, 'COREONE_BACKEND_IMAGE')
  const frontendImage = validateImmutableImageReference(env.COREONE_FRONTEND_IMAGE, 'COREONE_FRONTEND_IMAGE')
  if (backendImage === frontendImage) {
    throw admissionError('backend and frontend images must have distinct immutable identities')
  }
  const dataVolume = validateDockerVolumeName(env.COREONE_DATA_VOLUME_NAME || '')
  assertCleanFixedCheckout(runner, env, release)
  const receipt = readBuildReceipt(receiptPath, { release, backendImage, frontendImage })
  const docker = assertDockerDaemon(runner, env)
  const backend = inspectImageIdentity(runner, env, backendImage, release, 'backend')
  const frontend = inspectImageIdentity(runner, env, frontendImage, release, 'frontend')
  const compose = renderCompose(runner, env, selectedProfile, {
    profile: selectedProfile,
    release,
    backendImage,
    frontendImage,
    dataVolume,
  })
  assertCleanFixedCheckout(runner, env, release)

  return {
    schema: 'coreone.compose-release-admission/v1',
    status: 'RELEASE_ADMISSION_VERIFIED',
    profile: selectedProfile,
    release,
    receiptSha256: receipt.receiptSha256,
    backend,
    frontend,
    dataVolume,
    composeProject: compose.projectName,
    composeServices: compose.serviceNames,
    docker,
    daemonInspected: true,
    sourceTreeClean: true,
    executionAuthorized: false,
    productionExecutionAuthorized: false,
  }
}

export async function runComposeRelease({
  profile,
  receiptPath,
  env = process.env,
  runner = dockerRunner,
  execute = false,
}) {
  const admission = await admitComposeRelease({ profile, receiptPath, env, runner })
  if (!execute) return admission
  if (profile === 'operator-r3-volume-migration') {
    throw admissionError('volume migration execution is allowed only through run-volume-migration.mjs')
  }
  assertCleanFixedCheckout(runner, env, admission.release)
  const args = profile === 'normal'
    ? ['compose', 'up', '--detach', '--no-build', '--pull', 'never']
    : ['compose', '--profile', 'operator-r3-first-install', 'run', '--rm', '--no-deps', 'database-init']
  const result = normalizeRunnerResult(
    runner('docker', args, { cwd: root, env }),
    `${profile} fixed Compose execution`,
  )
  if (result.status !== 0) {
    throw admissionError(`${profile} fixed Compose execution failed`)
  }
  return {
    ...admission,
    status: 'LOCAL_COMPOSE_EXECUTED',
    executionAuthorized: true,
    productionExecutionAuthorized: false,
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await runCli(async () => {
    const args = parseArgs(process.argv.slice(2), new Set(['json', 'execute']))
    rejectUnknown(args, new Set(['profile', 'receipt', 'json', 'execute']))
    const result = await runComposeRelease({
      profile: requireOption(args, 'profile'),
      receiptPath: requireOption(args, 'receipt'),
      env: process.env,
      runner: dockerRunner,
      execute: Boolean(args.get('execute')),
    })
    printResult(result, args.get('json'))
  })
}
