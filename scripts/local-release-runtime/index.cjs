#!/usr/bin/env node

'use strict'

const {
  installVerifiedNodeArchive,
  probeRuntimeReadiness,
  runPinnedGate,
} = require('./runtime-readiness.cjs')

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseFlags(argv) {
  const options = { owned: [], excluded: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') options.help = true
    else if (argument.startsWith('--zip=')) options.zip = argument.slice(6)
    else if (argument === '--zip') options.zip = valueAfter(argv, index++, '--zip')
    else if (argument.startsWith('--sha256-manifest=')) options.sha256Manifest = argument.slice('--sha256-manifest='.length)
    else if (argument === '--sha256-manifest') options.sha256Manifest = valueAfter(argv, index++, '--sha256-manifest')
    else if (argument.startsWith('--base=')) options.base = argument.slice(7)
    else if (argument === '--base') options.base = valueAfter(argv, index++, '--base')
    else if (argument.startsWith('--head=')) options.head = argument.slice(7)
    else if (argument === '--head') options.head = valueAfter(argv, index++, '--head')
    else if (argument.startsWith('--owned=')) options.owned.push(argument.slice(8))
    else if (argument === '--owned') options.owned.push(valueAfter(argv, index++, '--owned'))
    else if (argument.startsWith('--excluded=')) options.excluded.push(argument.slice(11))
    else if (argument === '--excluded') options.excluded.push(valueAfter(argv, index++, '--excluded'))
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function printUsage(stream = process.stdout) {
  stream.write([
    'Usage:',
    '  node scripts/local-release-runtime/index.cjs probe',
    '  node scripts/local-release-runtime/index.cjs extract-node22 --zip=<absolute-zip> --sha256-manifest=<absolute-SHASUMS256.txt>',
    '  node scripts/local-release-runtime/index.cjs run-gate --base=<full-sha> --head=<full-sha> --owned=<path/glob> [...] --excluded=<path/glob> [...]',
    '',
    'Runtime inputs:',
    '  COREONE_NODE22_EXE       explicit absolute Node >=22.23.1 <23 executable (otherwise use the verified controlled runtime)',
    '  COREONE_BROWSER_EXE      explicit absolute Chrome/Chromium/Edge executable (otherwise probe known system paths)',
    '',
    'Exit codes: PASS=0, FAIL=1, BLOCKED=2. A final gate child exit outside 0/1/2 is relayed unchanged.',
    '',
  ].join('\n'))
}

function printReadiness(readiness) {
  process.stdout.write('Local release runtime readiness\n')
  for (const result of readiness.results) {
    process.stdout.write(`[${result.status}] ${result.id}${result.detail ? ` - ${result.detail}` : ''}\n`)
  }
  const status = readiness.exitCode === 0 ? 'PASS' : readiness.exitCode === 2 ? 'BLOCKED' : 'FAIL'
  process.stdout.write(`[${status}] runtime-readiness - exit ${readiness.exitCode}\n`)
}

function requireNoFlags(command, options) {
  const supplied = Object.entries(options).filter(([key, value]) => key !== 'owned' && key !== 'excluded' && value)
  if (supplied.length || options.owned.length || options.excluded.length) throw new Error(`${command} does not accept command-line flags`)
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    printUsage()
    return command ? 0 : 2
  }
  let options
  try {
    options = parseFlags(argv.slice(1))
    if (options.help) {
      printUsage()
      return 0
    }
    if (command === 'probe') {
      requireNoFlags(command, options)
      const readiness = probeRuntimeReadiness()
      printReadiness(readiness)
      return readiness.exitCode
    }
    if (command === 'extract-node22') {
      if (!options.zip || !options.sha256Manifest) throw new Error('extract-node22 requires --zip and --sha256-manifest')
      if (options.base || options.head || options.owned.length || options.excluded.length) throw new Error('extract-node22 received gate-only arguments')
      const result = installVerifiedNodeArchive(options.zip, options.sha256Manifest)
      process.stdout.write(`[${result.status}] extract-node22${result.detail ? ` - ${result.detail}` : ` - ${result.version} at ${result.executable}`}\n`)
      return result.status === 'PASS' ? 0 : result.status === 'BLOCKED' ? 2 : 1
    }
    if (command === 'run-gate') {
      if (!options.base || !options.head || !options.owned.length || !options.excluded.length) {
        throw new Error('run-gate requires full --base/--head and repeated --owned/--excluded scope')
      }
      if (options.zip || options.sha256Manifest) throw new Error('run-gate received archive-only arguments')
      const result = runPinnedGate(options)
      if (result.readiness) printReadiness(result.readiness)
      process.stdout.write(`[${result.status}] final-gate - exit ${result.exitCode}${result.detail ? ` - ${result.detail}` : ''}\n`)
      return result.exitCode
    }
    throw new Error(`unknown command: ${command}`)
  } catch (error) {
    process.stderr.write(`[BLOCKED] local-release-runtime - ${error.message}\n`)
    printUsage(process.stderr)
    return 2
  }
}

if (require.main === module) process.exitCode = main()

module.exports = { main, parseFlags, printReadiness }
