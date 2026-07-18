import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  accountPasswordProblem,
  hashMatchesKnownLeakedDefaultPassword,
} from '../src/config/security.js'

const MAX_APPROVED_ACCOUNTS = 100
const MAX_APPROVAL_REFERENCE_LENGTH = 200
const MAX_USERNAME_LENGTH = 50
const MAX_REAL_NAME_LENGTH = 50
const MAX_DEPARTMENT_LENGTH = 100
const MAX_ROLES_PER_ACCOUNT = 10
const BCRYPT_COST = 12
const ROLE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u
const FORBIDDEN_MANIFEST_KEY = /(password|credential|secret|token|hash)/iu

const MANIFEST_KEYS = new Set(['schemaVersion', 'approvalReference', 'accounts'])
const ACCOUNT_KEYS = new Set(['username', 'realName', 'roles', 'primaryRole', 'department'])
const CREDENTIAL_ENVELOPE_KEYS = new Set(['schemaVersion', 'credentials'])

export type ApprovedAccount = {
  username: string
  realName: string
  roles: string[]
  primaryRole: string
  department: string | null
}

export type ApprovedAccountManifest = {
  schemaVersion: 1
  approvalReference: string
  accounts: ApprovedAccount[]
}

export type AccountApplyStatus = 'created' | 'updated' | 'unchanged'

export type ProvisioningStatus = {
  username: string
  apply: AccountApplyStatus
  credential: 'ready'
  defaultCredential: 'denied'
}

type ExistingUser = {
  id: string
  password: string
  real_name: string
  role: string
  primary_role: string | null
  department: string | null
  status: number
  is_deleted: number
}

export class ProvisioningError extends Error {
  readonly code: string

  constructor(code: string, safeDetail?: string) {
    super(safeDetail ? `${code}:${safeDetail}` : code)
    this.name = 'ProvisioningError'
    this.code = code
  }
}

function fail(code: string, safeDetail?: string): never {
  throw new ProvisioningError(code, safeDetail)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(text: string, code: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    fail(code)
  }
  if (!isRecord(parsed)) fail(code)
  return parsed
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  unknownCode: string
): void {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_MANIFEST_KEY.test(key)) fail('MANIFEST_FORBIDDEN_FIELD')
    if (!allowed.has(key)) fail(unknownCode, key)
  }
}

function requireNormalizedText(
  value: unknown,
  code: string,
  maxLength: number
): string {
  if (typeof value !== 'string') fail(code)
  const normalized = value.normalize('NFKC')
  if (normalized !== value || value.trim() !== value || value.length === 0) fail(code)
  if (Array.from(value).length > maxLength || /[\p{Cc}\p{Cf}]/u.test(value)) fail(code)
  return value
}

function parseRoleCodes(value: unknown, username: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROLES_PER_ACCOUNT) {
    fail('INVALID_ACCOUNT_ROLES', username)
  }
  const roles = value.map(role => requireNormalizedText(role, 'INVALID_ROLE_CODE', 64))
  if (roles.some(role => !ROLE_CODE_PATTERN.test(role))) fail('INVALID_ROLE_CODE', username)
  if (new Set(roles).size !== roles.length) fail('DUPLICATE_ACCOUNT_ROLE', username)
  return [...roles].sort()
}

function parseDepartment(value: unknown, username: string): string | null {
  if (value === undefined || value === null) return null
  try {
    return requireNormalizedText(value, 'INVALID_ACCOUNT_DEPARTMENT', MAX_DEPARTMENT_LENGTH)
  } catch (error) {
    if (error instanceof ProvisioningError) fail(error.code, username)
    throw error
  }
}

function parseAccount(value: unknown): ApprovedAccount {
  if (!isRecord(value)) fail('INVALID_ACCOUNT_ENTRY')
  assertAllowedKeys(value, ACCOUNT_KEYS, 'UNKNOWN_ACCOUNT_FIELD')
  const username = requireNormalizedText(value.username, 'INVALID_USERNAME', MAX_USERNAME_LENGTH)
  if (/\s/u.test(username)) fail('INVALID_USERNAME', username)
  const realName = requireNormalizedText(value.realName, 'INVALID_REAL_NAME', MAX_REAL_NAME_LENGTH)
  const roles = parseRoleCodes(value.roles, username)
  const primaryRole = requireNormalizedText(value.primaryRole, 'INVALID_PRIMARY_ROLE', 64)
  if (!roles.includes(primaryRole)) fail('PRIMARY_ROLE_NOT_APPROVED', username)
  return { username, realName, roles, primaryRole, department: parseDepartment(value.department, username) }
}

