import { createHash, randomUUID } from 'node:crypto'

/**
 * #182 hospital directory control plane.
 *
 * This is membership configuration only. It does not prove amount evidence,
 * readiness, finality, C1 scope publication, or D1-1 historical backfill.
 */
export const HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION = 'hospital-cm.directory.v1'
export const HOSPITAL_CM_DIRECTORY_ROSTER_RECIPE_VERSION =
  'hospital-cm.directory.membership-projection.v1'
export const HOSPITAL_CM_DIRECTORY_LINEAGE_RECIPE_VERSION =
  'hospital-cm.directory.revision-lineage.v1'

const SERVICE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const REASON_CODE_RE = /^[A-Z0-9][A-Z0-9._:-]{0,127}$/
const STABLE_PARTNER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_ENTRIES = 5_000
const MAX_ALIASES_PER_ENTRY = 100

interface StatementLike {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => unknown
}

export interface HospitalCmDirectoryDb {
  prepare: (sql: string) => StatementLike
  exec: (sql: string) => unknown
}

export interface HospitalCmDirectoryActor {
  userId: string
  username: string
}

export interface HospitalCmDirectoryEntryInput {
  stablePartnerId: string
  accountCode: string
  canonicalDisplayName: string
  aliases: string[]
  hospitalCmIncluded: boolean
  effectiveFromMonth: string | null
  effectiveToMonth: string | null
}

export interface SaveHospitalCmDirectoryRevisionInput {
  entries: HospitalCmDirectoryEntryInput[]
  knownCompleteFromMonth: string
  actor: HospitalCmDirectoryActor
  reasonCode: string
  idempotencyKey: string
}

export interface HospitalCmDirectoryEntry extends HospitalCmDirectoryEntryInput {
  rowHash: string
}

export interface HospitalCmDirectoryRevisionMetadata {
  id: string
  eventNumber: number
  revision: number
  contractVersion: typeof HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION
  knownCompleteFromMonth: string
  entryCount: number
  aliasCount: number
  contentHash: string
  revisionLineageHash: string
  supersedesVersionId: string | null
  reasonCode: string
  recordedByUserId: string
  recordedByUsername: string
  recordedAt: string
}

export interface HospitalCmDirectoryRevision extends HospitalCmDirectoryRevisionMetadata {
  entries: HospitalCmDirectoryEntry[]
}

export interface HospitalCmDirectoryRevisionPage {
  current: HospitalCmDirectoryRevisionMetadata | null
  versions: HospitalCmDirectoryRevisionMetadata[]
  pagination: { limit: number; nextCursor: number | null }
}

export interface HospitalCmDirectoryMonthProjection {
  serviceMonth: string
  directoryVersionId: string
  directoryRevision: number
  knownCompleteFromMonth: string
  recipeVersion: typeof HOSPITAL_CM_DIRECTORY_ROSTER_RECIPE_VERSION
  accounts: string[]
  rosterSourceHash: string
}

export interface HospitalCmDirectoryResolution {
  stablePartnerId: string
  matchedBy: 'STABLE_PARTNER_ID' | 'ACCOUNT_CODE' | 'ALIAS'
  directoryVersionId: string
  directoryRevision: number
}

interface NormalizedDirectoryEntry extends HospitalCmDirectoryEntry {
  accountCodeKey: string
  aliasRecords: Array<{ alias: string; aliasKey: string }>
}

interface NormalizedDirectoryInput {
  entries: NormalizedDirectoryEntry[]
  knownCompleteFromMonth: string
  actor: HospitalCmDirectoryActor
  reasonCode: string
  idempotencyKey: string
  contentHash: string
  requestHash: string
}

interface VersionRow {
  id: string
  eventNumber: number
  revision: number
  contractVersion: string
  knownCompleteFromMonth: string
  entryCount: number
  aliasCount: number
  contentHash: string
  revisionLineageHash: string
  supersedesVersionId: string | null
  reasonCode: string
  recordedByUserId: string
  recordedByUsername: string
  recordedAt: string
  rowKind?: 'CURRENT' | 'PAGE'
}

interface EntryRow {
  stablePartnerId: string
  accountCode: string
  accountCodeKey: string
  canonicalDisplayName: string
  hospitalCmIncluded: number
  effectiveFromMonth: string | null
  effectiveToMonth: string | null
  rowHash: string
}

interface AliasRow {
  stablePartnerId: string
  alias: string
  aliasKey: string
}

interface LineageBundleRow {
  rowKind: 'VERSION' | 'ENTRY' | 'ALIAS'
  versionId: string
  eventNumber: number | null
  revision: number | null
  contractVersion: string | null
  knownCompleteFromMonth: string | null
  entryCount: number | null
  aliasCount: number | null
  contentHash: string | null
  revisionLineageHash: string | null
  supersedesVersionId: string | null
  reasonCode: string | null
  recordedByUserId: string | null
  recordedByUsername: string | null
  recordedAt: string | null
  stablePartnerId: string | null
  accountCode: string | null
  accountCodeKey: string | null
  canonicalDisplayName: string | null
  hospitalCmIncluded: number | null
  effectiveFromMonth: string | null
  effectiveToMonth: string | null
  rowHash: string | null
  alias: string | null
  aliasKey: string | null
  partnerExists: number | null
}

interface IdempotencyRow {
  actorUserId: string
  requestHash: string
  resultId: string
}

export class HospitalCmDirectoryError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = 'HospitalCmDirectoryError'
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function requireExactFields(
  value: unknown,
  allowed: readonly string[],
  code: string,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HospitalCmDirectoryError(code, 400, `${label}格式无效`)
  }
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => !allowed.includes(key))) {
    throw new HospitalCmDirectoryError(code, 400, `${label}含未批准字段`)
  }
  return object
}

function requireText(value: unknown, code: string, label: string, max: number): string {
  const normalized = typeof value === 'string' ? value.normalize('NFKC').trim() : ''
  if (!normalized || normalized.length > max || hasControlCharacter(normalized)) {
    throw new HospitalCmDirectoryError(code, 400, `${label}缺失、过长或含控制字符`)
  }
  return normalized
}

function normalizeMappingKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function startsSpreadsheetFormula(value: string): boolean {
  return /^[=+\-@]/.test(value)
}

function normalizeOptionalMonth(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const month = typeof value === 'string' ? value.trim() : ''
  if (!SERVICE_MONTH_RE.test(month)) {
    throw new HospitalCmDirectoryError('DIRECTORY_MONTH_INVALID', 400, '生效月份必须是合法 YYYY-MM')
  }
  return month
}

function normalizeServiceMonth(value: unknown): string {
  const month = typeof value === 'string' ? value.trim() : ''
  if (!SERVICE_MONTH_RE.test(month)) {
    throw new HospitalCmDirectoryError('DIRECTORY_MONTH_INVALID', 400, 'serviceMonth 必须是合法 YYYY-MM')
  }
  return month
}

function normalizeKnownCompleteFromMonth(value: unknown): string {
  const month = typeof value === 'string' ? value.trim() : ''
  if (!SERVICE_MONTH_RE.test(month)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_MONTH_INVALID',
      400,
      'knownCompleteFromMonth 必须是合法 YYYY-MM',
    )
  }
  return month
}

function normalizeActor(value: unknown): HospitalCmDirectoryActor {
  const actor = requireExactFields(value, ['userId', 'username'], 'DIRECTORY_ACTOR_INVALID', 'actor')
  return {
    userId: requireText(actor.userId, 'DIRECTORY_ACTOR_INVALID', 'actor.userId', 128),
    username: requireText(actor.username, 'DIRECTORY_ACTOR_INVALID', 'actor.username', 128),
  }
}

function normalizeIdempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_IDEMPOTENCY_KEY_INVALID',
      400,
      '幂等键必须是 8~128 位安全字符',
    )
  }
  return key
}

function directoryRowHash(entry: Omit<HospitalCmDirectoryEntry, 'rowHash'>): string {
  return sha256(entry)
}

function directoryContentHash(
  entries: HospitalCmDirectoryEntry[],
  knownCompleteFromMonth: string,
): string {
  return sha256({
    contractVersion: HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
    knownCompleteFromMonth,
    rowHashes: entries.map(entry => entry.rowHash),
  })
}

function directoryRevisionLineageHash(input: {
  id: string
  eventNumber: number
  revision: number
  contractVersion: typeof HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION
  knownCompleteFromMonth: string
  entryCount: number
  aliasCount: number
  contentHash: string
  supersedesVersionId: string | null
  parentRevisionLineageHash: string | null
  reasonCode: string
  recordedByUserId: string
  recordedByUsername: string
  recordedAt: string
}): string {
  return sha256({
    recipeVersion: HOSPITAL_CM_DIRECTORY_LINEAGE_RECIPE_VERSION,
    ...input,
  })
}

interface MembershipWindow {
  fromMonth: string
  toMonth: string | null
}

function membershipWindow(entry: HospitalCmDirectoryEntry | undefined): MembershipWindow | null {
  if (!entry?.hospitalCmIncluded || entry.effectiveFromMonth === null) return null
  return { fromMonth: entry.effectiveFromMonth, toMonth: entry.effectiveToMonth }
}

function summarizeMembershipChanges(
  before: HospitalCmDirectoryRevision | null,
  after: HospitalCmDirectoryEntry[],
): { membershipChangeCount: number; affectedMembershipWindows: MembershipWindow[] } {
  const beforeByPartner = new Map((before?.entries ?? []).map(entry => [entry.stablePartnerId, entry]))
  const afterByPartner = new Map(after.map(entry => [entry.stablePartnerId, entry]))
  const partnerIds = [...new Set([...beforeByPartner.keys(), ...afterByPartner.keys()])].sort()
  let membershipChangeCount = 0
  const windows = new Map<string, MembershipWindow>()
  for (const partnerId of partnerIds) {
    const oldWindow = membershipWindow(beforeByPartner.get(partnerId))
    const newWindow = membershipWindow(afterByPartner.get(partnerId))
    if (stableStringify(oldWindow) === stableStringify(newWindow)) continue
    membershipChangeCount += 1
    for (const window of [oldWindow, newWindow]) {
      if (window) windows.set(stableStringify(window), window)
    }
  }
  return {
    membershipChangeCount,
    affectedMembershipWindows: [...windows.values()].sort((left, right) => {
      const fromOrder = compareText(left.fromMonth, right.fromMonth)
      if (fromOrder !== 0) return fromOrder
      return compareText(left.toMonth ?? '9999-12', right.toMonth ?? '9999-12')
    }),
  }
}

function normalizeDirectoryEntry(value: unknown): NormalizedDirectoryEntry {
  const raw = requireExactFields(
    value,
    [
      'stablePartnerId',
      'accountCode',
      'canonicalDisplayName',
      'aliases',
      'hospitalCmIncluded',
      'effectiveFromMonth',
      'effectiveToMonth',
    ],
    'DIRECTORY_ENTRY_UNSUPPORTED_FIELD',
    '医院目录行',
  )
  const stablePartnerId = requireText(
    raw.stablePartnerId,
    'DIRECTORY_PARTNER_ID_INVALID',
    'stablePartnerId',
    128,
  )
  if (!STABLE_PARTNER_ID_RE.test(stablePartnerId)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_PARTNER_ID_INVALID',
      400,
      'stablePartnerId 必须是安全的不透明内部标识',
    )
  }
  const accountCode = requireText(raw.accountCode, 'DIRECTORY_ACCOUNT_CODE_INVALID', 'accountCode', 128)
  if (startsSpreadsheetFormula(accountCode)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_ACCOUNT_CODE_INVALID',
      400,
      'accountCode 不得以表格公式控制字符开头',
    )
  }
  const accountCodeKey = normalizeMappingKey(accountCode)
  if (!accountCodeKey) {
    throw new HospitalCmDirectoryError('DIRECTORY_ACCOUNT_CODE_INVALID', 400, 'accountCode 无法规范化')
  }
  const canonicalDisplayName = requireText(
    raw.canonicalDisplayName,
    'DIRECTORY_DISPLAY_NAME_INVALID',
    'canonicalDisplayName',
    256,
  )
  if (startsSpreadsheetFormula(canonicalDisplayName)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_DISPLAY_NAME_INVALID',
      400,
      'canonicalDisplayName 不得以表格公式控制字符开头',
    )
  }
  if (!Array.isArray(raw.aliases) || raw.aliases.length > MAX_ALIASES_PER_ENTRY) {
    throw new HospitalCmDirectoryError('DIRECTORY_ALIASES_INVALID', 400, 'aliases 必须是长度受限的字符串数组')
  }
  const seenAliasKeys = new Set<string>()
  const aliasRecords = raw.aliases.map(value => {
    const alias = requireText(value, 'DIRECTORY_ALIAS_INVALID', 'alias', 256)
    if (startsSpreadsheetFormula(alias)) {
      throw new HospitalCmDirectoryError(
        'DIRECTORY_ALIAS_INVALID',
        400,
        'alias 不得以表格公式控制字符开头',
      )
    }
    const aliasKey = normalizeMappingKey(alias)
    if (!aliasKey || seenAliasKeys.has(aliasKey)) {
      throw new HospitalCmDirectoryError('DIRECTORY_MAPPING_AMBIGUOUS', 409, '目录含重复或歧义映射')
    }
    seenAliasKeys.add(aliasKey)
    return { alias, aliasKey }
  }).sort((left, right) => compareText(left.aliasKey, right.aliasKey) || compareText(left.alias, right.alias))

  if (typeof raw.hospitalCmIncluded !== 'boolean') {
    throw new HospitalCmDirectoryError('DIRECTORY_INCLUDED_INVALID', 400, 'hospitalCmIncluded 必须是布尔值')
  }
  const hospitalCmIncluded = raw.hospitalCmIncluded
  const effectiveFromMonth = normalizeOptionalMonth(raw.effectiveFromMonth)
  const effectiveToMonth = normalizeOptionalMonth(raw.effectiveToMonth)
  if (hospitalCmIncluded && effectiveFromMonth === null) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_EFFECTIVE_FROM_REQUIRED',
      400,
      '纳入院级贡献毛利的医院必须显式配置 effectiveFromMonth',
    )
  }
  if ((effectiveToMonth !== null && effectiveFromMonth === null)
    || (effectiveFromMonth !== null && effectiveToMonth !== null && effectiveToMonth < effectiveFromMonth)) {
    throw new HospitalCmDirectoryError('DIRECTORY_EFFECTIVE_RANGE_INVALID', 400, '目录生效区间无效')
  }

  const aliases = aliasRecords.map(item => item.alias)
  const hashInput: Omit<HospitalCmDirectoryEntry, 'rowHash'> = {
    stablePartnerId,
    accountCode,
    canonicalDisplayName,
    aliases,
    hospitalCmIncluded,
    effectiveFromMonth,
    effectiveToMonth,
  }
  return {
    ...hashInput,
    rowHash: directoryRowHash(hashInput),
    accountCodeKey,
    aliasRecords,
  }
}

