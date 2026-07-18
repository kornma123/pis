import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export class ReleaseContractError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'ReleaseContractError'
    this.exitCode = exitCode
  }
}

export function parseArgs(argv, booleanNames = new Set(['json'])) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new ReleaseContractError(`unexpected positional argument: ${token}`)
    const name = token.slice(2)
    if (!name || values.has(name)) throw new ReleaseContractError(`invalid or duplicate option: ${token}`)
    if (booleanNames.has(name)) {
      values.set(name, true)
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new ReleaseContractError(`${token} requires a value`)
    values.set(name, value)
    index += 1
  }
  return values
}

export function requireOption(args, name) {
  const value = args.get(name)
  if (typeof value !== 'string' || value.length === 0) throw new ReleaseContractError(`--${name} is required`)
  return value
}

export function rejectUnknown(args, allowed) {
  for (const name of args.keys()) {
    if (!allowed.has(name)) throw new ReleaseContractError(`unsupported option: --${name}`)
  }
}

export function assertReleaseSha(value, label = 'release') {
  if (!/^[0-9a-f]{40}$/u.test(value)) {
    throw new ReleaseContractError(`${label} must be a 40-character lowercase commit SHA`)
  }
  return value
}

export function assertAbsolute(value, label) {
  if (!isAbsolute(value)) throw new ReleaseContractError(`${label} must be an absolute path`)
  return resolve(value)
}

function canonicalizeWithExistingAncestor(filePath) {
  const suffix = []
  let cursor = resolve(filePath)
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  return resolve(realpathSync(cursor), ...suffix)
}

export function assertOutsideRepository(value, label) {
  const absolute = assertAbsolute(value, label)
  const canonicalRepository = canonicalizeWithExistingAncestor(repositoryRoot)
  const canonicalTarget = canonicalizeWithExistingAncestor(absolute)
  const rel = relative(canonicalRepository, canonicalTarget)
  const inside = rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  if (inside) throw new ReleaseContractError(`${label} must stay outside the source repository`, 10)
  return absolute
}

export function assertRegularFile(filePath, label) {
  const absolute = assertAbsolute(filePath, label)
  let stat
  try {
    stat = lstatSync(absolute)
  } catch {
    throw new ReleaseContractError(`${label} does not exist`, 10)
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ReleaseContractError(`${label} must be a regular non-symlink file`, 10)
  }
  return absolute
}

export function ensurePrivateDirectory(directoryPath, { mustNotExist = false } = {}) {
  const absolute = assertAbsolute(directoryPath, 'directory')
  if (mustNotExist) {
    const parent = dirname(absolute)
    if (parent === absolute) throw new ReleaseContractError('filesystem root cannot be a target directory', 14)
    ensurePrivateDirectory(parent)
    try {
      // recursive:false makes ownership of the final directory atomic. A
      // concurrent process receives EEXIST and never enters target cleanup.
      mkdirSync(absolute, { recursive: false, mode: 0o700 })
    } catch (error) {
      if (error?.code === 'EEXIST') throw new ReleaseContractError('target directory already exists', 14)
      throw error
    }
  } else if (existsSync(absolute)) {
    const stat = lstatSync(absolute)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ReleaseContractError('directory must be a real directory, not a symlink', 10)
    }
  } else {
    mkdirSync(absolute, { recursive: true, mode: 0o700 })
  }
  try {
    chmodSync(absolute, 0o700)
  } catch {
    // Windows does not implement POSIX mode bits; path/type checks still apply.
  }
  return absolute
}

export function validateArtifactName(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/u.test(name) || name.includes('..')) {
    throw new ReleaseContractError('backup name must be a simple .db file name')
  }
  return name
}

export function validateDockerVolumeName(name) {
  if (
    typeof name !== 'string'
    || name.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name)
    || name === '.'
    || name === '..'
  ) {
    throw new ReleaseContractError('data volume must be a simple Docker volume name')
  }
  return name
}

export function artifactPath(directoryPath, name) {
  const target = resolve(directoryPath, validateArtifactName(name))
  if (dirname(target) !== resolve(directoryPath)) throw new ReleaseContractError('artifact escaped its output directory')
  return target
}

export function sha256File(filePath) {
  const hash = createHash('sha256')
  const descriptor = openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    let bytesRead
    do {
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead))
    } while (bytesRead > 0)
  } finally {
    closeSync(descriptor)
  }
  return hash.digest('hex')
}