function assertUniqueUsernames(accounts: readonly ApprovedAccount[]): void {
  const seen = new Map<string, string>()
  for (const account of accounts) {
    const key = account.username.toLocaleLowerCase('en-US')
    const existing = seen.get(key)
    if (existing) fail('DUPLICATE_APPROVED_USERNAME', `${existing},${account.username}`)
    seen.set(key, account.username)
  }
}

export function parseApprovedAccountManifest(text: string): ApprovedAccountManifest {
  const parsed = parseJsonObject(text, 'INVALID_MANIFEST_JSON')
  assertAllowedKeys(parsed, MANIFEST_KEYS, 'UNKNOWN_MANIFEST_FIELD')
  if (parsed.schemaVersion !== 1) fail('UNSUPPORTED_MANIFEST_VERSION')
  const approvalReference = requireNormalizedText(
    parsed.approvalReference,
    'INVALID_APPROVAL_REFERENCE',
    MAX_APPROVAL_REFERENCE_LENGTH
  )
  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) fail('EMPTY_APPROVED_MANIFEST')
  if (parsed.accounts.length > MAX_APPROVED_ACCOUNTS) fail('APPROVED_MANIFEST_TOO_LARGE')
  const accounts = parsed.accounts.map(parseAccount)
  assertUniqueUsernames(accounts)
  return { schemaVersion: 1, approvalReference, accounts }
}

function assertCredentialEnvelopeKeys(parsed: Record<string, unknown>): void {
  for (const key of Object.keys(parsed)) {
    if (!CREDENTIAL_ENVELOPE_KEYS.has(key)) fail('UNKNOWN_CREDENTIAL_ENVELOPE_FIELD', key)
  }
}

function validateCredentials(
  raw: Record<string, unknown>,
  manifest: ApprovedAccountManifest
): Record<string, string> {
  const approved = new Set(manifest.accounts.map(account => account.username))
  for (const username of Object.keys(raw)) {
    if (!approved.has(username)) fail('UNAPPROVED_CREDENTIAL', username)
  }
  const credentials: Record<string, string> = Object.create(null)
  const ownersByCanonicalCredential = new Map<string, string>()
  for (const account of manifest.accounts) {
    const credential = raw[account.username]
    if (typeof credential !== 'string') fail('MISSING_CREDENTIAL', account.username)
    const problem = accountPasswordProblem(credential)
    if (problem) fail('CREDENTIAL_POLICY_REJECTED', account.username)
    const canonical = credential.normalize('NFKC')
    const existingOwner = ownersByCanonicalCredential.get(canonical)
    if (existingOwner) fail('CREDENTIAL_REUSE_REJECTED', `${existingOwner},${account.username}`)
    ownersByCanonicalCredential.set(canonical, account.username)
    credentials[account.username] = credential
  }
  return credentials
}

export function parseCredentialEnvelope(
  text: string,
  manifest: ApprovedAccountManifest
): Record<string, string> {
  const parsed = parseJsonObject(text, 'INVALID_CREDENTIAL_ENVELOPE')
  assertCredentialEnvelopeKeys(parsed)
  if (parsed.schemaVersion !== 1 || !isRecord(parsed.credentials)) {
    fail('INVALID_CREDENTIAL_ENVELOPE')
  }
  return validateCredentials(parsed.credentials, manifest)
}

type TableColumn = { name: string; notnull: number; pk: number }
type IndexListRow = { name: string; is_unique: number; partial: number }

function tableInfo(database: DatabaseSync, table: string): TableColumn[] {
  const exists = database
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { ok?: number } | undefined
  if (!exists?.ok) fail('DATABASE_SCHEMA_UNSUPPORTED', table)
  return database.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[]
}

function assertRequiredColumns(
  tableInfoRows: readonly TableColumn[],
  required: readonly string[],
  table: string
): void {
  const columns = new Set(tableInfoRows.map(row => row.name))
  const missing = required.filter(column => !columns.has(column))
  if (missing.length > 0) fail('DATABASE_SCHEMA_UNSUPPORTED', `${table}.${missing.join(',')}`)
}

