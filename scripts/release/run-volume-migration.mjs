#!/usr/bin/env node

import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ReleaseContractError,
  assertOutsideRepository,
  assertRegularFile,
  parseArgs,
  printResult,
  rejectUnknown,
  requireOption,
  runCli,
  validateArtifactName,
  validateDockerVolumeName,
} from './lib.mjs'
import { admitComposeRelease, dockerRunner } from './compose-release-gate.mjs'

const profile = 'operator-r3-volume-migration'
const repositoryRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

export class VolumeMigrationError extends ReleaseContractError {
  constructor(message, { exitCode = 23, mutationStarted = false, code = 'VOLUME_MIGRATION_REFUSED' } = {}) {
    super(message, exitCode)
    this.name = 'VolumeMigrationError'
    this.mutationStarted = mutationStarted
    this.code = code
  }
}

function commandResult(result, label, mutationStarted = false) {
  if (result?.error) {
    throw new VolumeMigrationError(`${label} could not run`, {
      mutationStarted,
      code: 'DOCKER_COMMAND_UNAVAILABLE',
    })
  }
  if (!Number.isInteger(result?.status)) {
    throw new VolumeMigrationError(`${label} returned an unknown process status`, {
      mutationStarted,
      code: 'DOCKER_COMMAND_STATUS_UNKNOWN',
    })
  }
  return result
}

function runDocker(runner, env, args, label, mutationStarted = false) {
  return commandResult(
    runner('docker', args, { cwd: repositoryRoot, env }),
    label,
    mutationStarted,
  )
}

function parseJson(text, label, mutationStarted = false) {
  try {
    return JSON.parse(String(text || '').trim())
  } catch {
    throw new VolumeMigrationError(`${label} returned unknown JSON evidence`, {
      mutationStarted,
      code: 'DOCKER_EVIDENCE_INVALID',
    })
  }
}

function parseLastJsonLine(text, label, mutationStarted = false) {
  const lines = String(text || '').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // Docker Compose may add non-JSON progress lines; only a real final
      // release receipt is accepted below.
    }
  }
  throw new VolumeMigrationError(`${label} did not emit JSON verification evidence`, {
    mutationStarted,
    code: 'MIGRATION_EVIDENCE_MISSING',
  })
}

function validateMigrationInputs(env) {
  if (env.COREONE_VOLUME_MIGRATION_ACK !== 'R3_APPROVED_BACKUP_VERIFIED') {
    throw new VolumeMigrationError('COREONE_VOLUME_MIGRATION_ACK is not the required operator approval value')
  }
  const expectedSha = env.COREONE_MIGRATION_BACKUP_SHA || ''
  if (!/^[0-9a-f]{64}$/u.test(expectedSha)) {
    throw new VolumeMigrationError('COREONE_MIGRATION_BACKUP_SHA must be 64 lowercase hexadecimal characters')
  }
  const backupName = validateArtifactName(env.COREONE_MIGRATION_BACKUP_NAME || '')
  const backupPath = assertRegularFile(
    assertOutsideRepository(env.COREONE_MIGRATION_BACKUP_FILE || '', 'migration backup'),
    'migration backup',
  )
  const manifestPath = assertRegularFile(
    assertOutsideRepository(env.COREONE_MIGRATION_MANIFEST_FILE || '', 'migration manifest'),
    'migration manifest',
  )
  if (basename(backupPath) !== backupName) {
    throw new VolumeMigrationError('migration backup basename does not equal COREONE_MIGRATION_BACKUP_NAME')
  }
  return { backupName, backupPath, manifestPath, expectedSha }
}

function inspectExactVolume(runner, env, volumeName, mutationStarted = false) {
  const result = runDocker(
    runner,
    env,
    ['volume', 'inspect', volumeName, '--format', '{{json .}}'],
    'exact data-volume inspection',
    mutationStarted,
  )
  if (result.status !== 0) {
    throw new VolumeMigrationError('exact data volume is unavailable or unknown', {
      mutationStarted,
      code: 'DATA_VOLUME_UNKNOWN',
    })
  }
  const volume = parseJson(result.stdout, 'exact data-volume inspection', mutationStarted)
  if (
    !volume
    || typeof volume !== 'object'
    || Array.isArray(volume)
    || volume.Name !== volumeName
    || typeof volume.Driver !== 'string'
    || !volume.Driver
    || typeof volume.Scope !== 'string'
    || !volume.Scope
    || typeof volume.Mountpoint !== 'string'
    || !volume.Mountpoint
    || !isAbsolute(volume.Mountpoint)
  ) {
    throw new VolumeMigrationError('exact data-volume identity is incomplete or mismatched', {
      mutationStarted,
      code: 'DATA_VOLUME_IDENTITY_MISMATCH',
    })
  }
  return {
    name: volume.Name,
    driver: volume.Driver,
    scope: volume.Scope,
    mountpoint: volume.Mountpoint,
  }
}

function isPathInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function validateContainerState(container, mutationStarted) {
  const state = container?.State
  const knownStatuses = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'])
  if (
    !state
    || typeof state !== 'object'
    || Array.isArray(state)
    || !knownStatuses.has(state.Status)
    || typeof state.Running !== 'boolean'
    || typeof state.Paused !== 'boolean'
    || typeof state.Restarting !== 'boolean'
  ) {
    throw new VolumeMigrationError('container writer state is unknown', {
      mutationStarted,
      code: 'CONTAINER_STATE_UNKNOWN',
    })
  }
  return state.Running
    || state.Paused
    || state.Restarting
    || ['running', 'paused', 'restarting', 'removing'].includes(state.Status)
}

export function enumerateExactVolumeUsers({ runner = dockerRunner, env = process.env, volumeName, mutationStarted = false }) {
  const volume = inspectExactVolume(runner, env, volumeName, mutationStarted)
  const list = runDocker(
    runner,
    env,
    ['container', 'ls', '--all', '--no-trunc', '--quiet'],
    'Docker container enumeration',
    mutationStarted,
  )
  if (list.status !== 0) {
    throw new VolumeMigrationError('Docker container enumeration failed', {
      mutationStarted,
      code: 'CONTAINER_ENUMERATION_FAILED',
    })
  }
  const ids = String(list.stdout || '').split(/\r?\n/u).map(value => value.trim()).filter(Boolean)
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[0-9a-f]{64}$/u.test(id))) {
    throw new VolumeMigrationError('Docker container enumeration returned unknown identities', {
      mutationStarted,
      code: 'CONTAINER_IDENTITIES_UNKNOWN',
    })
  }
  if (ids.length === 0) return { volume, associations: [], active: [] }

  const inspection = runDocker(
    runner,
    env,
    ['container', 'inspect', ...ids],
    'Docker container mount inspection',
    mutationStarted,
  )
  if (inspection.status !== 0) {
    throw new VolumeMigrationError('Docker container mount inspection failed', {
      mutationStarted,
      code: 'CONTAINER_MOUNTS_UNKNOWN',
    })
  }
  const containers = parseJson(inspection.stdout, 'Docker container mount inspection', mutationStarted)
  if (!Array.isArray(containers) || containers.length !== ids.length) {
    throw new VolumeMigrationError('Docker container mount inspection is incomplete', {
      mutationStarted,
      code: 'CONTAINER_MOUNTS_INCOMPLETE',
    })
  }
  const returnedIds = containers.map(container => container?.Id)
  if (
    new Set(returnedIds).size !== returnedIds.length
    || returnedIds.some(id => !ids.includes(id))
  ) {
    throw new VolumeMigrationError('Docker container inspection identities do not equal the enumeration', {
      mutationStarted,
      code: 'CONTAINER_INSPECTION_IDENTITY_MISMATCH',
    })
  }

  const associations = []
  for (const container of containers) {
    if (!Array.isArray(container.Mounts)) {
      throw new VolumeMigrationError('container mount inspection is unknown', {
        mutationStarted,
        code: 'CONTAINER_MOUNTS_UNKNOWN',
      })
    }
    const active = validateContainerState(container, mutationStarted)
    for (const mount of container.Mounts) {
      if (!mount || typeof mount !== 'object' || Array.isArray(mount)) {
        throw new VolumeMigrationError('container mount entry is unknown', {
          mutationStarted,
          code: 'CONTAINER_MOUNT_ENTRY_UNKNOWN',
        })
      }
      const namedVolume = mount.Type === 'volume' && mount.Name === volumeName
      const bindIntoVolume = mount.Type === 'bind'
        && typeof mount.Source === 'string'
        && isAbsolute(mount.Source)
        && isPathInside(volume.mountpoint, mount.Source)
      const ambiguousExactName = mount.Name === volumeName && mount.Type !== 'volume'
      if (ambiguousExactName) {
        throw new VolumeMigrationError('exact volume appears through an unknown mount type', {
          mutationStarted,
          code: 'EXACT_VOLUME_MOUNT_TYPE_UNKNOWN',
        })
      }
      if (!namedVolume && !bindIntoVolume) continue
      if (typeof mount.Destination !== 'string' || !mount.Destination || typeof mount.RW !== 'boolean') {
        throw new VolumeMigrationError('exact volume mount metadata is incomplete', {
          mutationStarted,
          code: 'EXACT_VOLUME_MOUNT_METADATA_UNKNOWN',
        })
      }
      associations.push({
        containerId: container.Id,
        containerName: String(container.Name || ''),
        status: container.State.Status,
        destination: mount.Destination,
        readWrite: mount.RW,
        active,
      })
    }
  }
  return { volume, associations, active: associations.filter(association => association.active) }
}

