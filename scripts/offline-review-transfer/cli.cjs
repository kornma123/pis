#!/usr/bin/env node
'use strict'

const {
  ContractError,
  canonicalJson,
  exportDelivery,
  sealFindings,
  verifyFindings,
  verifyImport,
} = require('./lib.cjs')

const COMMANDS = {
  export: {
    required: ['repo', 'base', 'head', 'out'],
    run: (args) => exportDelivery(args),
  },
  'verify-import': {
    required: ['repo', 'package', 'review-out'],
    run: (args) => verifyImport({ package: args.package, repo: args.repo, reviewOut: args['review-out'] }),
  },
  'seal-findings': {
    required: ['package', 'input', 'out'],
    run: (args) => sealFindings(args),
  },
  'verify-findings': {
    required: ['package', 'return'],
    run: (args) => verifyFindings({ package: args.package, returnPackage: args.return }),
  },
}

function usage() {
  return [
    'COREONE offline fixed-SHA review transfer',
    '',
    'Usage:',
    '  node scripts/offline-review-transfer/cli.cjs export --repo <root> --base <sha> --head <sha> --out <new-directory>',
    '  node scripts/offline-review-transfer/cli.cjs verify-import --repo <root> --package <directory> --review-out <new-directory>',
    '  node scripts/offline-review-transfer/cli.cjs seal-findings --package <directory> --input <completed-json> --out <new-directory>',
    '  node scripts/offline-review-transfer/cli.cjs verify-findings --package <directory> --return <directory>',
    '',
    'All commands are local-only. No command fetches a remote, checks out, merges, pushes, or invokes Claude.',
  ].join('\n')
}

function parseOptions(tokens, required) {
  const allowed = new Set(required)
  const parsed = {}
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index]
    const value = tokens[index + 1]
    if (!flag || !flag.startsWith('--') || flag.includes('=') || value === undefined || value.startsWith('--')) {
      throw new ContractError(`options must use strict --name <value> pairs\n${usage()}`)
    }
    const name = flag.slice(2)
    if (!allowed.has(name)) throw new ContractError(`unknown option for this command: --${name}`)
    if (Object.hasOwn(parsed, name)) throw new ContractError(`duplicate option: --${name}`)
    parsed[name] = value
  }
  for (const name of required) {
    if (!Object.hasOwn(parsed, name) || parsed[name] === '') throw new ContractError(`missing required option: --${name}`)
  }
  return parsed
}

function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const command = COMMANDS[argv[0]]
  if (!command) throw new ContractError(`unknown command: ${argv[0]}\n${usage()}`)
  if ((argv.length - 1) % 2 !== 0) throw new ContractError(`options must use strict --name <value> pairs\n${usage()}`)
  const result = command.run(parseOptions(argv.slice(1), command.required))
  process.stdout.write(`${canonicalJson(result)}\n`)
}

try {
  main(process.argv.slice(2))
} catch (error) {
  const prefix = error instanceof ContractError ? 'contract violation' : 'unexpected failure'
  process.stderr.write(`[offline-review-transfer] ${prefix}: ${error.message}\n`)
  if (!(error instanceof ContractError) && error.stack) process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
}
