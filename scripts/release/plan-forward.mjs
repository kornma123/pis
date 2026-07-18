#!/usr/bin/env node

import { dirname } from 'node:path'
import {
  ReleaseContractError,
  assertOutsideRepository,
  assertReleaseSha,
  atomicWriteJson,
  ensurePrivateDirectory,
  parseArgs,
  printResult,
  rejectUnknown,
  requireOption,
  runCli,
  validateDockerVolumeName,
  verifyBackup,
} from './lib.mjs'

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2), new Set(['json', 'execute']))
  rejectUnknown(args, new Set([
    'current-release',
    'target-release',
    'backup',
    'manifest',
    'data-volume',
    'output',
    'json',
    'execute',
  ]))
  if (args.get('execute')) {
    throw new ReleaseContractError('this command only creates an unauthorized dry-run plan; execution is forbidden', 10)
  }

  const currentRelease = assertReleaseSha(requireOption(args, 'current-release'), 'current release')
  const targetRelease = assertReleaseSha(requireOption(args, 'target-release'), 'target release')
  if (currentRelease === targetRelease) throw new ReleaseContractError('target release must differ from current release')
  const verified = verifyBackup({
    backupPath: requireOption(args, 'backup'),
    manifestPath: requireOption(args, 'manifest'),
    release: currentRelease,
  })
  const dataVolume = validateDockerVolumeName(requireOption(args, 'data-volume'))
  const planPath = assertOutsideRepository(requireOption(args, 'output'), 'plan output')
  ensurePrivateDirectory(dirname(planPath))

  const plan = {
    schema: 'coreone.forward-plan/v1',
    createdAt: new Date().toISOString(),
    currentRelease,
    targetRelease,
    backupSha256: verified.sha256,
    dataVolume,
    executionAuthorized: false,
    operatorGate: 'R3 target, production resources, traffic, credentials, and execution require explicit operator authorization.',
    failurePolicy: 'After data mutation, keep the service offline and continue only with an approved forward fix.',
    steps: [
      'Verify target release review, checks, image identity, and target-environment approval.',
      `Drain traffic and prove that external volume ${dataVolume} is the approved SQLite volume.`,
      'Re-verify the bound backup manifest and isolated restore-drill receipt.',
      'If ownership is not 1000:1000, use only the separately approved R3 volume-migration profile after verification.',
      'Build or load the fixed target images without changing the active data volume.',
      'Run the approved data and credential preparation while services remain offline.',
      'Start backend only; verify health, release identity, credentials, and audit-safe logs.',
      'Start frontend; verify proxy health and the approved business smoke tests.',
      'Switch traffic only after every gate passes; otherwise remain offline and roll forward.',
    ],
  }
  atomicWriteJson(planPath, plan)
  printResult({ ...plan, status: 'PLAN_ONLY', planPath }, args.get('json'))
})
