#!/usr/bin/env node

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { scanRepository } = require('./offline-github-governance.cjs')

function write(root, relativePath, source) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, source)
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-offline-github-governance-'))
  write(root, '.github/workflows/ci.yml', 'on:\n  pull_request:\npermissions:\n  contents: read\n')
  write(root, 'scripts/issue-handoff/check-pr-body.cjs', "const mode = '--body-file'\n")
  write(root, 'docs/agent-operating-contract.md', 'node scripts/offline-github-governance.cjs\n')
  return root
}

let passed = 0

function test(name, fn) {
  fn()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

const roots = []
try {
  test('accepts ordinary read-only CI and local handoff validation', () => {
    const root = makeFixture()
    roots.push(root)
    assert.deepEqual(scanRepository(root), [])
  })

  test('rejects a retired cloud review path', () => {
    const root = makeFixture()
    roots.push(root)
    write(root, '.github/workflows/ai-review-gate.yml', 'on: pull_request_target\n')
    assert(scanRepository(root).some((finding) => finding.includes('retired cloud governance path')))
  })

  test('rejects pull_request_target and write-capable workflow permissions', () => {
    const root = makeFixture()
    roots.push(root)
    write(root, '.github/workflows/bot.yml', 'on:\n  pull_request_target:\npermissions:\n  statuses: write\n  pull-requests: write\n  issues: write\n')
    const findings = scanRepository(root)
    assert(findings.some((finding) => finding.includes('pull_request_target')))
    assert(findings.some((finding) => finding.includes('commit-status write permission')))
    assert(findings.some((finding) => finding.includes('pull-request write permission')))
    assert(findings.some((finding) => finding.includes('issue write permission')))
  })

  test('rejects external AI credentials and endpoints in local scripts', () => {
    const root = makeFixture()
    roots.push(root)
    write(root, 'scripts/cloud-review.cjs', "fetch('https://api.deepseek.com', { headers: { authorization: process.env.DEEPSEEK_API_KEY } })\n")
    const findings = scanRepository(root)
    assert(findings.some((finding) => finding.includes('external AI secret')))
    assert(findings.some((finding) => finding.includes('external AI endpoint')))
  })

  test('rejects workflows that inherit repository token defaults', () => {
    const root = makeFixture()
    roots.push(root)
    write(root, '.github/workflows/implicit-token.yml', 'on:\n  push:\njobs: {}\n')
    assert(scanRepository(root).some((finding) => finding.includes('explicit top-level read-only permissions are missing')))
  })

  test('requires the local PR-body checker and contract command', () => {
    const root = makeFixture()
    roots.push(root)
    fs.rmSync(path.join(root, 'scripts', 'issue-handoff', 'check-pr-body.cjs'))
    write(root, 'docs/agent-operating-contract.md', 'offline only\n')
    const findings = scanRepository(root)
    assert(findings.some((finding) => finding.includes('local handoff checker is missing')))
    assert(findings.some((finding) => finding.includes('offline governance command is not required')))
  })
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
}

process.stdout.write(`offline GitHub governance selftest: ${passed}/${passed} passed\n`)
