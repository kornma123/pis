#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const SUPPORTED_NODE_RANGE = '^22.23.1 || ^24.0.0'
export const RUNTIME_CHECK_COMMAND = 'node scripts/check-runtime-contract.mjs'

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

const REQUIRED_SCRIPTS = {
  'check:runtime': RUNTIME_CHECK_COMMAND,
  'test:contract': 'node --test tests/dependency-runtime-contract.test.mjs',
  preinstall: RUNTIME_CHECK_COMMAND,
  dev: `${RUNTIME_CHECK_COMMAND} && tsx watch src/app.ts`,
  build: `${RUNTIME_CHECK_COMMAND} && tsc`,
  start: `${RUNTIME_CHECK_COMMAND} && node --experimental-sqlite scripts/start-production.mjs`,
  seed: `${RUNTIME_CHECK_COMMAND} && tsx scripts/seed-acceptance-data.ts`,
  'reset-passwords': `${RUNTIME_CHECK_COMMAND} && tsx scripts/reset-passwords.ts`,
  test: `${RUNTIME_CHECK_COMMAND} && node --test tests/dependency-runtime-contract.test.mjs && vitest run`,
  'test:node': `${RUNTIME_CHECK_COMMAND} && node --test tests/dependency-runtime-contract.test.mjs && node --experimental-sqlite node_modules/vitest/vitest.mjs run`,
}

const packageUrl = new URL('../package.json', import.meta.url)
const lockfileUrl = new URL('../package-lock.json', import.meta.url)
const shrinkwrapUrl = new URL('../npm-shrinkwrap.json', import.meta.url)

function isSqlite3Name(value) {
  return typeof value === 'string' && value.toLowerCase() === 'sqlite3'
}

function isSqlite3Alias(value) {
  return typeof value === 'string' && /^npm:sqlite3(?:@|$)/i.test(value)
}

function isSqlite3Tarball(value) {
  return typeof value === 'string' && /\/sqlite3\/-\/sqlite3-[^/]+\.tgz(?:$|[?#])/i.test(value)
}

function dependencyEntryTargetsSqlite3(name, spec) {
  return isSqlite3Name(name) || isSqlite3Alias(spec)
}

async function fileExists(url) {
  try {
    await access(url)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) return null

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

export function isSupportedNodeVersion(version) {
  const parsed = parseNodeVersion(version)
  if (!parsed) return false

  if (parsed.major === 22) {
    return parsed.minor > 23 || (parsed.minor === 23 && parsed.patch >= 1)
  }

  return parsed.major === 24
}

export function findManifestDependencyViolations(manifest) {
  const violations = []

  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, spec] of Object.entries(manifest?.[section] ?? {})) {
      if (isSqlite3Name(name)) {
        violations.push(`package.json ${section} must not declare sqlite3; use node:sqlite`)
      } else if (isSqlite3Alias(spec)) {
        violations.push(`package.json ${section}.${name} must not alias sqlite3; use node:sqlite`)
      }
    }
  }

  return violations
}

export function findLockfileDependencyViolations(lockfile) {
  const violations = []

  for (const [packagePath, entry] of Object.entries(lockfile?.packages ?? {})) {
    const normalizedPath = packagePath.replaceAll('\\', '/')
    if (/(^|\/)node_modules\/sqlite3$/i.test(normalizedPath)) {
      violations.push(`package-lock.json contains ${packagePath}`)
    }

    if (isSqlite3Name(entry?.name)) {
      violations.push(`package-lock.json ${packagePath || '<root>'} identifies package sqlite3`)
    }

    if (isSqlite3Alias(entry?.version) || isSqlite3Tarball(entry?.resolved)) {
      violations.push(`package-lock.json ${packagePath || '<root>'} resolves to sqlite3`)
    }

    for (const section of DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(entry?.[section] ?? {})) {
        if (dependencyEntryTargetsSqlite3(name, spec)) {
          const owner = packagePath || '<root>'
          violations.push(`package-lock.json ${owner} ${section}.${name} targets sqlite3`)
        }
      }
    }
  }

  for (const [name, entry] of Object.entries(lockfile?.dependencies ?? {})) {
    if (
      isSqlite3Name(name)
      || isSqlite3Name(entry?.name)
      || isSqlite3Alias(entry?.version)
      || isSqlite3Tarball(entry?.resolved)
    ) {
      violations.push(`package-lock.json legacy dependency map ${name} targets sqlite3`)
    }
  }

  return violations
}

