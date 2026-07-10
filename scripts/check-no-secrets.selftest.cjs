#!/usr/bin/env node
'use strict'

const { spawnSync, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const scanner = path.resolve(__dirname, 'check-no-secrets.cjs')
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-secret-scan-'))

function git(args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function runScanner(args = []) {
  return spawnSync(process.execPath, [scanner, ...args], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  git(['init', '-q'])
  git(['config', 'user.name', 'secret-scan-selftest'])
  git(['config', 'user.email', 'secret-scan@example.invalid'])

  fs.writeFileSync(path.join(repo, 'clean.txt'), 'clean\n')
  git(['add', 'clean.txt'])
  git(['commit', '-qm', 'base'])
  const base = git(['rev-parse', 'HEAD'])
  const mainBranch = git(['rev-parse', '--abbrev-ref', 'HEAD'])

  const fakeKey = `sk-kimi-${'A'.repeat(48)}`
  fs.writeFileSync(path.join(repo, 'transient.txt'), `${fakeKey}\n`)
  git(['add', 'transient.txt'])
  git(['commit', '-qm', 'introduce fake secret'])
  fs.rmSync(path.join(repo, 'transient.txt'))
  git(['add', '-u'])
  git(['commit', '-qm', 'delete fake secret'])
  const head = git(['rev-parse', 'HEAD'])

  const finalTreeOnly = runScanner()
  assert(finalTreeOnly.status === 0, 'final clean tree should pass')

  const historyAware = runScanner(['--range', `${base}..${head}`])
  assert(historyAware.status === 1, 'range scan must catch a secret deleted by a later commit')
  assert(historyAware.stderr.includes('kimi-api-key'), 'range scan should report the matching rule')

  // Merge commit introduces a secret (conflict-resolution style), a later commit deletes it.
  // Final tree is clean; only `diff-tree -m` surfaces the secret inside the merge commit.
  git(['checkout', '-q', '-b', 'sidebranch', base])
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'side\n')
  git(['add', 'shared.txt'])
  git(['commit', '-qm', 'side branch file'])
  git(['checkout', '-q', mainBranch])
  fs.writeFileSync(path.join(repo, 'mainonly.txt'), 'main\n')
  git(['add', 'mainonly.txt'])
  git(['commit', '-qm', 'main branch file'])
  const preMerge = git(['rev-parse', 'HEAD'])
  git(['merge', '--no-commit', '--no-ff', 'sidebranch'])
  fs.writeFileSync(path.join(repo, 'leaked-in-merge.txt'), `${fakeKey}\n`)
  git(['add', 'leaked-in-merge.txt'])
  git(['commit', '-qm', 'merge resolution introduces secret'])
  fs.rmSync(path.join(repo, 'leaked-in-merge.txt'))
  git(['add', '-u'])
  git(['commit', '-qm', 'delete secret added in merge'])
  const mergeHead = git(['rev-parse', 'HEAD'])
  const mergeScan = runScanner(['--range', `${preMerge}..${mergeHead}`])
  assert(mergeScan.status === 1, 'range scan must catch a secret introduced by a merge commit and deleted later')
  assert(mergeScan.stderr.includes('kimi-api-key'), 'merge-range scan should report the matching rule')

  fs.writeFileSync(path.join(repo, '.env.example'), `${fakeKey}\n`)
  git(['add', '.env.example'])
  const envExample = runScanner()
  assert(envExample.status === 1, '.env.example must be scanned')
  fs.rmSync(path.join(repo, '.env.example'))
  git(['rm', '--cached', '-q', '.env.example'])

  fs.writeFileSync(path.join(repo, 'bypass.txt'), `${fakeKey} // secret-scan:allow\n`)
  git(['add', 'bypass.txt'])
  const broadMarker = runScanner()
  assert(broadMarker.status === 1, 'allow marker must not bypass checks outside the scoped denylist path')

  console.log('secret-scan selftest passed: 5/5')
} finally {
  fs.rmSync(repo, { recursive: true, force: true })
}
