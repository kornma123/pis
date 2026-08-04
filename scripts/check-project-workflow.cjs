#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DEFAULT_LOCK_PATH = '.agents/skills/run-graph-workflow.lock.json'
const CANONICAL_PATH = '.agents/skills/run-graph-workflow'
const CLAUDE_ADAPTER_PATH = '.claude/skills/run-graph-workflow/SKILL.md'

function sha256(filePath) {
  const digest = crypto.createHash('sha256')
  digest.update(fs.readFileSync(filePath))
  return digest.digest('hex')
}

function resolveRepositoryPath(root, value, findings, label) {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\\')
    || path.posix.isAbsolute(value)
    || path.posix.normalize(value) !== value
    || value === '..'
    || value.startsWith('../')
  ) {
    findings.push(`${label}: path must be a normalized repository-relative POSIX path`)
    return null
  }
  const absolute = path.resolve(root, ...value.split('/'))
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    findings.push(`${label}: path must be a normalized repository-relative POSIX path`)
    return null
  }
  return absolute
}

function listFiles(root, relativeRoot) {
  const absoluteRoot = path.join(root, ...relativeRoot.split('/'))
  if (!fs.existsSync(absoluteRoot)) return []
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(path.relative(root, absolute).split(path.sep).join('/'))
      else files.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  visit(absoluteRoot)
  return files.sort()
}

function readJson(filePath, findings, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    findings.push(`${label}: cannot read valid JSON (${error.message})`)
    return null
  }
}

function validateSource(lock, packageJson, findings) {
  const source = lock.source || {}
  if (source.repository !== 'kornma123/kornma-pm-work') findings.push('source repository is not canonical')
  if (!/^run-graph-workflow-v\d+\.\d+\.\d+$/.test(String(source.ref || ''))) {
    findings.push('source ref must be a fixed run-graph-workflow release tag')
  }
  for (const field of ['commit', 'tree']) {
    if (!/^[0-9a-f]{40}$/.test(String(source[field] || ''))) findings.push(`source ${field} must be a full Git object id`)
  }
  if (source.path !== 'workflows/run-graph-workflow/payload/run-graph-workflow') {
    findings.push('source path is not the canonical payload path')
  }
  if (!packageJson) return
  if (packageJson.package_id !== 'run-graph-workflow') findings.push('package id is not run-graph-workflow')
  if (packageJson.version !== source.version) findings.push('package version does not match lock source version')
  if (packageJson.source_repository !== source.repository) findings.push('package source repository does not match lock')
  if (packageJson.release_tag !== source.ref) findings.push('package release tag does not match lock')
  const expectedPath = `${packageJson.source_path}/payload/${packageJson.package_id}`
  if (expectedPath !== source.path) findings.push('package source path does not match lock')
}

function validateAdapter(root, lock, findings) {
  const adapterPath = resolveRepositoryPath(root, lock.claude_adapter_path, findings, 'claude adapter')
  if (!adapterPath || !fs.existsSync(adapterPath)) return
  const source = fs.readFileSync(adapterPath, 'utf8')
  if (
    Buffer.byteLength(source, 'utf8') > 1600
    || source.includes('GEW-CONTRACT-')
    || !source.includes('project-skill-adapter/v1')
    || !source.includes('${CLAUDE_PROJECT_DIR}/.agents/skills/run-graph-workflow/SKILL.md')
  ) {
    findings.push(`${lock.claude_adapter_path}: must remain a thin adapter to the canonical project skill`)
  }
}

function runSelfCheck(root, lock, findings) {
  const script = path.join(root, ...lock.canonical_path.split('/'), 'scripts', 'self_check.py')
  const candidates = process.platform === 'win32'
    ? [['py', '-3'], ['python', null], ['python3', null]]
    : [['python3', null], ['python', null]]
  let completed = null
  for (const [binary, prefix] of candidates) {
    const args = [...(prefix ? [prefix] : []), script, '--root', path.dirname(path.dirname(script)), '--json']
    const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout: 30_000 })
    if (!result.error || result.error.code !== 'ENOENT') {
      completed = result
      break
    }
  }
  if (!completed) {
    findings.push('canonical self_check could not start because Python is unavailable')
    return
  }
  let report = null
  try {
    report = JSON.parse(completed.stdout || '')
  } catch {
    findings.push('canonical self_check did not return JSON')
    return
  }
  if (completed.status !== 0 || report.status !== 'PASS') findings.push('canonical self_check did not PASS')
  if (report.version !== lock.source.version) findings.push('canonical self_check version does not match lock')
}

function checkProjectWorkflow(root, options = {}) {
  const findings = []
  const repositoryRoot = path.resolve(root)
  const lockRelativePath = options.lockPath || DEFAULT_LOCK_PATH
  const lockPath = resolveRepositoryPath(repositoryRoot, lockRelativePath, findings, 'lock')
  if (!lockPath) return findings
  const lock = readJson(lockPath, findings, lockRelativePath)
  if (!lock) return findings

  if (lock.schema_version !== 1) findings.push('lock schema_version must equal 1')
  if (lock.canonical_path !== CANONICAL_PATH) findings.push(`canonical_path must equal ${CANONICAL_PATH}`)
  if (lock.claude_adapter_path !== CLAUDE_ADAPTER_PATH) {
    findings.push(`claude_adapter_path must equal ${CLAUDE_ADAPTER_PATH}`)
  }
  if (!lock.files || typeof lock.files !== 'object' || Array.isArray(lock.files)) {
    findings.push('lock files must be an object')
    return findings
  }

  const lockedFiles = new Set()
  for (const [relativePath, expectedHash] of Object.entries(lock.files)) {
    const absolute = resolveRepositoryPath(repositoryRoot, relativePath, findings, `file ${relativePath}`)
    if (!absolute) continue
    lockedFiles.add(relativePath)
    if (!/^[0-9a-f]{64}$/.test(String(expectedHash || ''))) {
      findings.push(`${relativePath}: lock sha256 must be lowercase 64-hex`)
      continue
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      findings.push(`${relativePath}: managed file is missing`)
      continue
    }
    if (sha256(absolute) !== expectedHash) findings.push(`${relativePath}: sha256 mismatch`)
  }

  for (const relativePath of listFiles(repositoryRoot, CANONICAL_PATH)) {
    if (!lockedFiles.has(relativePath)) findings.push(`${relativePath}: unlocked canonical file`)
  }
  if (!lockedFiles.has(CLAUDE_ADAPTER_PATH)) findings.push(`${CLAUDE_ADAPTER_PATH}: adapter is not locked`)

  const packagePath = path.join(repositoryRoot, CANONICAL_PATH, 'skill-package.json')
  const packageJson = fs.existsSync(packagePath) ? readJson(packagePath, findings, 'skill-package.json') : null
  validateSource(lock, packageJson, findings)
  validateAdapter(repositoryRoot, lock, findings)
  if (!options.skipSelfCheck && packageJson) runSelfCheck(repositoryRoot, lock, findings)
  return findings
}

function main() {
  const root = path.resolve(__dirname, '..')
  const findings = checkProjectWorkflow(root)
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ verdict: findings.length ? 'FAIL' : 'PASS', findings }, null, 2)}\n`)
  } else if (findings.length) {
    process.stderr.write(`project workflow gate: FAIL (${findings.length})\n`)
    for (const finding of findings) process.stderr.write(`- ${finding}\n`)
  } else {
    process.stdout.write('project workflow gate: PASS\n')
  }
  process.exitCode = findings.length ? 1 : 0
}

if (require.main === module) main()

module.exports = { checkProjectWorkflow }
