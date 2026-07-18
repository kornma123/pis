#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, openSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import {
  ReleaseContractError,
  artifactPath,
  assertOutsideRepository,
  assertRegularFile,
  assertReleaseSha,
  atomicWriteJson,
  ensurePrivateDirectory,
  inspectCoreoneDatabase,
  parseArgs,
  printResult,
  rejectUnknown,
  requireOption,
  runCli,
  sha256File,
  validateArtifactName,
} from './lib.mjs'

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2))
  rejectUnknown(args, new Set(['database', 'output-dir', 'release', 'name', 'json']))
  const sourcePath = assertRegularFile(requireOption(args, 'database'), 'source database')
  const outputDirectory = ensurePrivateDirectory(assertOutsideRepository(requireOption(args, 'output-dir'), 'backup output directory'))
  const release = assertReleaseSha(requireOption(args, 'release'))
  const defaultName = `coreone-${release.slice(0, 12)}-${new Date().toISOString().replace(/[-:.]/gu, '')}.db`
  const name = validateArtifactName(args.get('name') || defaultName)
  const backupPath = artifactPath(outputDirectory, name)
  const manifestPath = join(outputDirectory, `${name}.manifest.json`)
  if (existsSync(backupPath) || existsSync(manifestPath)) {
    throw new ReleaseContractError('backup or manifest already exists', 13)
  }

  inspectCoreoneDatabase(sourcePath)
  const temporary = join(outputDirectory, `.${name}.${randomUUID()}.tmp`)
  let sourceDatabase
  let backupPublished = false
  let result
  try {
    sourceDatabase = new DatabaseSync(sourcePath, { readOnly: true })
    await backup(sourceDatabase, temporary)
    sourceDatabase.close()
    sourceDatabase = undefined

    const descriptor = openSync(temporary, 'r+')
    fsyncSync(descriptor)
    closeSync(descriptor)
    const snapshot = inspectCoreoneDatabase(temporary)
    // Publish exclusively: unlike rename(2), link fails instead of replacing
    // a path created after the initial existence check.
    linkSync(temporary, backupPath)
    backupPublished = true
    try {
      chmodSync(backupPath, 0o600)
    } catch {
      // Windows ignores POSIX mode bits; Linux deployments enforce mode 0600.
    }

    const manifest = {
      schema: 'coreone.sqlite-backup/v1',
      createdAt: new Date().toISOString(),
      release,
      backupFile: basename(backupPath),
      sha256: sha256File(backupPath),
      bytes: statSync(backupPath).size,
      snapshot,
    }
    atomicWriteJson(manifestPath, manifest)
    result = {
      status: 'BACKUP_VERIFIED',
      name,
      release,
      backupPath,
      manifestPath,
      sha256: manifest.sha256,
      bytes: manifest.bytes,
    }
  } catch (error) {
    sourceDatabase?.close()
    try {
      if (backupPublished && existsSync(temporary) && existsSync(backupPath)) {
        const temporaryStat = statSync(temporary)
        const backupStat = statSync(backupPath)
        if (temporaryStat.dev === backupStat.dev && temporaryStat.ino === backupStat.ino) {
          rmSync(backupPath, { force: true })
        }
      }
    } catch {
      // Never let best-effort cleanup replace the original failure or delete
      // a path whose identity can no longer be proven.
    }
    rmSync(temporary, { force: true })
    throw error
  }
  try {
    rmSync(temporary, { force: true })
  } catch {
    // The verified backup and manifest are already published. A stale hidden
    // hard link is safer than reporting a false failure and encouraging retry.
  }
  printResult(result, args.get('json'))
})
