#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_REGISTRY_PATH = 'docs/document-authority-registry.json'
const HISTORICAL_MARKER = '<!-- coreone-document-authority:historical -->'
const HISTORICAL_LABEL = 'SUPERSEDED / 历史考古资料'
const MOVING_BRANCH_SHA = /\b(?:origin\/)?(?:master|main)@[0-9a-f]{7,40}\b/i
const LIVE_ITEM_STATE = /\b(?:Issue|PR)\s*#\d+\s*(?:=|:|：)\s*(?:OPEN|CLOSED|MERGED|DRAFT|NO_GO)\b/i

function normalizeRegistryPath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/') : ''
}

function resolveRegisteredPath(root, value, findings) {
  const normalized = normalizeRegistryPath(value)
  if (!normalized || normalized !== value || path.posix.isAbsolute(normalized)) {
    findings.push(`${String(value)}: registry path must be a non-empty repository-relative POSIX path`)
    return null
  }
  const absolute = path.resolve(root, ...normalized.split('/'))
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    findings.push(`${normalized}: registered path escapes repository root`)
    return null
  }
  return { normalized, absolute }
}

function readRegistry(root, registryRelativePath, findings) {
  const registryPath = path.resolve(root, ...registryRelativePath.split('/'))
  let registry
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  } catch (error) {
    findings.push(`${registryRelativePath}: cannot read valid JSON (${error.message})`)
    return null
  }
  if (registry.version !== 1) findings.push(`${registryRelativePath}: version must equal 1`)
  if (
    typeof registry.liveAuthority !== 'string'
    || !/^https:\/\/github\.com\/kornma123\/pis\/issues(?:\/)?$/i.test(registry.liveAuthority)
  ) {
    findings.push(`${registryRelativePath}: liveAuthority must point to the repository Issues index`)
  }
  for (const key of ['stableDocuments', 'historicalDocuments']) {
    if (!Array.isArray(registry[key]) || registry[key].length === 0) {
      findings.push(`${registryRelativePath}: ${key} must be a non-empty array`)
    }
  }
  return registry
}

function checkDocumentDrift(root, options = {}) {
  const findings = []
  const registryRelativePath = options.registryPath || DEFAULT_REGISTRY_PATH
  const registry = readRegistry(root, registryRelativePath, findings)
  if (!registry) return findings

  const stable = Array.isArray(registry.stableDocuments) ? registry.stableDocuments : []
  const historical = Array.isArray(registry.historicalDocuments) ? registry.historicalDocuments : []
  const seen = new Set()
  const stableSet = new Set(stable.map(normalizeRegistryPath))
  const historicalSet = new Set(historical.map(normalizeRegistryPath))

  for (const normalized of stableSet) {
    if (historicalSet.has(normalized)) findings.push(`${normalized}: document cannot be both stable and historical`)
  }

  for (const [kind, entries] of [['stable', stable], ['historical', historical]]) {
    for (const entry of entries) {
      const resolved = resolveRegisteredPath(root, entry, findings)
      if (!resolved) continue
      if (seen.has(resolved.normalized)) {
        findings.push(`${resolved.normalized}: duplicate registry path`)
        continue
      }
      seen.add(resolved.normalized)
      if (!fs.existsSync(resolved.absolute) || !fs.statSync(resolved.absolute).isFile()) {
        findings.push(`${resolved.normalized}: registered document is missing`)
        continue
      }

      const source = fs.readFileSync(resolved.absolute, 'utf8')
      if (kind === 'historical') {
        const header = source.slice(0, 2000)
        if (!header.includes(HISTORICAL_MARKER)) {
          findings.push(`${resolved.normalized}: missing ${HISTORICAL_MARKER}`)
        }
        if (!header.includes(HISTORICAL_LABEL)) {
          findings.push(`${resolved.normalized}: missing ${HISTORICAL_LABEL}`)
        }
        if (!header.includes(registry.liveAuthority)) {
          findings.push(`${resolved.normalized}: historical header must link to live authority ${registry.liveAuthority}`)
        }
        continue
      }

      if (source.includes(HISTORICAL_MARKER) || source.includes(HISTORICAL_LABEL)) {
        findings.push(`${resolved.normalized}: stable document carries a historical authority marker`)
      }
      if (LIVE_ITEM_STATE.test(source)) {
        findings.push(`${resolved.normalized}: live Issue/PR state snapshot is forbidden; link to live GitHub instead`)
      }
      if (MOVING_BRANCH_SHA.test(source)) {
        findings.push(`${resolved.normalized}: moving branch SHA snapshot is forbidden; use Git history for provenance`)
      }
    }
  }

  return findings
}

function main() {
  const root = path.resolve(__dirname, '..')
  const findings = checkDocumentDrift(root)
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ verdict: findings.length ? 'FAIL' : 'PASS', findings }, null, 2)}\n`)
  } else if (findings.length) {
    process.stderr.write(`document drift gate: FAIL (${findings.length})\n`)
    for (const finding of findings) process.stderr.write(`- ${finding}\n`)
  } else {
    process.stdout.write('document drift gate: PASS\n')
  }
  process.exitCode = findings.length ? 1 : 0
}

if (require.main === module) main()

module.exports = {
  checkDocumentDrift,
  HISTORICAL_LABEL,
  HISTORICAL_MARKER,
}
