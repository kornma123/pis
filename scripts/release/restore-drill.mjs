#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, fsyncSync, openSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  ReleaseContractError,
  assertOutsideRepository,
  atomicWriteJson,
  ensurePrivateDirectory,
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
  rejectUnknown(args, new Set(['backup', 'manifest', 'target-dir', 'release', 'json']))
  const release = requireOption(args, 'release')
  const verified = verifyBackup({
    backupPath: requireOption(args, 'backup'),
    manifestPath: requireOption(args, 'manifest'),
    release,
  })
  const targetDirectory = ensurePrivateDirectory(
    assertOutsideRepository(requireOption(args, 'target-dir'), 'restore target directory'),
    { mustNotExist: true },
  )
  const restoredDatabase = join(targetDirectory, `coreone-restored-${release.slice(0, 12)}.db`)
  const temporary = join(targetDirectory, `.restore-${randomUUID()}.tmp`)
  const receiptPath = join(targetDirectory, 'restore-receipt.json')
  let result

  try {
    copyFileSync(verified.backupPath, temporary, 1)
    const descriptor = openSync(temporary, 'r+')
    fsyncSync(descriptor)
    closeSync(descriptor)
    if (sha256File(temporary) !== verified.sha256) {
      throw new ReleaseContractError('restored copy SHA-256 mismatch', 14)
    }
    const sqlite = inspectCoreoneDatabase(temporary)
    renameSync(temporary, restoredDatabase)
    try {
      chmodSync(restoredDatabase, 0o600)
    } catch {
      // Best effort on Windows; Linux operator environments enforce mode 0600.
    }

    const receipt = {
      schema: 'coreone.restore-drill/v1',
      completedAt: new Date().toISOString(),
      release: verified.release,
      backupSha256: verified.sha256,
      restoredDatabase,
      sqlite,
      productionExecutionAuthorized: false,
      nextGate: 'Operator approval and an isolated target-environment run are still required.',
    }
    atomicWriteJson(receiptPath, receipt)
    result = {
      status: 'RESTORE_DRILL_VERIFIED',
      release: verified.release,
      restoredDatabase,
      receiptPath,
      backupSha256: verified.sha256,
    }
  } catch (error) {
    rmSync(targetDirectory, { recursive: true, force: true })
    throw error
  }
  printResult(result, args.get('json'))
})
