#!/usr/bin/env node

'use strict'

const { main: runGate } = require('../local-release-gate.cjs')
const { ROOT, verifyPinnedGitState } = require('./runtime-readiness.cjs')

function main(argv = process.argv.slice(2), environment = process.env, streams = { stdout: process.stdout, stderr: process.stderr }) {
  let pinned
  try {
    pinned = verifyPinnedGitState(ROOT, environment.COREONE_EXPECTED_BASE, environment.COREONE_EXPECTED_HEAD)
  } catch (error) {
    streams.stderr.write(`[BLOCKED] pinned-git-state - ${error.message}\n`)
    return 2
  }
  if (pinned.status !== 'PASS') {
    streams.stderr.write(`[${pinned.status}] pinned-git-state - ${pinned.detail}\n`)
    return pinned.status === 'BLOCKED' ? 2 : 1
  }
  streams.stdout.write(`[PASS] pinned-git-state - HEAD ${pinned.head}; base ${pinned.base}\n`)
  return runGate(argv)
}

if (require.main === module) process.exitCode = main()

module.exports = { main }