function normalizeDirectoryInput(value: unknown): NormalizedDirectoryInput {
  const raw = requireExactFields(
    value,
    ['entries', 'knownCompleteFromMonth', 'actor', 'reasonCode', 'idempotencyKey'],
    'DIRECTORY_UNSUPPORTED_FIELD',
    '医院目录请求',
  )
  if (!Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > MAX_ENTRIES) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_ENTRIES_REQUIRED',
      400,
      `entries 必须包含 1~${MAX_ENTRIES} 行`,
    )
  }
  const knownCompleteFromMonth = normalizeKnownCompleteFromMonth(raw.knownCompleteFromMonth)
  const actor = normalizeActor(raw.actor)
  const reasonCode = requireText(raw.reasonCode, 'DIRECTORY_REASON_CODE_INVALID', 'reasonCode', 128)
  if (!REASON_CODE_RE.test(reasonCode)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_REASON_CODE_INVALID',
      400,
      'reasonCode 必须是大写安全代码',
    )
  }
  const idempotencyKey = normalizeIdempotencyKey(raw.idempotencyKey)
  const entries = raw.entries.map(normalizeDirectoryEntry)
    .sort((left, right) => compareText(left.stablePartnerId, right.stablePartnerId))

  const partnerIds = new Set<string>()
  const mappingOwners = new Map<string, string>()
  for (const entry of entries) {
    if (partnerIds.has(entry.stablePartnerId)) {
      throw new HospitalCmDirectoryError('DIRECTORY_PARTNER_DUPLICATE', 409, '目录含重复 stablePartnerId')
    }
    partnerIds.add(entry.stablePartnerId)
    for (const key of [entry.accountCodeKey, ...entry.aliasRecords.map(alias => alias.aliasKey)]) {
      const owner = mappingOwners.get(key)
      if (owner !== undefined && owner !== entry.stablePartnerId) {
        throw new HospitalCmDirectoryError('DIRECTORY_MAPPING_AMBIGUOUS', 409, '目录映射键绑定了多个医院')
      }
      mappingOwners.set(key, entry.stablePartnerId)
    }
  }

  const contentHash = directoryContentHash(entries, knownCompleteFromMonth)
  const requestHash = sha256({
    operation: 'SAVE_HOSPITAL_CM_DIRECTORY_REVISION',
    actorUserId: actor.userId,
    contentHash,
    reasonCode,
  })
  return {
    entries,
    knownCompleteFromMonth,
    actor,
    reasonCode,
    idempotencyKey,
    contentHash,
    requestHash,
  }
}

