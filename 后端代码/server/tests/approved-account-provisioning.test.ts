import bcrypt from 'bcryptjs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseApprovedAccountManifest,
  provisionApprovedAccounts,
} from '../scripts/approved-account-provisioning.js'

const defaultCredentialProbe = vi.hoisted(() => ({
  matches: undefined as undefined | ((passwordHash: string) => boolean),
}))

vi.mock('../src/config/security.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config/security.js')>()
  return {
    ...actual,
    hashMatchesKnownLeakedDefaultPassword: (passwordHash: string): boolean =>
      Boolean(defaultCredentialProbe.matches?.(passwordHash))
      || actual.hashMatchesKnownLeakedDefaultPassword(passwordHash),
  }
})

type ApprovedAccount = {
  username: string
  realName: string
  roles: string[]
  primaryRole: string
  department?: string | null
}

const tempDirs: string[] = []
const scriptArgs = ['--import', 'tsx', 'scripts/reset-passwords.ts'] as const

afterEach(() => {
  defaultCredentialProbe.matches = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function syntheticStrongPassword(label: string): string {
  return ['Spec', label, 'N7v!', 'Q2m@', 'R8x#'].join('-')
}

function createProvisioningDatabase(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      real_name TEXT NOT NULL,
      role TEXT NOT NULL,
      primary_role TEXT,
      department TEXT,
      phone TEXT,
      email TEXT,
      status INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      updated_by TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]',
      status INTEGER NOT NULL DEFAULT 1,
      is_deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_roles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      role_code TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, role_code),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(role_code) REFERENCES roles(code)
    );
    INSERT INTO roles (id, code, name) VALUES
      ('ROLE-ADMIN', 'admin', '管理员'),
      ('ROLE-FIN', 'finance', '财务'),
      ('ROLE-TECH', 'technician', '技术员');
  `)
  db.close()
}

function writeApprovedManifest(dir: string, accounts: ApprovedAccount[]): string {
  const manifestPath = join(dir, 'approved-accounts.json')
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    approvalReference: 'SEC-PROVISION-SYNTHETIC-APPROVAL',
    accounts,
  }), 'utf8')
  return manifestPath
}

function cleanProvisioningEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('RESET_') || key.startsWith('PROVISIONING_')) delete env[key]
  }
  delete env.ADMIN_INITIAL_PASSWORD
  return { ...env, ...overrides }
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function runProvision(input: {
  databasePath: string
  manifestPath: string
  credentials: Record<string, string>
}) {
  return spawnSync(process.execPath, [...scriptArgs], {
    cwd: process.cwd(),
    env: cleanProvisioningEnv({
      DATABASE_PATH: input.databasePath,
      PROVISIONING_MANIFEST_PATH: input.manifestPath,
      PROVISIONING_MANIFEST_SHA256: fileSha256(input.manifestPath),
    }),
    input: JSON.stringify({ schemaVersion: 1, credentials: input.credentials }),
    encoding: 'utf8',
    windowsHide: true,
  })
}

function makeFixture(accounts: ApprovedAccount[]) {
  const dir = mkdtempSync(join(tmpdir(), 'coreone-approved-provisioning-'))
  tempDirs.push(dir)
  const databasePath = join(dir, 'coreone.db')
  createProvisioningDatabase(databasePath)
  return {
    dir,
    databasePath,
    manifestPath: writeApprovedManifest(dir, accounts),
  }
}

function commitWriterBeforeContenderBegins(
  contender: DatabaseSync,
  commitWriter: () => void
): DatabaseSync {
  let committed = false
  return new Proxy(contender, {
    get(target, property) {
      if (property === 'exec') {
        return (sql: string): void => {
          if (!committed && sql.trim() === 'BEGIN IMMEDIATE') {
            committed = true
            commitWriter()
          }
          target.exec(sql)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as DatabaseSync
}

function insertSyntheticProvisionedAccount(
  database: DatabaseSync,
  account: ApprovedAccount,
  credential: string
): string {
  const passwordHash = bcrypt.hashSync(credential, 12)
  database.prepare(`
    INSERT INTO users (
      id, username, password, real_name, role, primary_role, department,
      status, is_deleted, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'synthetic-writer', 'synthetic-writer')
  `).run(
    'USER-CONCURRENT-WRITER',
    account.username,
    passwordHash,
    account.realName,
    account.primaryRole,
    account.primaryRole,
    account.department ?? null
  )
  const insertRole = database.prepare(
    'INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)'
  )
  for (const role of [...account.roles].sort()) {
    insertRole.run(`UR-CONCURRENT-${role}`, 'USER-CONCURRENT-WRITER', role)
  }
  return passwordHash
}

describe('customer-approved account provisioning', () => {
  it('applies an arbitrary approved manifest atomically and records only per-account status', () => {
    const accounts: ApprovedAccount[] = [
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
      {
        username: 'ops-b',
        realName: '客户运营',
        roles: ['finance', 'technician'],
        primaryRole: 'finance',
        department: '运营',
      },
    ]
    const fixture = makeFixture(accounts)
    const credentials = {
      'owner-a': syntheticStrongPassword('Alpha'),
      'ops-b': syntheticStrongPassword('Bravo'),
    }

    const result = runProvision({ ...fixture, credentials })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`manifest-sha256=${fileSha256(fixture.manifestPath)}`)
    for (const [username, password] of Object.entries(credentials)) {
      expect(result.stdout).toContain(`account=${username}`)
      expect(result.stdout).toContain('credential=ready')
      expect(result.stdout).toContain('default-credential=denied')
      expect(result.stdout).not.toContain(password)
      expect(result.stderr).not.toContain(password)
      expect(readFileSync(fixture.manifestPath, 'utf8')).not.toContain(password)
      expect(scriptArgs.join(' ')).not.toContain(password)
    }

    const db = new DatabaseSync(fixture.databasePath)
    const users = db.prepare(
      'SELECT id, username, password, real_name, role, primary_role, department FROM users ORDER BY username'
    ).all() as Array<{
      id: string
      username: string
      password: string
      real_name: string
      role: string
      primary_role: string
      department: string | null
    }>
    const roleRows = db.prepare(
      'SELECT u.username, ur.role_code FROM user_roles ur JOIN users u ON u.id = ur.user_id ORDER BY u.username, ur.role_code'
    ).all()
    db.close()

    expect(users.map(user => ({
      username: user.username,
      realName: user.real_name,
      role: user.role,
      primaryRole: user.primary_role,
      department: user.department,
      passwordMatches: bcrypt.compareSync(credentials[user.username as keyof typeof credentials], user.password),
    }))).toEqual([
      {
        username: 'ops-b',
        realName: '客户运营',
        role: 'finance',
        primaryRole: 'finance',
        department: '运营',
        passwordMatches: true,
      },
      {
        username: 'owner-a',
        realName: '客户管理员',
        role: 'admin',
        primaryRole: 'admin',
        department: null,
        passwordMatches: true,
      },
    ])
    expect(roleRows).toEqual([
      { username: 'ops-b', role_code: 'finance' },
      { username: 'ops-b', role_code: 'technician' },
      { username: 'owner-a', role_code: 'admin' },
    ])
  }, 60_000)

  it('rolls back earlier account writes when a later database operation fails', () => {
    const accounts: ApprovedAccount[] = [
      { username: 'owner-a', realName: '批准后的姓名', roles: ['admin'], primaryRole: 'admin' },
      { username: 'blocked-b', realName: '触发故障', roles: ['finance'], primaryRole: 'finance' },
    ]
    const fixture = makeFixture(accounts)
    const originalPassword = syntheticStrongPassword('Original')
    const db = new DatabaseSync(fixture.databasePath)
    db.prepare(
      'INSERT INTO users (id, username, password, real_name, role, primary_role) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('USER-EXISTING', 'owner-a', bcrypt.hashSync(originalPassword, 4), '原姓名', 'admin', 'admin')
    db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run('UR-EXISTING-admin', 'USER-EXISTING', 'admin')
    db.exec(`
      CREATE TRIGGER reject_blocked_account
      BEFORE INSERT ON users
      WHEN NEW.username = 'blocked-b'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic provisioning failure');
      END;
    `)
    db.close()

    const credentials = {
      'owner-a': syntheticStrongPassword('Updated'),
      'blocked-b': syntheticStrongPassword('Blocked'),
    }
    const result = runProvision({ ...fixture, credentials })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('PROVISIONING_TRANSACTION_FAILED')
    for (const password of Object.values(credentials)) {
      expect(result.stdout).not.toContain(password)
      expect(result.stderr).not.toContain(password)
    }

    const check = new DatabaseSync(fixture.databasePath)
    const owner = check.prepare(
      "SELECT password, real_name FROM users WHERE username = 'owner-a'"
    ).get() as { password: string; real_name: string }
    const blocked = check.prepare("SELECT id FROM users WHERE username = 'blocked-b'").get()
    check.close()
    expect(owner.real_name).toBe('原姓名')
    expect(bcrypt.compareSync(originalPassword, owner.password)).toBe(true)
    expect(blocked).toBeUndefined()
  }, 60_000)

  it('is write-idempotent when the same approved manifest and credentials are applied again', () => {
    const accounts: ApprovedAccount[] = [
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ]
    const fixture = makeFixture(accounts)
    const credentials = { 'owner-a': syntheticStrongPassword('Stable') }
    const first = runProvision({ ...fixture, credentials })
    expect(first.status).toBe(0)

    const db = new DatabaseSync(fixture.databasePath)
    const firstHash = (db.prepare("SELECT password FROM users WHERE username = 'owner-a'").get() as { password: string }).password
    db.exec(`
      CREATE TABLE mutation_log (operation TEXT NOT NULL);
      CREATE TRIGGER log_user_insert AFTER INSERT ON users BEGIN INSERT INTO mutation_log VALUES ('user-insert'); END;
      CREATE TRIGGER log_user_update AFTER UPDATE ON users BEGIN INSERT INTO mutation_log VALUES ('user-update'); END;
      CREATE TRIGGER log_user_delete AFTER DELETE ON users BEGIN INSERT INTO mutation_log VALUES ('user-delete'); END;
      CREATE TRIGGER log_role_insert AFTER INSERT ON user_roles BEGIN INSERT INTO mutation_log VALUES ('role-insert'); END;
      CREATE TRIGGER log_role_update AFTER UPDATE ON user_roles BEGIN INSERT INTO mutation_log VALUES ('role-update'); END;
      CREATE TRIGGER log_role_delete AFTER DELETE ON user_roles BEGIN INSERT INTO mutation_log VALUES ('role-delete'); END;
    `)
    db.close()

    const second = runProvision({ ...fixture, credentials })
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('account=owner-a apply=unchanged')

    const check = new DatabaseSync(fixture.databasePath)
    const secondHash = (check.prepare("SELECT password FROM users WHERE username = 'owner-a'").get() as { password: string }).password
    const mutationCount = (check.prepare('SELECT COUNT(*) AS count FROM mutation_log').get() as { count: number }).count
    check.close()
    expect(secondHash).toBe(firstHash)
    expect(mutationCount).toBe(0)
  }, 60_000)

  it('reports a stable zero-write conflict when another provisioning writer holds the database lock', () => {
    const fixture = makeFixture([
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ])
    const credential = syntheticStrongPassword('ConcurrentWriter')
    const manifest = parseApprovedAccountManifest(readFileSync(fixture.manifestPath, 'utf8'))
    const blocker = new DatabaseSync(fixture.databasePath)
    const contender = new DatabaseSync(fixture.databasePath)
    blocker.exec('BEGIN IMMEDIATE')
    contender.exec('PRAGMA busy_timeout = 25')

    try {
      let conflict: unknown
      try {
        provisionApprovedAccounts(contender, manifest, { 'owner-a': credential })
      } catch (error) {
        conflict = error
      }
      expect(conflict).toMatchObject({ code: 'PROVISIONING_CONFLICT' })
      expect((conflict as Error).message).toBe('PROVISIONING_CONFLICT')
      expect((conflict as Error).message).not.toContain(credential)
      expect(contender.isTransaction).toBe(false)
      expect((blocker.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count)
        .toBe(0)
    } finally {
      contender.close()
      blocker.exec('ROLLBACK')
      blocker.close()
    }

    const retry = new DatabaseSync(fixture.databasePath)
    try {
      expect(provisionApprovedAccounts(retry, manifest, { 'owner-a': credential }))
        .toEqual([expect.objectContaining({ username: 'owner-a', apply: 'created' })])
      expect((retry.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count)
        .toBe(1)
    } finally {
      retry.close()
    }
  }, 60_000)

  it('sanitizes a CLI writer-lock conflict and succeeds only after an explicit retry', () => {
    const fixture = makeFixture([
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ])
    const credential = syntheticStrongPassword('CliWriterLock')
    const blocker = new DatabaseSync(fixture.databasePath)
    blocker.exec('BEGIN IMMEDIATE')
    let conflict
    try {
      conflict = runProvision({ ...fixture, credentials: { 'owner-a': credential } })
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }

    expect(conflict.status).toBe(1)
    expect(conflict.stdout).toBe('')
    expect(conflict.stderr).toContain('provisioning=failed code=PROVISIONING_CONFLICT')
    expect(conflict.stderr).not.toContain('database is locked')
    expect(conflict.stderr).not.toContain(fixture.databasePath)
    expect(conflict.stderr).not.toContain(credential)

    const retry = runProvision({ ...fixture, credentials: { 'owner-a': credential } })
    expect(retry.status).toBe(0)
    expect(retry.stdout).toContain('account=owner-a apply=created')
    expect(retry.stdout).not.toContain(credential)
    expect(retry.stderr).not.toContain(credential)
  }, 60_000)

  it('does not misclassify a non-lock transaction error as a writer-lock conflict', () => {
    const fixture = makeFixture([
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ])
    const manifest = parseApprovedAccountManifest(readFileSync(fixture.manifestPath, 'utf8'))
    const database = new DatabaseSync(fixture.databasePath)
    database.exec('BEGIN')
    try {
      expect(() => provisionApprovedAccounts(database, manifest, {
        'owner-a': syntheticStrongPassword('NestedTransaction'),
      })).toThrow(expect.objectContaining({ code: 'PROVISIONING_TRANSACTION_FAILED' }))
    } finally {
      database.exec('ROLLBACK')
      database.close()
    }
  })

  it('keeps the first committed state when concurrent credentials conflict', () => {
    const account: ApprovedAccount = {
      username: 'owner-a',
      realName: '客户管理员',
      roles: ['admin'],
      primaryRole: 'admin',
    }
    const fixture = makeFixture([account])
    const manifest = parseApprovedAccountManifest(readFileSync(fixture.manifestPath, 'utf8'))
    const firstCredential = syntheticStrongPassword('FirstWriter')
    const conflictingCredential = syntheticStrongPassword('ConflictingWriter')
    const writer = new DatabaseSync(fixture.databasePath)
    const contenderConnection = new DatabaseSync(fixture.databasePath)
    writer.exec('BEGIN IMMEDIATE')
    const firstHash = insertSyntheticProvisionedAccount(writer, account, firstCredential)
    const contender = commitWriterBeforeContenderBegins(contenderConnection, () => {
      writer.exec('COMMIT')
    })

    try {
      let conflict: unknown
      try {
        provisionApprovedAccounts(contender, manifest, { 'owner-a': conflictingCredential })
      } catch (error) {
        conflict = error
      }
      expect(conflict).toMatchObject({ code: 'PROVISIONING_CONCURRENT_STATE_CONFLICT' })
      expect((conflict as Error).message).toBe('PROVISIONING_CONCURRENT_STATE_CONFLICT')
      expect((conflict as Error).message).not.toContain(firstCredential)
      expect((conflict as Error).message).not.toContain(conflictingCredential)
      expect(contenderConnection.isTransaction).toBe(false)
      expect((contenderConnection.prepare('SELECT total_changes() AS count').get() as { count: number }).count)
        .toBe(0)
      const stored = contenderConnection.prepare(
        "SELECT password FROM users WHERE username = 'owner-a'"
      ).get() as { password: string }
      expect(stored.password).toBe(firstHash)
      expect(bcrypt.compareSync(firstCredential, stored.password)).toBe(true)
      expect(bcrypt.compareSync(conflictingCredential, stored.password)).toBe(false)
    } finally {
      contenderConnection.close()
      writer.close()
    }
  }, 60_000)

  it('preserves the first commit when a concurrent manifest targets different account metadata', () => {
    const approvedAccount: ApprovedAccount = {
      username: 'owner-a',
      realName: '客户批准姓名',
      roles: ['admin'],
      primaryRole: 'admin',
    }
    const concurrentAccount: ApprovedAccount = {
      ...approvedAccount,
      realName: '先提交姓名',
    }
    const fixture = makeFixture([approvedAccount])
    const manifest = parseApprovedAccountManifest(readFileSync(fixture.manifestPath, 'utf8'))
    const credential = syntheticStrongPassword('ManifestConflict')
    const writer = new DatabaseSync(fixture.databasePath)
    const contenderConnection = new DatabaseSync(fixture.databasePath)
    writer.exec('BEGIN IMMEDIATE')
    insertSyntheticProvisionedAccount(writer, concurrentAccount, credential)
    const contender = commitWriterBeforeContenderBegins(contenderConnection, () => {
      writer.exec('COMMIT')
    })

    try {
      expect(() => provisionApprovedAccounts(contender, manifest, { 'owner-a': credential }))
        .toThrow(expect.objectContaining({ code: 'PROVISIONING_CONCURRENT_STATE_CONFLICT' }))
      const stored = contenderConnection.prepare(
        "SELECT real_name FROM users WHERE username = 'owner-a'"
      ).get() as { real_name: string }
      expect(stored.real_name).toBe(concurrentAccount.realName)
      expect(contenderConnection.isTransaction).toBe(false)
    } finally {
      contenderConnection.close()
      writer.close()
    }
  }, 60_000)

  it('treats an identical concurrent commit as an unchanged idempotent result', () => {
    const account: ApprovedAccount = {
      username: 'owner-a',
      realName: '客户管理员',
      roles: ['admin'],
      primaryRole: 'admin',
    }
    const fixture = makeFixture([account])
    const manifest = parseApprovedAccountManifest(readFileSync(fixture.manifestPath, 'utf8'))
    const credential = syntheticStrongPassword('SameConcurrentTarget')
    const writer = new DatabaseSync(fixture.databasePath)
    const contenderConnection = new DatabaseSync(fixture.databasePath)
    writer.exec('BEGIN IMMEDIATE')
    const firstHash = insertSyntheticProvisionedAccount(writer, account, credential)
    const contender = commitWriterBeforeContenderBegins(contenderConnection, () => {
      writer.exec('COMMIT')
    })

    try {
      expect(provisionApprovedAccounts(contender, manifest, { 'owner-a': credential }))
        .toEqual([expect.objectContaining({ username: 'owner-a', apply: 'unchanged' })])
      const stored = contenderConnection.prepare(
        "SELECT password FROM users WHERE username = 'owner-a'"
      ).get() as { password: string }
      expect(stored.password).toBe(firstHash)
    } finally {
      contenderConnection.close()
      writer.close()
    }
  }, 60_000)

  it('repairs a legacy null primary_role once and is unchanged on the next run', () => {
    const accounts: ApprovedAccount[] = [
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ]
    const fixture = makeFixture(accounts)
    const credential = syntheticStrongPassword('LegacyPrimaryRole')
    const db = new DatabaseSync(fixture.databasePath)
    db.prepare(
      'INSERT INTO users (id, username, password, real_name, role, primary_role) VALUES (?, ?, ?, ?, ?, NULL)'
    ).run('USER-LEGACY', 'owner-a', bcrypt.hashSync(credential, 4), '客户管理员', 'admin')
    db.prepare('INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)')
      .run('UR-LEGACY-admin', 'USER-LEGACY', 'admin')
    db.close()

    const first = runProvision({ ...fixture, credentials: { 'owner-a': credential } })
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('account=owner-a apply=updated')

    const check = new DatabaseSync(fixture.databasePath)
    const repaired = check.prepare(
      "SELECT primary_role, password FROM users WHERE username = 'owner-a'"
    ).get() as { primary_role: string; password: string }
    expect(repaired.primary_role).toBe('admin')
    expect(bcrypt.getRounds(repaired.password)).toBe(12)
    check.close()

    const second = runProvision({ ...fixture, credentials: { 'owner-a': credential } })
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('account=owner-a apply=unchanged')
  }, 60_000)

  it('rejects a lookalike database that lacks canonical identity constraints', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coreone-approved-schema-'))
    tempDirs.push(dir)
    const databasePath = join(dir, 'unconstrained.db')
    const db = new DatabaseSync(databasePath)
    db.exec(`
      CREATE TABLE users (
        id TEXT, username TEXT, password TEXT, real_name TEXT, role TEXT,
        primary_role TEXT, department TEXT, status INTEGER, is_deleted INTEGER,
        updated_at DATETIME, created_by TEXT, updated_by TEXT
      );
      CREATE TABLE roles (id TEXT, code TEXT, status INTEGER, is_deleted INTEGER);
      CREATE TABLE user_roles (id TEXT, user_id TEXT, role_code TEXT);
      INSERT INTO roles VALUES ('ROLE-ADMIN', 'admin', 1, 0);
    `)
    db.close()
    const manifestPath = writeApprovedManifest(dir, [
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ])
    const credential = syntheticStrongPassword('SchemaGuard')

    const result = runProvision({
      databasePath,
      manifestPath,
      credentials: { 'owner-a': credential },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('DATABASE_SCHEMA_UNSUPPORTED')
    expect(result.stdout).not.toContain(credential)
    expect(result.stderr).not.toContain(credential)
    const check = new DatabaseSync(databasePath)
    expect((check.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(0)
    check.close()
  })

  it('rolls back when a database trigger corrupts the final approved account state', () => {
    const fixture = makeFixture([
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ])
    const db = new DatabaseSync(fixture.databasePath)
    db.exec(`
      CREATE TRIGGER disable_provisioned_account
      AFTER INSERT ON users
      BEGIN
        UPDATE users SET status = 0 WHERE id = NEW.id;
      END;
    `)
    db.close()
    const credential = syntheticStrongPassword('PostWriteState')

    const result = runProvision({ ...fixture, credentials: { 'owner-a': credential } })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('ACCOUNT_STATE_VERIFICATION_FAILED')
    expect(result.stdout).not.toContain(credential)
    expect(result.stderr).not.toContain(credential)
    const check = new DatabaseSync(fixture.databasePath)
    expect((check.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(0)
    check.close()
  }, 60_000)

  it('rolls back instead of claiming denial when post-write default-credential verification fails', () => {
    const fixture = makeFixture([
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ])
    const manifest = parseApprovedAccountManifest(readFileSync(fixture.manifestPath, 'utf8'))
    const database = new DatabaseSync(fixture.databasePath)
    defaultCredentialProbe.matches = passwordHash => passwordHash.startsWith('$2')

    try {
      expect(() => provisionApprovedAccounts(database, manifest, {
        'owner-a': syntheticStrongPassword('DefaultDenialProbe'),
      })).toThrow(expect.objectContaining({ code: 'DEFAULT_CREDENTIAL_STILL_ACTIVE' }))
      expect((database.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count)
        .toBe(0)
    } finally {
      database.close()
    }
  }, 60_000)

  it('rejects credential-like fields in the non-secret approved manifest', () => {
    const accounts = [{
      username: 'owner-a',
      realName: '客户管理员',
      roles: ['admin'],
      primaryRole: 'admin',
      password: syntheticStrongPassword('MustNotEnterManifest'),
    }] as unknown as ApprovedAccount[]
    const fixture = makeFixture(accounts)
    const credential = syntheticStrongPassword('TransportOnly')

    const result = runProvision({ ...fixture, credentials: { 'owner-a': credential } })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('MANIFEST_FORBIDDEN_FIELD')
    expect(result.stdout).not.toContain(credential)
    expect(result.stderr).not.toContain(credential)
    const db = new DatabaseSync(fixture.databasePath)
    expect((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(0)
    db.close()
  })

  it('rejects credentials for accounts absent from the approved manifest', () => {
    const fixture = makeFixture([
      { username: 'owner-a', realName: '客户管理员', roles: ['admin'], primaryRole: 'admin' },
    ])
    const credentials = {
      'owner-a': syntheticStrongPassword('Approved'),
      'not-approved': syntheticStrongPassword('Unapproved'),
    }

    const result = runProvision({ ...fixture, credentials })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('UNAPPROVED_CREDENTIAL')
    for (const password of Object.values(credentials)) {
      expect(result.stdout).not.toContain(password)
      expect(result.stderr).not.toContain(password)
    }
    const db = new DatabaseSync(fixture.databasePath)
    expect((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count).toBe(0)
    db.close()
  })
})