function assertNoActiveVolumeUsers(snapshot, mutationStarted = false) {
  if (snapshot.active.length > 0) {
    throw new VolumeMigrationError('exact data volume still has an active mount or writer', {
      mutationStarted,
      code: 'ACTIVE_EXACT_VOLUME_WRITER',
    })
  }
  return snapshot
}

function stopBackend(runner, env, mutationStarted = false) {
  const result = runDocker(
    runner,
    env,
    ['compose', '--profile', profile, 'stop', 'backend'],
    'backend stop',
    mutationStarted,
  )
  if (result.status !== 0) {
    throw new VolumeMigrationError('backend stop could not be verified', {
      mutationStarted,
      code: 'BACKEND_STOP_FAILED',
    })
  }
}

function precheckArgs(input) {
  return [
    'compose', '--profile', profile,
    'run', '--rm', '--no-deps',
    '--entrypoint', 'node',
    'volume-permission-migration',
    '--experimental-sqlite', '/app/release/verify-volume-migration.mjs',
    '--phase', 'pre',
    '--backup', `/run/coreone-migration/${input.backupName}`,
    '--manifest', '/run/coreone-migration/backup.manifest.json',
    '--database', '/app/data/coreone.db',
    '--release', input.release,
    '--expected-sha', input.expectedSha,
    '--json',
  ]
}

function mutationArgs() {
  const script = [
    'set -eu',
    'test "${COREONE_VOLUME_MIGRATION_ACK:-}" = "R3_APPROVED_BACKUP_VERIFIED"',
    'printf "%s" "${COREONE_MIGRATION_BACKUP_SHA:-}" | grep -Eq "^[0-9a-f]{64}$"',
    'printf "%s" "${COREONE_MIGRATION_BACKUP_NAME:-}" | grep -Eq "^[A-Za-z0-9][A-Za-z0-9._-]*[.]db$"',
    'test -f /app/data/coreone.db',
    'chown -R 1000:1000 /app/data',
    'exec node --experimental-sqlite /app/release/verify-volume-migration.mjs --phase post --backup "/run/coreone-migration/${COREONE_MIGRATION_BACKUP_NAME}" --manifest /run/coreone-migration/backup.manifest.json --database /app/data/coreone.db --release "${COREONE_RELEASE_SHA}" --expected-sha "${COREONE_MIGRATION_BACKUP_SHA}" --ownership-root /app/data --expected-uid 1000 --expected-gid 1000 --json',
  ].join('\n')
  return [
    'compose', '--profile', profile,
    'run', '--rm', '--no-deps',
    '--entrypoint', '/bin/sh',
    'volume-permission-migration',
    '-euc', script,
  ]
}

function sanitizedFailureCode(error) {
  if (error instanceof VolumeMigrationError && /^[A-Z0-9_]+$/u.test(error.code || '')) return error.code
  return 'MIGRATION_OR_POSTCHECK_FAILED'
}