export function inspectCoreoneDatabase(filePath) {
  const absolute = assertRegularFile(filePath, 'SQLite database')
  const stat = statSync(absolute)
  if (stat.size === 0) throw new ReleaseContractError('SQLite database is empty', 12)

  let database
  try {
    database = new DatabaseSync(absolute, { readOnly: true })
    const quick = database.prepare('PRAGMA quick_check').get()?.quick_check
    const integrity = database.prepare('PRAGMA integrity_check').get()?.integrity_check
    if (quick !== 'ok' || integrity !== 'ok') throw new Error('SQLite integrity check failed')

    const users = database
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='users'")
      .get()?.ok
    if (users !== 1) throw new Error('COREONE users table is missing')
    const userColumns = new Set(database.prepare('PRAGMA table_info(users)').all().map(row => row.name))
    for (const column of ['username', 'password']) {
      if (!userColumns.has(column)) throw new Error(`COREONE users.${column} is missing`)
    }

    return {
      bytes: stat.size,
      quickCheck: quick,
      integrityCheck: integrity,
      userVersion: Number(database.prepare('PRAGMA user_version').get()?.user_version || 0),
      pageCount: Number(database.prepare('PRAGMA page_count').get()?.page_count || 0),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown SQLite validation failure'
    throw new ReleaseContractError(`database validation failed: ${detail}`, 12)
  } finally {
    database?.close()
  }
}

export function atomicWriteJson(filePath, value) {
  const absolute = assertAbsolute(filePath, 'JSON output')
  ensurePrivateDirectory(dirname(absolute))
  if (existsSync(absolute)) throw new ReleaseContractError('JSON output already exists', 10)
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    // A same-directory hard link publishes the fully fsynced inode while
    // failing with EEXIST instead of overwriting a concurrently-created file.
    linkSync(temporary, absolute)
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The final hard link is already complete and durable. A stale hidden
      // temp link is safer than reporting failure and inviting a retry that
      // could race the valid output.
    }
    try {
      chmodSync(absolute, 0o600)
    } catch {
      // Best effort on Windows; Linux operator environments enforce the requested mode.
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
  return absolute
}

export function readManifest(manifestPath) {
  const absolute = assertRegularFile(manifestPath, 'backup manifest')
  let manifest
  try {
    manifest = JSON.parse(readFileSync(absolute, 'utf8'))
  } catch {
    throw new ReleaseContractError('backup manifest is not valid JSON', 13)
  }
  if (manifest?.schema !== 'coreone.sqlite-backup/v1') {
    throw new ReleaseContractError('backup manifest schema is unsupported', 13)
  }
  const manifestKeys = ['backupFile', 'bytes', 'createdAt', 'release', 'schema', 'sha256', 'snapshot']
  if (
    !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(manifestKeys)
  ) {
    throw new ReleaseContractError('backup manifest fields are invalid', 13)
  }
  assertReleaseSha(manifest.release, 'manifest release')
  validateArtifactName(manifest.backupFile)
  if (!/^[0-9a-f]{64}$/u.test(manifest.sha256 || '')) {
    throw new ReleaseContractError('backup manifest SHA-256 is invalid', 13)
  }
  if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes <= 0) {
    throw new ReleaseContractError('backup manifest byte count is invalid', 13)
  }
  try {
    if (new Date(manifest.createdAt).toISOString() !== manifest.createdAt) throw new Error()
  } catch {
    throw new ReleaseContractError('backup manifest timestamp is invalid', 13)
  }
  const snapshotKeys = ['bytes', 'integrityCheck', 'pageCount', 'quickCheck', 'userVersion']
  const snapshot = manifest.snapshot
  if (
    !snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(snapshotKeys)
    || !Number.isSafeInteger(snapshot.bytes)
    || snapshot.bytes <= 0
    || snapshot.quickCheck !== 'ok'
    || snapshot.integrityCheck !== 'ok'
    || !Number.isSafeInteger(snapshot.userVersion)
    || snapshot.userVersion < 0
    || !Number.isSafeInteger(snapshot.pageCount)
    || snapshot.pageCount <= 0
  ) {
    throw new ReleaseContractError('backup manifest snapshot fields are invalid', 13)
  }
  return { absolute, manifest }
}

export function verifyBackup({ backupPath, manifestPath, release }) {
  const backup = assertRegularFile(backupPath, 'backup')
  const { absolute: manifestFile, manifest } = readManifest(manifestPath)
  const expectedRelease = assertReleaseSha(release)
  if (manifest.release !== expectedRelease) throw new ReleaseContractError('backup release does not match', 13)
  if (manifest.backupFile !== basename(backup)) throw new ReleaseContractError('backup file name does not match manifest', 13)

  const bytes = statSync(backup).size
  const checksum = sha256File(backup)
  if (bytes !== manifest.bytes || checksum !== manifest.sha256) {
    throw new ReleaseContractError('backup size or SHA-256 does not match manifest', 13)
  }
  const sqlite = inspectCoreoneDatabase(backup)
  const expectedSnapshot = manifest.snapshot
  if (
    expectedSnapshot.bytes !== sqlite.bytes
    || expectedSnapshot.quickCheck !== sqlite.quickCheck
    || expectedSnapshot.integrityCheck !== sqlite.integrityCheck
    || expectedSnapshot.userVersion !== sqlite.userVersion
    || expectedSnapshot.pageCount !== sqlite.pageCount
  ) {
    throw new ReleaseContractError('backup manifest snapshot metadata does not match verified backup', 13)
  }
  return {
    schema: 'coreone.sqlite-backup-verification/v1',
    verifiedAt: new Date().toISOString(),
    release: expectedRelease,
    backupPath: backup,
    manifestPath: manifestFile,
    sha256: checksum,
    bytes,
    sqlite,
  }
}

export function printResult(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`)
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

export async function runCli(main) {
  try {
    await main()
  } catch (error) {
    const code = error instanceof ReleaseContractError ? error.exitCode : 1
    const message = error instanceof Error ? error.message : 'unknown release command failure'
    process.stderr.write(`release command failed: ${message}\n`)
    process.exit(code)
  }
}
