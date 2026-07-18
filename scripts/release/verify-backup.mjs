#!/usr/bin/env node

import {
  parseArgs,
  printResult,
  rejectUnknown,
  requireOption,
  runCli,
  verifyBackup,
} from './lib.mjs'

await runCli(async () => {
  const args = parseArgs(process.argv.slice(2))
  rejectUnknown(args, new Set(['backup', 'manifest', 'release', 'json']))
  const result = verifyBackup({
    backupPath: requireOption(args, 'backup'),
    manifestPath: requireOption(args, 'manifest'),
    release: requireOption(args, 'release'),
  })
  printResult({ ...result, status: 'BACKUP_VERIFIED' }, args.get('json'))
})
