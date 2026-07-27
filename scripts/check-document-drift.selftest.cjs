#!/usr/bin/env node

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkDocumentDrift } = require('./check-document-drift.cjs')

const roots = []
let passed = 0

function write(root, relativePath, content) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-document-drift-'))
  roots.push(root)
  write(root, 'docs/current.md', '# Current authority\n')
  write(
    root,
    'docs/history.md',
    [
      '# Historical report',
      '',
      '<!-- coreone-document-authority:historical -->',
      '> **权威状态：SUPERSEDED / 历史考古资料**',
      '> 当前状态统一读取：https://github.com/kornma123/pis/issues',
      '',
    ].join('\n'),
  )
  write(
    root,
    'docs/document-authority-registry.json',
    `${JSON.stringify({
      version: 1,
      liveAuthority: 'https://github.com/kornma123/pis/issues',
      stableDocuments: ['docs/current.md'],
      historicalDocuments: ['docs/history.md'],
    }, null, 2)}\n`,
  )
  return root
}

function test(name, fn) {
  fn()
  passed += 1
  process.stdout.write(`ok ${passed} - ${name}\n`)
}

try {
  test('accepts registered stable and historical documents', () => {
    assert.deepEqual(checkDocumentDrift(makeFixture()), [])
  })

  test('rejects a historical report whose SUPERSEDED marker was removed', () => {
    const root = makeFixture()
    write(root, 'docs/history.md', '# Historical report\n')
    const findings = checkDocumentDrift(root)
    assert(findings.some((finding) => finding.includes('SUPERSEDED')))
    assert(findings.some((finding) => finding.includes('coreone-document-authority:historical')))
  })

  test('rejects live Issue state snapshots in stable documents', () => {
    const root = makeFixture()
    write(root, 'docs/current.md', '# Current authority\nIssue #1 = OPEN\n')
    assert(checkDocumentDrift(root).some((finding) => finding.includes('live Issue/PR state snapshot')))
  })

  test('rejects moving master SHA snapshots in stable documents', () => {
    const root = makeFixture()
    write(root, 'docs/current.md', '# Current authority\norigin/master@0123456789abcdef0123456789abcdef01234567\n')
    assert(checkDocumentDrift(root).some((finding) => finding.includes('moving branch SHA snapshot')))
  })

  test('rejects duplicate, missing, and out-of-root registry paths', () => {
    const root = makeFixture()
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/document-authority-registry.json'), 'utf8'))
    registry.stableDocuments.push('docs/current.md', 'docs/missing.md', '../outside.md')
    write(root, 'docs/document-authority-registry.json', `${JSON.stringify(registry, null, 2)}\n`)
    const findings = checkDocumentDrift(root)
    assert(findings.some((finding) => finding.includes('duplicate registry path')))
    assert(findings.some((finding) => finding.includes('registered document is missing')))
    assert(findings.some((finding) => finding.includes('escapes repository root')))
  })

  test('rejects one document registered as both stable and historical', () => {
    const root = makeFixture()
    const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/document-authority-registry.json'), 'utf8'))
    registry.stableDocuments.push('docs/history.md')
    write(root, 'docs/document-authority-registry.json', `${JSON.stringify(registry, null, 2)}\n`)
    assert(checkDocumentDrift(root).some((finding) => finding.includes('both stable and historical')))
  })
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
}

process.stdout.write(`document drift selftest: ${passed}/${passed} passed\n`)
