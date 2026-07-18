#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  ReleaseContractError,
  assertAbsolute,
  assertRegularFile,
  assertReleaseSha,
  inspectCoreoneDatabase,
  parseArgs,
  printResult,
  rejectUnknown,
  requireOption,
  runCli,
  sha256File,
  verifyBackup,
} from './lib.mjs'

function parseOwnershipId(value, label) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value || '')) {
    throw new ReleaseContractError(`${label} must be a non-negative decimal integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > 0xffffffff) {
    throw new ReleaseContractError(`${label} is outside the supported ownership range`)
  }
  return parsed
}

function verifyRecursiveOwnership(rootPath, expectedUid, expectedGid) {
  const absolute = assertAbsolute(rootPath, 'ownership root')
  let rootStat
  try {
    rootStat = lstatSync(absolute)
  } catch {
    throw new ReleaseContractError('ownership root does not exist', 13)
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ReleaseContractError('ownership root must be a real directory', 13)
  }

  const pending = [absolute]
  let entriesChecked = 0
  while (pending.length > 0) {
    const current = pending.pop()
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      throw new ReleaseContractError('recursive ownership verification rejects symbolic links', 13)
    }
    if (stat.uid !== expectedUid || stat.gid !== expectedGid) {
      throw new ReleaseContractError('recursive ownership does not equal the required uid:gid', 13)
    }
    entriesChecked += 1
    if (entriesChecked > 100000) {
      throw new ReleaseContractError('recursive ownership verification exceeded the entry limit', 13)
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(current)) pending.push(resolve(current, name))
    }
  }
  return { expectedUid, expectedGid, entriesChecked }
}

async function snapshotAndCompare(databasePath, approvedSha256) {
  const liveSnapshotPath = join(tmpdir(), `coreone-live-migration-${randomUUID()}.db`)
  let sourceDatabase
  try {
    sourceDatabase = new DatabaseSync(databasePath, { readOnly: true })
    await backup(sourceDatabase, liveSnapshotPath)
    sourceDatabase.close()
    sourceDatabase = undefined
    const liveDatabase = inspectCoreoneDatabase(liveSnapshotPath)
    const liveSnapshotSha256 = sha256File(liveSnapshotPath)
    if (liveSnapshotSha256 !== approvedSha256) {
      throw new ReleaseContractError('live database snapshot does not match the approved backup', 13)
    }
    return { liveDatabase, liveSnapshotSha256 }
  } finally {
    sourceDatabase?.close()
    rmSync(liveSnapshotPath, { force: true })
  }
}

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2))
  rejectUnknown(args, new Set([
    'phase',
    'backup',
    'manifest',
    'database',
    'release',
    'expected-sha',
    'ownership-root',
    'expected-uid',
    'expected-gid',
    'json',
  ]))
  const phase = requireOption(args, 'phase')
  if (!['pre', 'post'].includes(phase)) {
    throw new ReleaseContractError('--phase must be pre or post')
  }
  const release = assertReleaseSha(requireOption(args, 'release'))
  const expectedSha = requireOption(args, 'expected-sha')
  if (!/^[0-9a-f]{64}$/u.test(expectedSha)) {
    throw new Error('expected backup SHA-256 must be 64 lowercase hexadecimal characters')
  }

  const verification = verifyBackup({
    backupPath: requireOption(args, 'backup'),
    manifestPath: requireOption(args, 'manifest'),
    release,
  })
  if (verification.sha256 !== expectedSha) {
    throw new Error('operator-approved backup SHA-256 does not match the verified backup')
  }

  const databasePath = assertRegularFile(requireOption(args, 'database'), 'live database')
  let recursiveOwnership = null
  if (phase === 'post') {
    recursiveOwnership = verifyRecursiveOwnership(
      requireOption(args, 'ownership-root'),
      parseOwnershipId(requireOption(args, 'expected-uid'), 'expected uid'),
      parseOwnershipId(requireOption(args, 'expected-gid'), 'expected gid'),
    )
  } else if (args.has('ownership-root') || args.has('expected-uid') || args.has('expected-gid')) {
    throw new ReleaseContractError('ownership options are accepted only for the post phase')
  }
  const { liveDatabase, liveSnapshotSha256 } = await snapshotAndCompare(databasePath, verification.sha256)

  printResult({
    schema: phase === 'pre'
      ? 'coreone.volume-migration-precheck/v1'
      : 'coreone.volume-migration-postcheck/v1',
    status: phase === 'pre'
      ? 'VOLUME_MIGRATION_PRECHECK_VERIFIED'
      : 'VOLUME_MIGRATION_POSTCHECK_VERIFIED',
    phase,
    snapshotOrdinal: phase === 'pre' ? 1 : 2,
    release,
    backupSha256: verification.sha256,
    backupBytes: verification.bytes,
    liveSnapshotSha256,
    liveDatabase,
    recursiveOwnership,
    recursiveOwnershipVerified: phase === 'post',
    mutationExecutedByThisProcess: false,
    ...(phase === 'pre'
      ? { mutationExecuted: false }
      : { ownershipMutationRequiredBeforeThisCheck: true }),
    productionExecutionAuthorized: false,
  }, args.get('json'))
})