function preserveOfflineAfterPartial({ runner, env, volumeName, reason }) {
  let backendStopVerified = false
  let activeVolumeUsers = null
  try {
    stopBackend(runner, env, true)
    const snapshot = enumerateExactVolumeUsers({ runner, env, volumeName, mutationStarted: true })
    activeVolumeUsers = snapshot.active.length
    backendStopVerified = snapshot.active.length === 0
  } catch {
    backendStopVerified = false
  }
  return {
    schema: 'coreone.volume-migration-runner/v1',
    status: 'PARTIAL_MUTATION_FORWARD_FIX_REQUIRED',
    reasonCode: sanitizedFailureCode(reason),
    mutationStarted: true,
    backendStarted: false,
    backendStopVerified,
    activeVolumeUsers,
    rollbackAttempted: false,
    forwardFixRequired: true,
    productionExecutionAuthorized: false,
  }
}

export async function runVolumeMigration({
  receiptPath,
  env = process.env,
  runner = dockerRunner,
}) {
  const admission = await admitComposeRelease({ profile, receiptPath, env, runner })
  const input = validateMigrationInputs(env)
  const volumeName = validateDockerVolumeName(env.COREONE_DATA_VOLUME_NAME || '')
  stopBackend(runner, env, false)
  const initial = assertNoActiveVolumeUsers(enumerateExactVolumeUsers({ runner, env, volumeName }))

  const precheck = runDocker(runner, env, precheckArgs({
    ...input,
    release: admission.release,
  }), 'volume migration precheck')
  if (precheck.status !== 0) {
    throw new VolumeMigrationError('volume migration precheck failed before ownership mutation', {
      code: 'PRECHECK_FAILED_NO_MUTATION',
    })
  }
  const preEvidence = parseLastJsonLine(precheck.stdout, 'volume migration precheck')
  if (preEvidence.status !== 'VOLUME_MIGRATION_PRECHECK_VERIFIED' || preEvidence.snapshotOrdinal !== 1) {
    throw new VolumeMigrationError('volume migration precheck evidence is incomplete', {
      code: 'PRECHECK_EVIDENCE_INVALID',
    })
  }

  const beforeMutation = assertNoActiveVolumeUsers(enumerateExactVolumeUsers({ runner, env, volumeName }))
  try {
    const mutation = runDocker(runner, env, mutationArgs(), 'ownership mutation and postcheck', true)
    if (mutation.status !== 0) {
      throw new VolumeMigrationError('ownership mutation or postcheck failed after mutation began', {
        mutationStarted: true,
        code: 'OWNERSHIP_OR_POSTCHECK_FAILED',
      })
    }
    const postEvidence = parseLastJsonLine(mutation.stdout, 'volume migration postcheck', true)
    if (
      postEvidence.status !== 'VOLUME_MIGRATION_POSTCHECK_VERIFIED'
      || postEvidence.snapshotOrdinal !== 2
      || postEvidence.recursiveOwnershipVerified !== true
    ) {
      throw new VolumeMigrationError('volume migration postcheck evidence is incomplete', {
        mutationStarted: true,
        code: 'POSTCHECK_EVIDENCE_INVALID',
      })
    }
    const final = assertNoActiveVolumeUsers(
      enumerateExactVolumeUsers({ runner, env, volumeName, mutationStarted: true }),
      true,
    )
    return {
      schema: 'coreone.volume-migration-runner/v1',
      status: 'VOLUME_MIGRATION_VERIFIED',
      release: admission.release,
      receiptSha256: admission.receiptSha256,
      dataVolume: volumeName,
      initialAssociations: initial.associations.length,
      preMutationAssociations: beforeMutation.associations.length,
      finalAssociations: final.associations.length,
      snapshotOrdinal: 2,
      recursiveOwnershipVerified: true,
      mutationStarted: true,
      backendStarted: false,
      backendStopVerified: true,
      rollbackAttempted: false,
      forwardFixRequired: false,
      productionExecutionAuthorized: false,
    }
  } catch (error) {
    return preserveOfflineAfterPartial({ runner, env, volumeName, reason: error })
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await runCli(async () => {
    const args = parseArgs(process.argv.slice(2), new Set(['json', 'execute']))
    rejectUnknown(args, new Set(['receipt', 'json', 'execute']))
    if (!args.get('execute')) {
      throw new ReleaseContractError('volume migration requires explicit --execute after R3 operator authorization', 23)
    }
    const result = await runVolumeMigration({
      receiptPath: requireOption(args, 'receipt'),
      env: process.env,
      runner: dockerRunner,
    })
    printResult(result, args.get('json'))
    if (result.status === 'PARTIAL_MUTATION_FORWARD_FIX_REQUIRED') process.exitCode = 30
  })
}