export function ensureHospitalCmDirectorySchema(db: HospitalCmDirectoryDb): void {
  // Deliberately no PRAGMA and no seed/backfill: imported/legacy partners remain excluded.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hospital_cm_directory_versions (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE CHECK (length(id) = 36),
      revision INTEGER NOT NULL UNIQUE CHECK (revision > 0),
      contract_version TEXT NOT NULL CHECK (
        contract_version = '${HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION}'
      ),
      known_complete_from_month TEXT NOT NULL CHECK (
        length(known_complete_from_month) = 7
        AND known_complete_from_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
        AND substr(known_complete_from_month, 6, 2) BETWEEN '01' AND '12'
      ),
      entry_count INTEGER NOT NULL CHECK (entry_count BETWEEN 1 AND ${MAX_ENTRIES}),
      alias_count INTEGER NOT NULL CHECK (
        alias_count BETWEEN 0 AND ${MAX_ENTRIES * MAX_ALIASES_PER_ENTRY}
      ),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
      ),
      revision_lineage_hash TEXT NOT NULL CHECK (
        length(revision_lineage_hash) = 64
        AND revision_lineage_hash NOT GLOB '*[^0-9a-f]*'
      ),
      supersedes_version_id TEXT,
      reason_code TEXT NOT NULL,
      recorded_by_user_id TEXT NOT NULL,
      recorded_by_username TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      FOREIGN KEY (supersedes_version_id) REFERENCES hospital_cm_directory_versions(id)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_directory_entries (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      directory_version_id TEXT NOT NULL,
      stable_partner_id TEXT NOT NULL,
      account_code TEXT NOT NULL,
      account_code_key TEXT NOT NULL,
      canonical_display_name TEXT NOT NULL,
      hospital_cm_included INTEGER NOT NULL CHECK (hospital_cm_included IN (0, 1)),
      effective_from_month TEXT CHECK (
        effective_from_month IS NULL OR (
          length(effective_from_month) = 7
          AND effective_from_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
          AND substr(effective_from_month, 6, 2) BETWEEN '01' AND '12'
        )
      ),
      effective_to_month TEXT CHECK (
        effective_to_month IS NULL OR (
          length(effective_to_month) = 7
          AND effective_to_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
          AND substr(effective_to_month, 6, 2) BETWEEN '01' AND '12'
        )
      ),
      row_hash TEXT NOT NULL CHECK (
        length(row_hash) = 64 AND row_hash NOT GLOB '*[^0-9a-f]*'
      ),
      UNIQUE (directory_version_id, stable_partner_id),
      UNIQUE (directory_version_id, account_code_key),
      FOREIGN KEY (directory_version_id) REFERENCES hospital_cm_directory_versions(id),
      FOREIGN KEY (stable_partner_id) REFERENCES partners(id),
      CHECK (hospital_cm_included = 0 OR effective_from_month IS NOT NULL),
      CHECK (effective_to_month IS NULL OR effective_from_month IS NOT NULL),
      CHECK (effective_to_month IS NULL OR effective_to_month >= effective_from_month)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_directory_aliases (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      directory_version_id TEXT NOT NULL,
      stable_partner_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      alias_key TEXT NOT NULL,
      UNIQUE (directory_version_id, alias_key),
      FOREIGN KEY (directory_version_id) REFERENCES hospital_cm_directory_versions(id),
      FOREIGN KEY (directory_version_id, stable_partner_id)
        REFERENCES hospital_cm_directory_entries(directory_version_id, stable_partner_id)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_directory_idempotency (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE CHECK (
        length(idempotency_key) BETWEEN 8 AND 128
        AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
      operation TEXT NOT NULL CHECK (operation = 'SAVE_REVISION'),
      actor_user_id TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
      ),
      result_id TEXT NOT NULL CHECK (length(result_id) = 36),
      created_at TEXT NOT NULL,
      FOREIGN KEY (result_id) REFERENCES hospital_cm_directory_versions(id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_version_requires_complete_previous
    BEFORE INSERT ON hospital_cm_directory_versions
    WHEN EXISTS (
      SELECT 1
      FROM hospital_cm_directory_versions previous_version
      WHERE previous_version.revision = (
        SELECT MAX(revision) FROM hospital_cm_directory_versions
      )
        AND (
          (SELECT COUNT(*) FROM hospital_cm_directory_entries
           WHERE directory_version_id = previous_version.id) <> previous_version.entry_count
          OR
          (SELECT COUNT(*) FROM hospital_cm_directory_aliases
           WHERE directory_version_id = previous_version.id) <> previous_version.alias_count
        )
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_PREVIOUS_VERSION_INCOMPLETE');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_version_sequence
    BEFORE INSERT ON hospital_cm_directory_versions
    WHEN NEW.revision <> COALESCE((SELECT MAX(revision) + 1 FROM hospital_cm_directory_versions), 1)
      OR (NEW.revision = 1 AND NEW.supersedes_version_id IS NOT NULL)
      OR (NEW.revision > 1 AND NEW.supersedes_version_id IS NOT (
        SELECT id FROM hospital_cm_directory_versions ORDER BY revision DESC LIMIT 1
      ))
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_SEQUENCE_INVALID');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_versions_no_duplicate_insert
    BEFORE INSERT ON hospital_cm_directory_versions
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_directory_versions
      WHERE event_number = NEW.event_number OR id = NEW.id OR revision = NEW.revision
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_versions_no_update
    BEFORE UPDATE ON hospital_cm_directory_versions
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_versions_no_delete
    BEFORE DELETE ON hospital_cm_directory_versions
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_APPEND_ONLY');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_entries_require_header
    BEFORE INSERT ON hospital_cm_directory_entries
    WHEN NOT EXISTS (
      SELECT 1 FROM hospital_cm_directory_versions WHERE id = NEW.directory_version_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_MISSING');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_entries_require_partner
    BEFORE INSERT ON hospital_cm_directory_entries
    WHEN NOT EXISTS (
      SELECT 1 FROM partners WHERE id = NEW.stable_partner_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_PARTNER_MISSING');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_entries_sealed
    BEFORE INSERT ON hospital_cm_directory_entries
    WHEN (SELECT COUNT(*) FROM hospital_cm_directory_entries
          WHERE directory_version_id = NEW.directory_version_id) >=
         (SELECT entry_count FROM hospital_cm_directory_versions
          WHERE id = NEW.directory_version_id)
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_SEALED');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_entries_no_duplicate_insert
    BEFORE INSERT ON hospital_cm_directory_entries
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_directory_entries
      WHERE event_number = NEW.event_number
        OR (directory_version_id = NEW.directory_version_id
            AND (stable_partner_id = NEW.stable_partner_id
                 OR account_code_key = NEW.account_code_key))
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_ENTRY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_entries_no_update
    BEFORE UPDATE ON hospital_cm_directory_entries
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_ENTRY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_entries_no_delete
    BEFORE DELETE ON hospital_cm_directory_entries
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_ENTRY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_entries_preserve_included_members
    AFTER INSERT ON hospital_cm_directory_entries
    WHEN (SELECT COUNT(*) FROM hospital_cm_directory_entries
          WHERE directory_version_id = NEW.directory_version_id) =
         (SELECT entry_count FROM hospital_cm_directory_versions
          WHERE id = NEW.directory_version_id)
      AND EXISTS (
        SELECT 1
        FROM hospital_cm_directory_versions current_version
        JOIN hospital_cm_directory_entries previous_entry
          ON previous_entry.directory_version_id = current_version.supersedes_version_id
        LEFT JOIN hospital_cm_directory_entries current_entry
          ON current_entry.directory_version_id = current_version.id
          AND current_entry.stable_partner_id = previous_entry.stable_partner_id
        WHERE current_version.id = NEW.directory_version_id
          AND previous_entry.hospital_cm_included = 1
          AND (current_entry.stable_partner_id IS NULL
            OR current_entry.hospital_cm_included <> 1
            OR current_entry.effective_from_month > previous_entry.effective_from_month)
      )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_aliases_require_entry
    BEFORE INSERT ON hospital_cm_directory_aliases
    WHEN NOT EXISTS (
      SELECT 1 FROM hospital_cm_directory_entries
      WHERE directory_version_id = NEW.directory_version_id
        AND stable_partner_id = NEW.stable_partner_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_ENTRY_MISSING');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_aliases_reject_code_conflict
    BEFORE INSERT ON hospital_cm_directory_aliases
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_directory_entries
      WHERE directory_version_id = NEW.directory_version_id
        AND account_code_key = NEW.alias_key
        AND stable_partner_id <> NEW.stable_partner_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_MAPPING_AMBIGUOUS');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_aliases_sealed
    BEFORE INSERT ON hospital_cm_directory_aliases
    WHEN (SELECT COUNT(*) FROM hospital_cm_directory_aliases
          WHERE directory_version_id = NEW.directory_version_id) >=
         (SELECT alias_count FROM hospital_cm_directory_versions
          WHERE id = NEW.directory_version_id)
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_SEALED');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_aliases_no_duplicate_insert
    BEFORE INSERT ON hospital_cm_directory_aliases
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_directory_aliases
      WHERE event_number = NEW.event_number
        OR (directory_version_id = NEW.directory_version_id AND alias_key = NEW.alias_key)
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_ALIAS_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_aliases_no_update
    BEFORE UPDATE ON hospital_cm_directory_aliases
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_ALIAS_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_aliases_no_delete
    BEFORE DELETE ON hospital_cm_directory_aliases
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_ALIAS_APPEND_ONLY');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_idempotency_no_duplicate_insert
    BEFORE INSERT ON hospital_cm_directory_idempotency
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_directory_idempotency
      WHERE event_number = NEW.event_number OR idempotency_key = NEW.idempotency_key
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_IDEMPOTENCY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_idempotency_require_result
    BEFORE INSERT ON hospital_cm_directory_idempotency
    WHEN NOT EXISTS (
      SELECT 1 FROM hospital_cm_directory_versions WHERE id = NEW.result_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_VERSION_MISSING');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_idempotency_no_update
    BEFORE UPDATE ON hospital_cm_directory_idempotency
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_IDEMPOTENCY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_directory_idempotency_no_delete
    BEFORE DELETE ON hospital_cm_directory_idempotency
    BEGIN
      SELECT RAISE(ABORT, 'DIRECTORY_IDEMPOTENCY_APPEND_ONLY');
    END;
  `)
}

const VERSION_SELECT = `
  SELECT
    id,
    event_number AS eventNumber,
    revision,
    contract_version AS contractVersion,
    known_complete_from_month AS knownCompleteFromMonth,
    entry_count AS entryCount,
    alias_count AS aliasCount,
    content_hash AS contentHash,
    revision_lineage_hash AS revisionLineageHash,
    supersedes_version_id AS supersedesVersionId,
    reason_code AS reasonCode,
    recorded_by_user_id AS recordedByUserId,
    recorded_by_username AS recordedByUsername,
    recorded_at AS recordedAt
  FROM hospital_cm_directory_versions
`

function metadataFromRow(row: VersionRow): HospitalCmDirectoryRevisionMetadata {
  return {
    id: row.id,
    eventNumber: Number(row.eventNumber),
    revision: Number(row.revision),
    contractVersion: row.contractVersion as typeof HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
    knownCompleteFromMonth: row.knownCompleteFromMonth,
    entryCount: Number(row.entryCount),
    aliasCount: Number(row.aliasCount),
    contentHash: row.contentHash,
    revisionLineageHash: row.revisionLineageHash,
    supersedesVersionId: row.supersedesVersionId,
    reasonCode: row.reasonCode,
    recordedByUserId: row.recordedByUserId,
    recordedByUsername: row.recordedByUsername,
    recordedAt: row.recordedAt,
  }
}

function corrupt(message: string): never {
  throw new HospitalCmDirectoryError('DIRECTORY_CORRUPT', 500, message)
}

function buildDirectoryRevision(
  row: VersionRow,
  storedEntries: EntryRow[],
  storedAliases: AliasRow[],
): HospitalCmDirectoryRevision {
  const aliasesByPartner = new Map<string, string[]>()
  for (const alias of storedAliases) {
    const aliases = aliasesByPartner.get(alias.stablePartnerId) ?? []
    aliases.push(alias.alias)
    aliasesByPartner.set(alias.stablePartnerId, aliases)
  }
  for (const aliases of aliasesByPartner.values()) {
    aliases.sort((left, right) => compareText(normalizeMappingKey(left), normalizeMappingKey(right))
      || compareText(left, right))
  }
  const entries = storedEntries.map(entry => ({
    stablePartnerId: entry.stablePartnerId,
    accountCode: entry.accountCode,
    canonicalDisplayName: entry.canonicalDisplayName,
    aliases: aliasesByPartner.get(entry.stablePartnerId) ?? [],
    hospitalCmIncluded: Number(entry.hospitalCmIncluded) === 1,
    effectiveFromMonth: entry.effectiveFromMonth,
    effectiveToMonth: entry.effectiveToMonth,
    rowHash: entry.rowHash,
  }))
  return { ...metadataFromRow(row), entries }
}

function isCanonicalStoredText(value: string, max: number): boolean {
  return value.length > 0
    && value.length <= max
    && value === value.normalize('NFKC').trim()
    && !hasControlCharacter(value)
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function validateDirectoryRevisionIntegrity(
  directory: HospitalCmDirectoryRevision,
  storedEntries: EntryRow[],
  storedAliases: AliasRow[],
  parentRevisionLineageHash: string | null,
): void {
  if (directory.contractVersion !== HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION
    || !Number.isInteger(directory.eventNumber) || directory.eventNumber < 1
    || !Number.isInteger(directory.revision) || directory.revision < 1
    || !SERVICE_MONTH_RE.test(directory.knownCompleteFromMonth)
    || directory.entryCount !== directory.entries.length
    || directory.aliasCount !== storedAliases.length
    || !/^[0-9a-f]{64}$/.test(directory.contentHash)
    || !/^[0-9a-f]{64}$/.test(directory.revisionLineageHash)
    || !REASON_CODE_RE.test(directory.reasonCode)
    || !isCanonicalStoredText(directory.recordedByUserId, 128)
    || !isCanonicalStoredText(directory.recordedByUsername, 128)
    || !isCanonicalIsoTimestamp(directory.recordedAt)) {
    corrupt('医院目录版本头完整性校验失败')
  }

  const entryIds = new Set(directory.entries.map(entry => entry.stablePartnerId))
  const aliasKeys = new Map<string, string>()
  for (const alias of storedAliases) {
    if (!entryIds.has(alias.stablePartnerId)
      || normalizeMappingKey(alias.alias) !== alias.aliasKey) {
      corrupt('医院目录别名规范化校验失败')
    }
    const owner = aliasKeys.get(alias.aliasKey)
    if (owner !== undefined && owner !== alias.stablePartnerId) corrupt('医院目录别名映射歧义')
    aliasKeys.set(alias.aliasKey, alias.stablePartnerId)
  }

  const accountKeys = new Map<string, string>()
  for (let index = 0; index < directory.entries.length; index += 1) {
    const entry = directory.entries[index]
    const stored = storedEntries[index]
    if (!entry || !stored
      || entry.stablePartnerId !== stored.stablePartnerId
      || normalizeMappingKey(entry.accountCode) !== stored.accountCodeKey) {
      corrupt('医院目录账户映射完整性校验失败')
    }
    if ((stored.hospitalCmIncluded !== 0 && stored.hospitalCmIncluded !== 1)
      || (entry.effectiveFromMonth !== null && !SERVICE_MONTH_RE.test(entry.effectiveFromMonth))
      || (entry.effectiveToMonth !== null && !SERVICE_MONTH_RE.test(entry.effectiveToMonth))
      || (entry.hospitalCmIncluded && entry.effectiveFromMonth === null)
      || (entry.effectiveToMonth !== null && (entry.effectiveFromMonth === null
        || entry.effectiveToMonth < entry.effectiveFromMonth))) {
      corrupt('医院目录生效区间完整性校验失败')
    }
    const accountOwner = accountKeys.get(stored.accountCodeKey)
    if (accountOwner !== undefined && accountOwner !== entry.stablePartnerId) {
      corrupt('医院目录账户映射歧义')
    }
    accountKeys.set(stored.accountCodeKey, entry.stablePartnerId)
    const aliasOwner = aliasKeys.get(stored.accountCodeKey)
    if (aliasOwner !== undefined && aliasOwner !== entry.stablePartnerId) {
      corrupt('医院目录账户与别名映射歧义')
    }
    const expectedRowHash = directoryRowHash({
      stablePartnerId: entry.stablePartnerId,
      accountCode: entry.accountCode,
      canonicalDisplayName: entry.canonicalDisplayName,
      aliases: entry.aliases,
      hospitalCmIncluded: entry.hospitalCmIncluded,
      effectiveFromMonth: entry.effectiveFromMonth,
      effectiveToMonth: entry.effectiveToMonth,
    })
    if (entry.rowHash !== expectedRowHash) corrupt('医院目录行完整性校验失败')
  }

  if (directory.contentHash !== directoryContentHash(
    directory.entries,
    directory.knownCompleteFromMonth,
  )) {
    corrupt('医院目录内容完整性校验失败')
  }
  const expectedLineageHash = directoryRevisionLineageHash({
    id: directory.id,
    eventNumber: directory.eventNumber,
    revision: directory.revision,
    contractVersion: directory.contractVersion,
    knownCompleteFromMonth: directory.knownCompleteFromMonth,
    entryCount: directory.entryCount,
    aliasCount: directory.aliasCount,
    contentHash: directory.contentHash,
    supersedesVersionId: directory.supersedesVersionId,
    parentRevisionLineageHash,
    reasonCode: directory.reasonCode,
    recordedByUserId: directory.recordedByUserId,
    recordedByUsername: directory.recordedByUsername,
    recordedAt: directory.recordedAt,
  })
  if (directory.revisionLineageHash !== expectedLineageHash) {
    corrupt('医院目录审计链完整性校验失败')
  }
}

function loadValidatedDirectoryLineage(
  db: HospitalCmDirectoryDb,
  targetRow: VersionRow,
): { target: HospitalCmDirectoryRevision; byId: Map<string, HospitalCmDirectoryRevision> } {
  const rows = db.prepare(`
    WITH RECURSIVE lineage (id, supersedes_version_id) AS (
      SELECT id, supersedes_version_id
      FROM hospital_cm_directory_versions
      WHERE id = ?
      UNION
      SELECT parent.id, parent.supersedes_version_id
      FROM hospital_cm_directory_versions parent
      JOIN lineage child ON parent.id = child.supersedes_version_id
    )
    SELECT 'VERSION' AS rowKind, version.id AS versionId,
      version.event_number AS eventNumber, version.revision,
      version.contract_version AS contractVersion,
      version.known_complete_from_month AS knownCompleteFromMonth,
      version.entry_count AS entryCount, version.alias_count AS aliasCount,
      version.content_hash AS contentHash,
      version.revision_lineage_hash AS revisionLineageHash,
      version.supersedes_version_id AS supersedesVersionId,
      version.reason_code AS reasonCode,
      version.recorded_by_user_id AS recordedByUserId,
      version.recorded_by_username AS recordedByUsername,
      version.recorded_at AS recordedAt,
      NULL AS stablePartnerId, NULL AS accountCode, NULL AS accountCodeKey,
      NULL AS canonicalDisplayName, NULL AS hospitalCmIncluded,
      NULL AS effectiveFromMonth, NULL AS effectiveToMonth, NULL AS rowHash,
      NULL AS alias, NULL AS aliasKey, NULL AS partnerExists
    FROM lineage
    JOIN hospital_cm_directory_versions version ON version.id = lineage.id
    UNION ALL
    SELECT 'ENTRY', entry.directory_version_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      entry.stable_partner_id, entry.account_code, entry.account_code_key,
      entry.canonical_display_name, entry.hospital_cm_included,
      entry.effective_from_month, entry.effective_to_month, entry.row_hash,
      NULL, NULL,
      CASE WHEN EXISTS (
        SELECT 1 FROM partners WHERE id = entry.stable_partner_id
      ) THEN 1 ELSE 0 END
    FROM lineage
    JOIN hospital_cm_directory_entries entry ON entry.directory_version_id = lineage.id
    UNION ALL
    SELECT 'ALIAS', alias_row.directory_version_id,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      alias_row.stable_partner_id, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      alias_row.alias, alias_row.alias_key, NULL
    FROM lineage
    JOIN hospital_cm_directory_aliases alias_row
      ON alias_row.directory_version_id = lineage.id
  `).all(targetRow.id) as LineageBundleRow[]

  const versionRows = new Map<string, VersionRow>()
  const entriesByVersion = new Map<string, EntryRow[]>()
  const aliasesByVersion = new Map<string, AliasRow[]>()
  for (const row of rows) {
    if (row.rowKind === 'VERSION') {
      if (row.eventNumber === null || row.revision === null || row.contractVersion === null
        || row.knownCompleteFromMonth === null || row.entryCount === null
        || row.aliasCount === null || row.contentHash === null
        || row.revisionLineageHash === null || row.reasonCode === null
        || row.recordedByUserId === null || row.recordedByUsername === null
        || row.recordedAt === null || versionRows.has(row.versionId)) {
        corrupt('医院目录版本链结构无效')
      }
      versionRows.set(row.versionId, {
        id: row.versionId,
        eventNumber: Number(row.eventNumber),
        revision: Number(row.revision),
        contractVersion: row.contractVersion,
        knownCompleteFromMonth: row.knownCompleteFromMonth,
        entryCount: Number(row.entryCount),
        aliasCount: Number(row.aliasCount),
        contentHash: row.contentHash,
        revisionLineageHash: row.revisionLineageHash,
        supersedesVersionId: row.supersedesVersionId,
        reasonCode: row.reasonCode,
        recordedByUserId: row.recordedByUserId,
        recordedByUsername: row.recordedByUsername,
        recordedAt: row.recordedAt,
      })
      continue
    }
    if (row.rowKind === 'ENTRY') {
      if (row.stablePartnerId === null || row.accountCode === null
        || row.accountCodeKey === null || row.canonicalDisplayName === null
        || row.hospitalCmIncluded === null || row.rowHash === null
        || Number(row.partnerExists) !== 1) {
        corrupt('医院目录版本链账户无效')
      }
      const entries = entriesByVersion.get(row.versionId) ?? []
      entries.push({
        stablePartnerId: row.stablePartnerId,
        accountCode: row.accountCode,
        accountCodeKey: row.accountCodeKey,
        canonicalDisplayName: row.canonicalDisplayName,
        hospitalCmIncluded: Number(row.hospitalCmIncluded),
        effectiveFromMonth: row.effectiveFromMonth,
        effectiveToMonth: row.effectiveToMonth,
        rowHash: row.rowHash,
      })
      entriesByVersion.set(row.versionId, entries)
      continue
    }
    if (row.stablePartnerId === null || row.alias === null || row.aliasKey === null) {
      corrupt('医院目录版本链别名无效')
    }
    const aliases = aliasesByVersion.get(row.versionId) ?? []
    aliases.push({
      stablePartnerId: row.stablePartnerId,
      alias: row.alias,
      aliasKey: row.aliasKey,
    })
    aliasesByVersion.set(row.versionId, aliases)
  }

  const orderedRows = [...versionRows.values()].sort((left, right) => left.revision - right.revision)
  if (orderedRows.length !== Number(targetRow.revision)
    || orderedRows[orderedRows.length - 1]?.id !== targetRow.id) {
    corrupt('医院目录版本链长度无效')
  }

  const byId = new Map<string, HospitalCmDirectoryRevision>()
  let previous: HospitalCmDirectoryRevision | null = null
  for (let index = 0; index < orderedRows.length; index += 1) {
    const versionRow = orderedRows[index]
    if (!versionRow || versionRow.revision !== index + 1
      || (index === 0 && versionRow.supersedesVersionId !== null)
      || (index > 0 && versionRow.supersedesVersionId !== previous?.id)
      || (previous !== null && versionRow.eventNumber <= previous.eventNumber)) {
      corrupt('医院目录版本链顺序无效')
    }
    const storedEntries = (entriesByVersion.get(versionRow.id) ?? [])
      .sort((left, right) => compareText(left.stablePartnerId, right.stablePartnerId))
    const storedAliases = (aliasesByVersion.get(versionRow.id) ?? [])
      .sort((left, right) => compareText(left.stablePartnerId, right.stablePartnerId)
        || compareText(left.aliasKey, right.aliasKey)
        || compareText(left.alias, right.alias))
    const directory = buildDirectoryRevision(versionRow, storedEntries, storedAliases)
    validateDirectoryRevisionIntegrity(
      directory,
      storedEntries,
      storedAliases,
      previous?.revisionLineageHash ?? null,
    )
    if (previous) {
      const nextByPartnerId = new Map(directory.entries.map(entry => [entry.stablePartnerId, entry]))
      if (previous.entries.some(entry => {
        if (!entry.hospitalCmIncluded) return false
        const next = nextByPartnerId.get(entry.stablePartnerId)
        return next?.hospitalCmIncluded !== true
          || (entry.effectiveFromMonth !== null
            && next.effectiveFromMonth !== null
            && next.effectiveFromMonth > entry.effectiveFromMonth)
      })) {
        corrupt('医院目录版本链隐式移除了已纳入医院')
      }
    }
    byId.set(directory.id, directory)
    previous = directory
  }

  const target = byId.get(targetRow.id)
  if (!target
    || stableStringify(metadataFromRow(targetRow)) !== stableStringify(metadataFromRow(versionRows.get(targetRow.id)!))) {
    corrupt('医院目录目标版本在读取期间发生变化')
  }
  return { target, byId }
}

function loadDirectoryFromRow(
  db: HospitalCmDirectoryDb,
  row: VersionRow,
): HospitalCmDirectoryRevision {
  return loadValidatedDirectoryLineage(db, row).target
}

export function getHospitalCmDirectoryRevision(
  db: HospitalCmDirectoryDb,
  id: string,
): HospitalCmDirectoryRevision | null {
  const row = db.prepare(`${VERSION_SELECT} WHERE id = ?`).get(id) as VersionRow | undefined
  return row ? loadDirectoryFromRow(db, row) : null
}

export function getCurrentHospitalCmDirectory(
  db: HospitalCmDirectoryDb,
): HospitalCmDirectoryRevision | null {
  const row = db.prepare(`${VERSION_SELECT} ORDER BY revision DESC LIMIT 1`).get() as VersionRow | undefined
  return row ? loadDirectoryFromRow(db, row) : null
}

function requireExistingPartners(db: HospitalCmDirectoryDb, entries: NormalizedDirectoryEntry[]): void {
  const existingIds = new Set(
    (db.prepare('SELECT id FROM partners').all() as Array<{ id: string }>).map(row => row.id),
  )
  const missing = entries.find(entry => !existingIds.has(entry.stablePartnerId))
  if (missing) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_PARTNER_MISSING',
      409,
      'stablePartnerId 不存在',
    )
  }
}

function requireIncludedMembersRetained(
  previous: HospitalCmDirectoryRevision | null,
  entries: NormalizedDirectoryEntry[],
): void {
  if (!previous) return
  const nextByPartnerId = new Map(entries.map(entry => [entry.stablePartnerId, entry]))
  const removed = previous.entries.find(entry => {
    if (!entry.hospitalCmIncluded) return false
    const next = nextByPartnerId.get(entry.stablePartnerId)
    return next?.hospitalCmIncluded !== true
      || (entry.effectiveFromMonth !== null
        && next.effectiveFromMonth !== null
        && next.effectiveFromMonth > entry.effectiveFromMonth)
  })
  if (removed) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_INCLUDED_MEMBER_REMOVAL_INVALID',
      409,
      '已纳入的医院必须保留原起始月；退出请设置明确的 effectiveToMonth',
    )
  }
}

export function saveHospitalCmDirectoryRevision(
  db: HospitalCmDirectoryDb,
  rawInput: unknown,
): HospitalCmDirectoryRevision {
  const input = normalizeDirectoryInput(rawInput)
  db.exec('BEGIN IMMEDIATE')
  try {
    const idempotency = db.prepare(`
      SELECT actor_user_id AS actorUserId, request_hash AS requestHash, result_id AS resultId
      FROM hospital_cm_directory_idempotency
      WHERE idempotency_key = ?
    `).get(input.idempotencyKey) as IdempotencyRow | undefined
    if (idempotency) {
      if (idempotency.actorUserId !== input.actor.userId || idempotency.requestHash !== input.requestHash) {
        throw new HospitalCmDirectoryError(
          'DIRECTORY_IDEMPOTENCY_CONFLICT',
          409,
          '幂等键已绑定不同请求',
        )
      }
      const replay = getHospitalCmDirectoryRevision(db, idempotency.resultId)
      if (!replay) corrupt('医院目录幂等结果缺失')
      db.exec('COMMIT')
      return replay
    }

    requireExistingPartners(db, input.entries)
    const previousDirectory = getCurrentHospitalCmDirectory(db)
    requireIncludedMembersRetained(previousDirectory, input.entries)
    const revision = previousDirectory ? previousDirectory.revision + 1 : 1
    const eventNumber = previousDirectory ? previousDirectory.eventNumber + 1 : 1
    const id = randomUUID()
    const recordedAt = new Date().toISOString()
    const aliasCount = input.entries.reduce((total, entry) => total + entry.aliasRecords.length, 0)
    const revisionLineageHash = directoryRevisionLineageHash({
      id,
      eventNumber,
      revision,
      contractVersion: HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      knownCompleteFromMonth: input.knownCompleteFromMonth,
      entryCount: input.entries.length,
      aliasCount,
      contentHash: input.contentHash,
      supersedesVersionId: previousDirectory?.id ?? null,
      parentRevisionLineageHash: previousDirectory?.revisionLineageHash ?? null,
      reasonCode: input.reasonCode,
      recordedByUserId: input.actor.userId,
      recordedByUsername: input.actor.username,
      recordedAt,
    })

    db.prepare(`
      INSERT INTO hospital_cm_directory_versions (
        event_number, id, revision, contract_version, known_complete_from_month,
        entry_count, alias_count, content_hash, revision_lineage_hash,
        supersedes_version_id, reason_code, recorded_by_user_id,
        recorded_by_username, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventNumber,
      id,
      revision,
      HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      input.knownCompleteFromMonth,
      input.entries.length,
      aliasCount,
      input.contentHash,
      revisionLineageHash,
      previousDirectory?.id ?? null,
      input.reasonCode,
      input.actor.userId,
      input.actor.username,
      recordedAt,
    )
    const insertEntry = db.prepare(`
      INSERT INTO hospital_cm_directory_entries (
        directory_version_id, stable_partner_id, account_code, account_code_key,
        canonical_display_name, hospital_cm_included, effective_from_month,
        effective_to_month, row_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const insertAlias = db.prepare(`
      INSERT INTO hospital_cm_directory_aliases (
        directory_version_id, stable_partner_id, alias, alias_key
      ) VALUES (?, ?, ?, ?)
    `)
    for (const entry of input.entries) {
      insertEntry.run(
        id,
        entry.stablePartnerId,
        entry.accountCode,
        entry.accountCodeKey,
        entry.canonicalDisplayName,
        entry.hospitalCmIncluded ? 1 : 0,
        entry.effectiveFromMonth,
        entry.effectiveToMonth,
        entry.rowHash,
      )
      for (const alias of entry.aliasRecords) {
        insertAlias.run(id, entry.stablePartnerId, alias.alias, alias.aliasKey)
      }
    }

    const membershipChanges = summarizeMembershipChanges(previousDirectory, input.entries)
    // The linked immutable revisions hold before/after rows. Audit detail keeps only
    // hashes, counts and temporal membership windows; names, codes and aliases stay out.
    db.prepare(`
      INSERT INTO abc_audit_logs (id, module, action, target_id, detail, operator)
      VALUES (?, 'hospital_cm_directory', 'directory_revision_created', ?, ?, ?)
    `).run(randomUUID(), id, JSON.stringify({
      contractVersion: HOSPITAL_CM_DIRECTORY_CONTRACT_VERSION,
      revision,
      entryCount: input.entries.length,
      aliasCount,
      beforeContentHash: previousDirectory?.contentHash ?? null,
      afterContentHash: input.contentHash,
      beforeKnownCompleteFromMonth: previousDirectory?.knownCompleteFromMonth ?? null,
      afterKnownCompleteFromMonth: input.knownCompleteFromMonth,
      supersedesVersionId: previousDirectory?.id ?? null,
      reasonCode: input.reasonCode,
      membershipChangeCount: membershipChanges.membershipChangeCount,
      affectedMembershipWindows: membershipChanges.affectedMembershipWindows,
    }), input.actor.username)

    db.prepare(`
      INSERT INTO hospital_cm_directory_idempotency
        (idempotency_key, operation, actor_user_id, request_hash, result_id, created_at)
      VALUES (?, 'SAVE_REVISION', ?, ?, ?, ?)
    `).run(input.idempotencyKey, input.actor.userId, input.requestHash, id, recordedAt)

    const created = getHospitalCmDirectoryRevision(db, id)
    if (!created) corrupt('医院目录事务内回读失败')
    db.exec('COMMIT')
    return created
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the original failure when SQLite has already closed the transaction.
    }
    if (error instanceof HospitalCmDirectoryError) throw error
    throw new HospitalCmDirectoryError(
      'DIRECTORY_STORAGE_FAILED',
      500,
      '医院目录存储失败；未写入任何配置版本',
    )
  }
}

export function listHospitalCmDirectoryRevisions(
  db: HospitalCmDirectoryDb,
  page: { limit?: number; beforeEvent?: number } = {},
): HospitalCmDirectoryRevisionPage {
  const limit = page.limit ?? 50
  const beforeEvent = page.beforeEvent ?? null
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || (beforeEvent !== null && (!Number.isInteger(beforeEvent) || beforeEvent < 1))) {
    throw new HospitalCmDirectoryError('DIRECTORY_PAGE_INVALID', 400, '分页参数无效')
  }
  const rows = db.prepare(`
    WITH current_row AS (
      SELECT 'CURRENT' AS rowKind, *
      FROM hospital_cm_directory_versions
      ORDER BY revision DESC LIMIT 1
    ), page_rows AS (
      SELECT 'PAGE' AS rowKind, *
      FROM hospital_cm_directory_versions
      WHERE (? IS NULL OR event_number < ?)
      ORDER BY event_number DESC LIMIT ?
    )
    SELECT rowKind, id, event_number AS eventNumber, revision,
      contract_version AS contractVersion,
      known_complete_from_month AS knownCompleteFromMonth,
      entry_count AS entryCount,
      alias_count AS aliasCount, content_hash AS contentHash,
      revision_lineage_hash AS revisionLineageHash,
      supersedes_version_id AS supersedesVersionId, reason_code AS reasonCode,
      recorded_by_user_id AS recordedByUserId,
      recorded_by_username AS recordedByUsername, recorded_at AS recordedAt
    FROM current_row
    UNION ALL
    SELECT rowKind, id, event_number AS eventNumber, revision,
      contract_version AS contractVersion,
      known_complete_from_month AS knownCompleteFromMonth,
      entry_count AS entryCount,
      alias_count AS aliasCount, content_hash AS contentHash,
      revision_lineage_hash AS revisionLineageHash,
      supersedes_version_id AS supersedesVersionId, reason_code AS reasonCode,
      recorded_by_user_id AS recordedByUserId,
      recorded_by_username AS recordedByUsername, recorded_at AS recordedAt
    FROM page_rows
  `).all(beforeEvent, beforeEvent, limit + 1) as VersionRow[]
  const currentRow = rows.find(row => row.rowKind === 'CURRENT')
  const pageRows = rows.filter(row => row.rowKind === 'PAGE')
  const validated = currentRow ? loadValidatedDirectoryLineage(db, currentRow) : null
  for (const row of rows) {
    const validatedRow = validated?.byId.get(row.id)
    const validatedMetadata = validatedRow
      ? (({ entries: _entries, ...metadata }) => metadata)(validatedRow)
      : null
    if (!validatedRow
      || stableStringify(metadataFromRow(row)) !== stableStringify(validatedMetadata)) {
      corrupt('医院目录版本列表完整性校验失败')
    }
  }
  const visibleRows = pageRows.slice(0, limit)
  return {
    current: currentRow ? metadataFromRow(currentRow) : null,
    versions: visibleRows.map(metadataFromRow),
    pagination: {
      limit,
      nextCursor: pageRows.length > limit && visibleRows.length > 0
        ? Number(visibleRows[visibleRows.length - 1]?.eventNumber)
        : null,
    },
  }
}

export function projectHospitalCmDirectoryForMonth(
  db: HospitalCmDirectoryDb,
  rawServiceMonth: unknown,
): HospitalCmDirectoryMonthProjection | null {
  const serviceMonth = normalizeServiceMonth(rawServiceMonth)
  const directory = getCurrentHospitalCmDirectory(db)
  if (!directory) return null
  if (serviceMonth < directory.knownCompleteFromMonth) return null
  const accounts = directory.entries
    .filter(entry => entry.hospitalCmIncluded
      && entry.effectiveFromMonth !== null
      && entry.effectiveFromMonth <= serviceMonth
      && (entry.effectiveToMonth === null || entry.effectiveToMonth >= serviceMonth))
    .map(entry => entry.stablePartnerId)
    .sort()
  const rosterSourceHash = sha256({
    recipeVersion: HOSPITAL_CM_DIRECTORY_ROSTER_RECIPE_VERSION,
    serviceMonth,
    accounts,
  })
  return {
    serviceMonth,
    directoryVersionId: directory.id,
    directoryRevision: directory.revision,
    knownCompleteFromMonth: directory.knownCompleteFromMonth,
    recipeVersion: HOSPITAL_CM_DIRECTORY_ROSTER_RECIPE_VERSION,
    accounts,
    rosterSourceHash,
  }
}

type NormalizedDirectoryResolutionInput =
  | { stablePartnerId: string; mappingKey: null }
  | { stablePartnerId: null; mappingKey: string }

interface InternalDirectoryResolverSnapshot {
  directoryVersionId: string
  directoryRevision: number
  stablePartnerIds: Set<string>
  mappings: Map<string, { stablePartnerId: string; matchedBy: 'ACCOUNT_CODE' | 'ALIAS' }>
}

function normalizeDirectoryResolutionInput(rawInput: unknown): NormalizedDirectoryResolutionInput {
  const input = requireExactFields(
    rawInput,
    ['stablePartnerId', 'mappingKey'],
    'DIRECTORY_RESOLUTION_INPUT_INVALID',
    '医院目录映射请求',
  )
  const hasStablePartnerId = input.stablePartnerId !== undefined && input.stablePartnerId !== null
  const hasMappingKey = input.mappingKey !== undefined && input.mappingKey !== null
  if (hasStablePartnerId === hasMappingKey) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_RESOLUTION_INPUT_INVALID',
      400,
      '映射请求必须且只能提供 stablePartnerId 或 mappingKey',
    )
  }
  const stablePartnerId = hasStablePartnerId
    ? requireText(
      input.stablePartnerId,
      'DIRECTORY_RESOLUTION_INPUT_INVALID',
      'stablePartnerId',
      128,
    )
    : null
  if (stablePartnerId !== null && !STABLE_PARTNER_ID_RE.test(stablePartnerId)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_RESOLUTION_INPUT_INVALID',
      400,
      'stablePartnerId 必须是安全的不透明内部标识',
    )
  }
  const mappingKey = hasMappingKey
    ? normalizeMappingKey(requireText(
      input.mappingKey,
      'DIRECTORY_RESOLUTION_INPUT_INVALID',
      'mappingKey',
      256,
    ))
    : null
  return stablePartnerId !== null
    ? { stablePartnerId, mappingKey: null }
    : { stablePartnerId: null, mappingKey: mappingKey! }
}

function buildInternalDirectoryResolverSnapshot(
  directory: HospitalCmDirectoryRevision,
): InternalDirectoryResolverSnapshot {
  const stablePartnerIds = new Set<string>()
  const mappings = new Map<string, {
    stablePartnerId: string
    matchedBy: 'ACCOUNT_CODE' | 'ALIAS'
  }>()
  for (const entry of directory.entries) {
    stablePartnerIds.add(entry.stablePartnerId)
    const accountCodeKey = normalizeMappingKey(entry.accountCode)
    const existing = mappings.get(accountCodeKey)
    if (existing && existing.stablePartnerId !== entry.stablePartnerId) {
      corrupt('医院目录 resolver 账户映射歧义')
    }
    mappings.set(accountCodeKey, {
      stablePartnerId: entry.stablePartnerId,
      matchedBy: 'ACCOUNT_CODE',
    })
  }
  for (const entry of directory.entries) {
    for (const alias of entry.aliases) {
      const aliasKey = normalizeMappingKey(alias)
      const existing = mappings.get(aliasKey)
      if (existing && existing.stablePartnerId !== entry.stablePartnerId) {
        corrupt('医院目录 resolver 别名映射歧义')
      }
      if (!existing) {
        mappings.set(aliasKey, {
          stablePartnerId: entry.stablePartnerId,
          matchedBy: 'ALIAS',
        })
      }
    }
  }
  return {
    directoryVersionId: directory.id,
    directoryRevision: directory.revision,
    stablePartnerIds,
    mappings,
  }
}

function resolveWithInternalDirectorySnapshot(
  snapshot: InternalDirectoryResolverSnapshot,
  input: NormalizedDirectoryResolutionInput,
): HospitalCmDirectoryResolution | null {
  if (input.stablePartnerId !== null) {
    return snapshot.stablePartnerIds.has(input.stablePartnerId) ? {
      stablePartnerId: input.stablePartnerId,
      matchedBy: 'STABLE_PARTNER_ID',
      directoryVersionId: snapshot.directoryVersionId,
      directoryRevision: snapshot.directoryRevision,
    } : null
  }
  const matched = snapshot.mappings.get(input.mappingKey)
  return matched ? {
    ...matched,
    directoryVersionId: snapshot.directoryVersionId,
    directoryRevision: snapshot.directoryRevision,
  } : null
}

/**
 * Batch source mapping is the supported ingestion path: validate one immutable
 * directory revision, build indexes once, and resolve every row against it.
 */
export function resolveHospitalCmDirectoryPartners(
  db: HospitalCmDirectoryDb,
  rawInputs: readonly unknown[],
): Array<HospitalCmDirectoryResolution | null> {
  if (!Array.isArray(rawInputs)) {
    throw new HospitalCmDirectoryError(
      'DIRECTORY_RESOLUTION_INPUT_INVALID',
      400,
      '医院目录批量映射请求必须是数组',
    )
  }
  const inputs = rawInputs.map(normalizeDirectoryResolutionInput)
  if (inputs.length === 0) return []
  const directory = getCurrentHospitalCmDirectory(db)
  if (!directory) return inputs.map(() => null)
  const snapshot = buildInternalDirectoryResolverSnapshot(directory)
  return inputs.map(input => resolveWithInternalDirectorySnapshot(snapshot, input))
}

/** Single-record convenience API; ingestion callers should use the batch API. */
export function resolveHospitalCmDirectoryPartner(
  db: HospitalCmDirectoryDb,
  rawInput: unknown,
): HospitalCmDirectoryResolution | null {
  return resolveHospitalCmDirectoryPartners(db, [rawInput])[0] ?? null
}