function assertPrimaryKey(
  tableInfoRows: readonly TableColumn[],
  expectedColumns: readonly string[],
  table: string
): void {
  const actual = tableInfoRows
    .filter(row => row.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(row => row.name)
  if (!sameStringArray(actual, expectedColumns)) fail('DATABASE_SCHEMA_UNSUPPORTED', `${table}.pk`)
}

function uniqueIndexes(database: DatabaseSync, table: string): string[][] {
  const indexes = database.prepare(`
    SELECT name, "unique" AS is_unique, partial
    FROM pragma_index_list(?)
  `).all(table) as IndexListRow[]
  return indexes
    .filter(index => index.is_unique === 1 && index.partial === 0)
    .map(index => (
      database.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
        .all(index.name) as Array<{ name: string }>
    ).map(column => column.name))
}

function assertUniqueIndex(
  database: DatabaseSync,
  table: string,
  expectedColumns: readonly string[]
): void {
  const exists = uniqueIndexes(database, table)
    .some(columns => sameStringArray(columns, expectedColumns))
  if (!exists) fail('DATABASE_SCHEMA_UNSUPPORTED', `${table}.unique`)
}

function assertIdentityData(database: DatabaseSync): void {
  const invalid = database.prepare(`
    SELECT 1 AS invalid FROM (
      SELECT id AS identity FROM users UNION ALL
      SELECT username FROM users UNION ALL
      SELECT id FROM roles UNION ALL
      SELECT code FROM roles UNION ALL
      SELECT id FROM user_roles UNION ALL
      SELECT user_id FROM user_roles UNION ALL
      SELECT role_code FROM user_roles
    ) WHERE identity IS NULL LIMIT 1
  `).get() as { invalid?: number } | undefined
  if (invalid?.invalid) fail('DATABASE_SCHEMA_UNSUPPORTED', 'identity.null')
}

export function assertProvisioningDatabase(database: DatabaseSync): void {
  const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
  if (quickCheck?.quick_check !== 'ok') fail('DATABASE_INTEGRITY_FAILED')
  const users = tableInfo(database, 'users')
  const roles = tableInfo(database, 'roles')
  const userRoles = tableInfo(database, 'user_roles')
  assertRequiredColumns(users, [
    'id', 'username', 'password', 'real_name', 'role', 'primary_role', 'department',
    'status', 'is_deleted', 'updated_at',
  ], 'users')
  assertRequiredColumns(roles, ['id', 'code', 'status', 'is_deleted'], 'roles')
  assertRequiredColumns(userRoles, ['id', 'user_id', 'role_code'], 'user_roles')
  assertPrimaryKey(users, ['id'], 'users')
  assertPrimaryKey(roles, ['id'], 'roles')
  assertPrimaryKey(userRoles, ['id'], 'user_roles')
  assertUniqueIndex(database, 'users', ['username'])
  assertUniqueIndex(database, 'roles', ['code'])
  assertUniqueIndex(database, 'user_roles', ['user_id', 'role_code'])
  assertIdentityData(database)
}

function assertApprovedRolesExist(
  database: DatabaseSync,
  manifest: ApprovedAccountManifest
): void {
  const requested = [...new Set(manifest.accounts.flatMap(account => account.roles))].sort()
  const placeholders = requested.map(() => '?').join(', ')
  const rows = database.prepare(
    `SELECT code FROM roles WHERE code IN (${placeholders}) AND status = 1 AND is_deleted = 0`
  ).all(...requested) as Array<{ code: string }>
  const active = new Set(rows.map(row => row.code))
  const missing = requested.filter(role => !active.has(role))
  if (missing.length > 0) fail('APPROVED_ROLE_UNAVAILABLE', missing.join(','))
}

function passwordMatches(credential: string, passwordHash: string): boolean {
  try {
    return bcrypt.compareSync(credential, passwordHash)
  } catch {
    return false
  }
}

function passwordHashMeetsCost(passwordHash: string): boolean {
  try {
    return bcrypt.getRounds(passwordHash) >= BCRYPT_COST
  } catch {
    return false
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function currentRoles(database: DatabaseSync, userId: string): string[] {
  const rows = database.prepare(
    'SELECT role_code FROM user_roles WHERE user_id = ? ORDER BY role_code'
  ).all(userId) as Array<{ role_code: string }>
  return rows.map(row => row.role_code)
}

function synchronizeRoles(
  database: DatabaseSync,
  userId: string,
  desiredRoles: readonly string[]
): boolean {
  if (sameStringArray(currentRoles(database, userId), desiredRoles)) return false
  database.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId)
  const insert = database.prepare(
    'INSERT INTO user_roles (id, user_id, role_code) VALUES (?, ?, ?)'
  )
  for (const role of desiredRoles) insert.run(`UR-${userId}-${role}`, userId, role)
  return true
}

function loadExistingUser(database: DatabaseSync, username: string): ExistingUser | undefined {
  return database.prepare(`
    SELECT id, password, real_name, role, primary_role, department, status, is_deleted
    FROM users WHERE username = ?
  `).get(username) as ExistingUser | undefined
}

function insertApprovedUser(
  database: DatabaseSync,
  account: ApprovedAccount,
  credential: string
): string {
  const id = randomUUID()
  database.prepare(`
    INSERT INTO users (
      id, username, password, real_name, role, primary_role, department,
      status, is_deleted, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 'sec-provision', 'sec-provision')
  `).run(
    id,
    account.username,
    bcrypt.hashSync(credential, BCRYPT_COST),
    account.realName,
    account.primaryRole,
    account.primaryRole,
    account.department
  )
  synchronizeRoles(database, id, account.roles)
  return id
}

function existingUserNeedsUpdate(
  existing: ExistingUser,
  account: ApprovedAccount,
  credentialMatches: boolean,
  rolesMatch: boolean
): boolean {
  return !credentialMatches
    || existing.real_name !== account.realName
    || existing.role !== account.primaryRole
    || existing.primary_role !== account.primaryRole
    || existing.department !== account.department
    || !rolesMatch
}

function approvedAccountAlreadyMatches(
  database: DatabaseSync,
  existing: ExistingUser,
  account: ApprovedAccount,
  credential: string
): boolean {
  if (existing.status !== 1 || existing.is_deleted !== 0) return false
  const credentialMatches = passwordMatches(credential, existing.password)
  const rolesMatch = sameStringArray(currentRoles(database, existing.id), account.roles)
  return passwordHashMeetsCost(existing.password)
    && !existingUserNeedsUpdate(existing, account, credentialMatches, rolesMatch)
}

function updateApprovedUser(
  database: DatabaseSync,
  existing: ExistingUser,
  account: ApprovedAccount,
  credential: string
): AccountApplyStatus {
  if (existing.status !== 1 || existing.is_deleted !== 0) fail('ACCOUNT_NOT_ACTIVE', account.username)
  const credentialMatches = passwordMatches(credential, existing.password)
  const passwordHashCurrent = passwordHashMeetsCost(existing.password)
  const rolesMatch = sameStringArray(currentRoles(database, existing.id), account.roles)
  if (passwordHashCurrent
    && !existingUserNeedsUpdate(existing, account, credentialMatches, rolesMatch)) return 'unchanged'
  const desiredPasswordHash = credentialMatches && passwordHashCurrent
    ? existing.password
    : bcrypt.hashSync(credential, BCRYPT_COST)
  database.prepare(`
    UPDATE users SET
      password = ?, real_name = ?, role = ?, primary_role = ?, department = ?,
      updated_at = CURRENT_TIMESTAMP, updated_by = 'sec-provision'
    WHERE id = ?
  `).run(
    desiredPasswordHash,
    account.realName,
    account.primaryRole,
    account.primaryRole,
    account.department,
    existing.id
  )
  synchronizeRoles(database, existing.id, account.roles)
  return 'updated'
}

function assertStoredAccountState(
  database: DatabaseSync,
  account: ApprovedAccount,
  credential: string,
  userId: string
): void {
  const stored = loadExistingUser(database, account.username)
  const metadataMatches = stored?.id === userId
    && stored.status === 1
    && stored.is_deleted === 0
    && stored.real_name === account.realName
    && stored.role === account.primaryRole
    && stored.primary_role === account.primaryRole
    && stored.department === account.department
  const rolesMatch = stored
    ? sameStringArray(currentRoles(database, stored.id), account.roles)
    : false
  if (!metadataMatches || !rolesMatch) fail('ACCOUNT_STATE_VERIFICATION_FAILED', account.username)
  if (!stored || !passwordMatches(credential, stored.password)) {
    fail('CREDENTIAL_VERIFICATION_FAILED', account.username)
  }
  if (!passwordHashMeetsCost(stored.password)) fail('PASSWORD_HASH_COST_VERIFICATION_FAILED', account.username)
  if (hashMatchesKnownLeakedDefaultPassword(stored.password)) {
    fail('DEFAULT_CREDENTIAL_STILL_ACTIVE', account.username)
  }
}

function applyApprovedAccount(
  database: DatabaseSync,
  account: ApprovedAccount,
  credential: string
): ProvisioningStatus {
  const existing = loadExistingUser(database, account.username)
  let apply: AccountApplyStatus
  let userId: string
  if (existing) {
    apply = updateApprovedUser(database, existing, account, credential)
    userId = existing.id
  } else {
    userId = insertApprovedUser(database, account, credential)
    apply = 'created'
  }
  assertStoredAccountState(database, account, credential, userId)
  return { username: account.username, apply, credential: 'ready', defaultCredential: 'denied' }
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK')
  } catch {
    // The outer error remains authoritative; never append database details that could expose values.
  }
}

function beginImmediate(database: DatabaseSync): void {
  try {
    database.exec('BEGIN IMMEDIATE')
  } catch (error) {
    // A competing writer is an expected, retryable provisioning conflict. Keep
    // the SQLite message out of operator evidence and never roll back a
    // transaction this connection did not start.
    if (isRecord(error) && typeof error.errcode === 'number') {
      const primaryResultCode = error.errcode & 0xff
      if (primaryResultCode === 5 || primaryResultCode === 6) {
        throw new ProvisioningError('PROVISIONING_CONFLICT')
      }
    }
    throw new ProvisioningError('PROVISIONING_TRANSACTION_FAILED')
  }
}

function readDataVersion(database: DatabaseSync): number {
  try {
    const row = database.prepare('PRAGMA data_version').get() as { data_version?: number } | undefined
    if (Number.isSafeInteger(row?.data_version)) return row!.data_version!
  } catch {
    // Fall through to the stable provisioning error below.
  }
  throw new ProvisioningError('PROVISIONING_TRANSACTION_FAILED')
}

function unchangedStatusesForConcurrentCommit(
  database: DatabaseSync,
  manifest: ApprovedAccountManifest,
  credentials: Readonly<Record<string, string>>
): ProvisioningStatus[] | undefined {
  const statuses: ProvisioningStatus[] = []
  for (const account of manifest.accounts) {
    const existing = loadExistingUser(database, account.username)
    const credential = credentials[account.username]
    if (!existing || !approvedAccountAlreadyMatches(database, existing, account, credential)) {
      return undefined
    }
    assertStoredAccountState(database, account, credential, existing.id)
    statuses.push({
      username: account.username,
      apply: 'unchanged',
      credential: 'ready',
      defaultCredential: 'denied',
    })
  }
  return statuses
}

export function provisionApprovedAccounts(
  database: DatabaseSync,
  manifest: ApprovedAccountManifest,
  credentials: Readonly<Record<string, string>>
): ProvisioningStatus[] {
  database.exec('PRAGMA foreign_keys = ON')
  const observedDataVersion = readDataVersion(database)
  assertProvisioningDatabase(database)
  beginImmediate(database)
  try {
    assertApprovedRolesExist(database, manifest)
    if (readDataVersion(database) !== observedDataVersion) {
      assertProvisioningDatabase(database)
      const unchanged = unchangedStatusesForConcurrentCommit(database, manifest, credentials)
      if (!unchanged) throw new ProvisioningError('PROVISIONING_CONCURRENT_STATE_CONFLICT')
      database.exec('COMMIT')
      return unchanged
    }
    const statuses = manifest.accounts.map(account =>
      applyApprovedAccount(database, account, credentials[account.username])
    )
    database.exec('COMMIT')
    return statuses
  } catch (error) {
    rollbackQuietly(database)
    if (error instanceof ProvisioningError) throw error
    throw new ProvisioningError('PROVISIONING_TRANSACTION_FAILED')
  }
}
