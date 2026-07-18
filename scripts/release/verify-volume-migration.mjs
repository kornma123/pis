#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  ReleaseContractError,
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

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2))
  rejectUnknown(args, new Set(['backup', 'manifest', 'database', 'release', 'expected-sha', 'json']))
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
  const liveSnapshotPath = join(tmpdir(), `coreone-live-migration-${randomUUID()}.db`)
  let sourceDatabase
  let liveDatabase
  let liveSnapshotSha256
  try {
    sourceDatabase = new DatabaseSync(databasePath, { readOnly: true })
    await backup(sourceDatabase, liveSnapshotPath)
    sourceDatabase.close()
    sourceDatabase = undefined
    liveDatabase = inspectCoreoneDatabase(liveSnapshotPath)
    liveSnapshotSha256 = sha256File(liveSnapshotPath)
    if (liveSnapshotSha256 !== verification.sha256) {
      throw new ReleaseContractError('live database snapshot does not match the approved backup', 13)
    }
  } finally {
    sourceDatabase?.close()
    rmSync(liveSnapshotPath, { force: true })
  }

  printResult({
    schema: 'coreone.volume-migration-precheck/v1',
    status: 'VOLUME_MIGRATION_PRECHECK_VERIFIED',
    release,
    backupSha256: verification.sha256,
    backupBytes: verification.bytes,
    liveSnapshotSha256,
    liveDatabase,
    mutationExecuted: false,
    productionExecutionAuthorized: false,
  }, args.get('json'))
})
