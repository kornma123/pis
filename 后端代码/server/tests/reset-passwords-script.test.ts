import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

const tempDirs: string[] = []
const scriptArgs = ['--import', 'tsx', 'scripts/reset-passwords.ts'] as const

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function syntheticStrongPassword(label: string): string {
  return ['CliSpec', label, 'N7v!', 'Q2m@', 'R8x#'].join('-')
}

function makeInputFiles(accounts = ['owner-a']) {
  const dir = mkdtempSync(join(tmpdir(), 'coreone-provisioning-cli-'))
  tempDirs.push(dir)
  const databasePath = join(dir, 'coreone.db')
  const manifestPath = join(dir, 'approved-accounts.json')
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      real_name TEXT NOT NULL,
      role TEXT NOT NULL,
      primary_role TEXT,
      department TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      updated_by TEXT
    );
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role_code TEXT NOT NULL,
      UNIQUE(user_id, role_code)
    );
    INSERT INTO roles VALUES ('ROLE-ADMIN', 'admin', 1, 0);
  `)
  database.close()
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    approvalReference: 'SEC-PROVISION-SYNTHETIC-CLI',
    accounts: accounts.map((username, index) => ({
      username,
      realName: `合成账号${index + 1}`,
      roles: ['admin'],
      primaryRole: 'admin',
    })),
  }), 'utf8')
  return { databasePath, manifestPath }
}

function userCount(databasePath: string): number {
  const database = new DatabaseSync(databasePath)
  const count = (database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count
  database.close()
  return count
}

function cleanProvisioningEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase()
    if (normalizedKey.startsWith('RESET_') || normalizedKey.startsWith('PROVISIONING_')) delete env[key]
    if (normalizedKey === 'ADMIN_INITIAL_PASSWORD') delete env[key]
  }
  return { ...env, ...overrides }
}

function manifestSha256(manifestPath: string): string {
  return createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
}

function provisioningEnv(files: { databasePath: string; manifestPath: string }): NodeJS.ProcessEnv {
  return {
    DATABASE_PATH: files.databasePath,
    PROVISIONING_MANIFEST_PATH: files.manifestPath,
    PROVISIONING_MANIFEST_SHA256: manifestSha256(files.manifestPath),
  }
}

function runEntry(input: {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  stdin?: string
}) {
  return spawnSync(process.execPath, [...scriptArgs, ...(input.argv ?? [])], {
    cwd: process.cwd(),
    env: cleanProvisioningEnv(input.env ?? {}),
    input: input.stdin,
    encoding: 'utf8',
    windowsHide: true,
  })
}

describe('approved provisioning CLI security boundary', () => {
  it('rejects legacy credential environment variables even when valid stdin is present', () => {
    const files = makeInputFiles()
    const legacyCredential = syntheticStrongPassword('LegacyEnvironment')
    const stdinCredential = syntheticStrongPassword('StdinTransport')

    for (const legacyKey of [
      'RESET_ADMIN_PASSWORD',
      'reset_admin_password',
      'ADMIN_INITIAL_PASSWORD',
      'Admin_Initial_Password',
    ]) {
      const result = runEntry({
        env: { ...provisioningEnv(files), [legacyKey]: legacyCredential },
        stdin: JSON.stringify({
          schemaVersion: 1,
          credentials: { 'owner-a': stdinCredential },
        }),
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('LEGACY_CREDENTIAL_ENV_FORBIDDEN')
      expect(result.stdout).not.toContain(legacyCredential)
      expect(result.stderr).not.toContain(legacyCredential)
      expect(result.stdout).not.toContain(stdinCredential)
      expect(result.stderr).not.toContain(stdinCredential)
      expect(userCount(files.databasePath)).toBe(0)
    }
  })

  it('rejects every extra argv value before reading credentials or opening the database', () => {
    const files = makeInputFiles()
    const credential = syntheticStrongPassword('ArgvForbidden')

    const result = runEntry({
      argv: [credential],
      env: provisioningEnv(files),
      stdin: JSON.stringify({ schemaVersion: 1, credentials: { 'owner-a': credential } }),
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CREDENTIAL_ARGV_FORBIDDEN')
    expect(result.stdout).not.toContain(credential)
    expect(result.stderr).not.toContain(credential)
    expect(userCount(files.databasePath)).toBe(0)
  })

  it('requires an existing absolute non-secret manifest path', () => {
    const files = makeInputFiles()
    const credential = syntheticStrongPassword('MissingManifest')

    const result = runEntry({
      env: { DATABASE_PATH: files.databasePath },
      stdin: JSON.stringify({ schemaVersion: 1, credentials: { 'owner-a': credential } }),
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('PROVISIONING_MANIFEST_PATH_REQUIRED')
    expect(result.stdout).not.toContain(credential)
    expect(result.stderr).not.toContain(credential)
  })

  it('requires an existing absolute database path without creating it', () => {
    const files = makeInputFiles()
    const missingDatabasePath = join(tempDirs[0], 'missing.db')
    const credential = syntheticStrongPassword('MissingDatabase')

    const result = runEntry({
      env: {
        ...provisioningEnv(files),
        DATABASE_PATH: missingDatabasePath,
      },
      stdin: JSON.stringify({ schemaVersion: 1, credentials: { 'owner-a': credential } }),
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DATABASE_PATH_REQUIRED')
    expect(result.stdout).not.toContain(credential)
    expect(result.stderr).not.toContain(credential)
  })

  it('binds execution to the operator-approved manifest SHA-256', () => {
    const files = makeInputFiles()
    const credential = syntheticStrongPassword('ManifestDigest')

    const result = runEntry({
      env: {
        ...provisioningEnv(files),
        PROVISIONING_MANIFEST_SHA256: '0'.repeat(64),
      },
      stdin: JSON.stringify({ schemaVersion: 1, credentials: { 'owner-a': credential } }),
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('PROVISIONING_MANIFEST_SHA256_MISMATCH')
    expect(result.stdout).not.toContain(credential)
    expect(result.stderr).not.toContain(credential)
    expect(userCount(files.databasePath)).toBe(0)
  })

  it('rejects policy-invalid credentials before opening the database', () => {
    const files = makeInputFiles()
    const rejectedCredential = 'short-test'

    const result = runEntry({
      env: provisioningEnv(files),
      stdin: JSON.stringify({
        schemaVersion: 1,
        credentials: { 'owner-a': rejectedCredential },
      }),
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CREDENTIAL_POLICY_REJECTED')
    expect(result.stdout).not.toContain(rejectedCredential)
    expect(result.stderr).not.toContain(rejectedCredential)
  })

  it('rejects Unicode-equivalent credential reuse without echoing either value', () => {
    const files = makeInputFiles(['owner-a', 'owner-b'])
    const firstCredential = syntheticStrongPassword('Shared')
    const equivalentCredential = firstCredential.replace('CliSpec', 'ＣｌｉＳｐｅｃ')

    const result = runEntry({
      env: provisioningEnv(files),
      stdin: JSON.stringify({
        schemaVersion: 1,
        credentials: {
          'owner-a': firstCredential,
          'owner-b': equivalentCredential,
        },
      }),
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CREDENTIAL_REUSE_REJECTED')
    expect(result.stdout).not.toContain(firstCredential)
    expect(result.stderr).not.toContain(firstCredential)
    expect(result.stdout).not.toContain(equivalentCredential)
    expect(result.stderr).not.toContain(equivalentCredential)
  })
})