export function findLockfileSelectionViolations(hasShrinkwrap) {
  return hasShrinkwrap
    ? ['npm-shrinkwrap.json must not override the checked package-lock.json']
    : []
}

export function findRuntimeWiringViolations(manifest, lockfile) {
  const violations = []

  if (manifest?.engines?.node !== SUPPORTED_NODE_RANGE) {
    violations.push(`package.json engines.node must equal ${SUPPORTED_NODE_RANGE}`)
  }

  if (lockfile?.packages?.['']?.engines?.node !== SUPPORTED_NODE_RANGE) {
    violations.push(`package-lock.json root engines.node must equal ${SUPPORTED_NODE_RANGE}`)
  }

  const devRuntime = manifest?.devEngines?.runtime
  if (
    devRuntime?.name !== 'node'
    || devRuntime?.version !== SUPPORTED_NODE_RANGE
    || devRuntime?.onFail !== 'error'
  ) {
    violations.push('package.json devEngines.runtime must fail on unsupported Node.js')
  }

  for (const [scriptName, expected] of Object.entries(REQUIRED_SCRIPTS)) {
    if (manifest?.scripts?.[scriptName] !== expected) {
      violations.push(`package.json scripts.${scriptName} must equal ${expected}`)
    }
  }

  return violations
}

export function findRuntimeCapabilityViolations(version, hasDatabaseSync) {
  const violations = []

  if (!isSupportedNodeVersion(version)) {
    violations.push(`Node.js ${version} is unsupported; expected ${SUPPORTED_NODE_RANGE}`)
  } else if (!hasDatabaseSync) {
    violations.push('node:sqlite DatabaseSync in-memory probe failed')
  }

  return violations
}

export function probeDatabaseSync(sqlite) {
  if (typeof sqlite?.DatabaseSync !== 'function') return false

  let database
  let probePassed = false
  try {
    database = new sqlite.DatabaseSync(':memory:')
    const row = database.prepare('SELECT 1 AS ok').get()
    probePassed = row?.ok === 1
  } catch {
    probePassed = false
  } finally {
    try {
      database?.close()
    } catch {
      probePassed = false
    }
  }

  return probePassed
}

export async function checkRuntimeContract({
  nodeVersion = process.versions.node,
  readJson = async url => JSON.parse(await readFile(url, 'utf8')),
  pathExists = fileExists,
  loadSqlite = () => import('node:sqlite'),
} = {}) {
  const [manifest, lockfile, hasShrinkwrap] = await Promise.all([
    readJson(packageUrl),
    readJson(lockfileUrl),
    pathExists(shrinkwrapUrl),
  ])

  const violations = [
    ...findManifestDependencyViolations(manifest),
    ...findLockfileDependencyViolations(lockfile),
    ...findLockfileSelectionViolations(hasShrinkwrap),
    ...findRuntimeWiringViolations(manifest, lockfile),
  ]

  let hasDatabaseSync = false
  if (isSupportedNodeVersion(nodeVersion)) {
    try {
      const sqlite = await loadSqlite()
      hasDatabaseSync = probeDatabaseSync(sqlite)
    } catch {
      hasDatabaseSync = false
    }
  }
  violations.push(...findRuntimeCapabilityViolations(nodeVersion, hasDatabaseSync))

  if (violations.length > 0) {
    throw new Error(`[runtime-contract]\n- ${violations.join('\n- ')}`)
  }

  return { nodeVersion, supportedRange: SUPPORTED_NODE_RANGE }
}

async function main() {
  try {
    const result = await checkRuntimeContract()
    console.log(
      `[runtime-contract] Node.js ${result.nodeVersion} satisfies ${result.supportedRange}; node:sqlite in-memory probe passed.`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isMain) {
  await main()
}
