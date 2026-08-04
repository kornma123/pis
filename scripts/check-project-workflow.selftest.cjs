#!/usr/bin/env node

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { checkProjectWorkflow } = require('./check-project-workflow.cjs')

const roots = []
let passed = 0

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function write(root, relativePath, content) {
  const absolute = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, content)
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coreone-project-workflow-'))
  roots.push(root)
  const canonicalPath = '.agents/skills/run-graph-workflow'
  const adapterPath = '.claude/skills/run-graph-workflow/SKILL.md'
  const payload = {
    [`${canonicalPath}/SKILL.md`]: '---\nname: run-graph-workflow\n---\n# Workflow\n',
    [`${canonicalPath}/skill-package.json`]: `${JSON.stringify({
      package_id: 'run-graph-workflow',
      version: '1.4.2',
      source_repository: 'kornma123/kornma-pm-work',
      source_path: 'workflows/run-graph-workflow',
      release_tag: 'run-graph-workflow-v1.4.2',
    })}\n`,
    [adapterPath]: [
      '---',
      'name: run-graph-workflow',
      'description: project adapter',
      '---',
      '<!-- project-skill-adapter/v1 -->',
      'Read `${CLAUDE_PROJECT_DIR}/.agents/skills/run-graph-workflow/SKILL.md` completely.',
      '',
    ].join('\n'),
  }
  for (const [relativePath, content] of Object.entries(payload)) write(root, relativePath, content)
  write(
    root,
    '.agents/skills/run-graph-workflow.lock.json',
    `${JSON.stringify({
      schema_version: 1,
      source: {
        repository: 'kornma123/kornma-pm-work',
        ref: 'run-graph-workflow-v1.4.2',
        commit: '8f7a3d15dc36a445640a7246007eaa7d0d416ed8',
        path: 'workflows/run-graph-workflow/payload/run-graph-workflow',
        tree: '89c0b0c47b7c1f1360ded14e4f914349bf798164',
        version: '1.4.2',
      },
      canonical_path: canonicalPath,
      claude_adapter_path: adapterPath,
      files: Object.fromEntries(Object.entries(payload).map(([name, content]) => [name, sha256(content)])),
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
  test('accepts a pinned canonical workflow and thin Claude adapter', () => {
    assert.deepEqual(checkProjectWorkflow(makeFixture(), { skipSelfCheck: true }), [])
  })

  test('rejects canonical payload byte drift', () => {
    const root = makeFixture()
    fs.appendFileSync(path.join(root, '.agents/skills/run-graph-workflow/SKILL.md'), 'drift\n')
    assert(checkProjectWorkflow(root, { skipSelfCheck: true }).some((finding) => finding.includes('sha256 mismatch')))
  })

  test('rejects missing and extra canonical files', () => {
    const root = makeFixture()
    fs.rmSync(path.join(root, '.agents/skills/run-graph-workflow/SKILL.md'))
    write(root, '.agents/skills/run-graph-workflow/EXTRA.md', 'unexpected\n')
    const findings = checkProjectWorkflow(root, { skipSelfCheck: true })
    assert(findings.some((finding) => finding.includes('managed file is missing')))
    assert(findings.some((finding) => finding.includes('unlocked canonical file')))
  })

  test('rejects source metadata that disagrees with the package', () => {
    const root = makeFixture()
    const lockPath = path.join(root, '.agents/skills/run-graph-workflow.lock.json')
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    lock.source.version = '9.9.9'
    write(root, '.agents/skills/run-graph-workflow.lock.json', `${JSON.stringify(lock, null, 2)}\n`)
    assert(checkProjectWorkflow(root, { skipSelfCheck: true }).some((finding) => finding.includes('package version')))
  })

  test('rejects a second full contract in the Claude adapter', () => {
    const root = makeFixture()
    const lockPath = path.join(root, '.agents/skills/run-graph-workflow.lock.json')
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    const adapterPath = lock.claude_adapter_path
    const copiedContract = `${'contract '.repeat(400)}GEW-CONTRACT-1.4.2\n`
    write(root, adapterPath, copiedContract)
    lock.files[adapterPath] = sha256(copiedContract)
    write(root, '.agents/skills/run-graph-workflow.lock.json', `${JSON.stringify(lock, null, 2)}\n`)
    assert(checkProjectWorkflow(root, { skipSelfCheck: true }).some((finding) => finding.includes('thin adapter')))
  })

  test('rejects paths that escape the repository', () => {
    const root = makeFixture()
    const lockPath = path.join(root, '.agents/skills/run-graph-workflow.lock.json')
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
    lock.files['../outside'] = '0'.repeat(64)
    write(root, '.agents/skills/run-graph-workflow.lock.json', `${JSON.stringify(lock, null, 2)}\n`)
    assert(checkProjectWorkflow(root, { skipSelfCheck: true }).some((finding) => finding.includes('repository-relative')))
  })
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
}

process.stdout.write(`project workflow selftest: ${passed}/${passed} passed\n`)
