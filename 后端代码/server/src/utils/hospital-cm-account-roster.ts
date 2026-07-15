import { createHash, randomUUID } from 'node:crypto'

/**
 * D2/B0 only: this module stores unconfirmed snapshots supplied by one source.
 * A snapshot is NOT the final cross-source account-roster union and must never be
 * consumed as a readiness, coverage, measured, or business-authority conclusion.
 */
export const HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION =
  'hospital-cm.account-roster.candidate-source.v1'
export const HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE =
  'UNCONFIRMED_SINGLE_SOURCE_SNAPSHOT_NOT_AUTHORITATIVE_UNION'

const SERVICE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const SHA256_RE = /^[a-f0-9]{64}$/
const SAFE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SOURCE_KIND_RE = /^[A-Z0-9][A-Z0-9._:-]{0,63}$/
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/
const MAX_ROWS = 5_000

interface StatementLike {
  get: (...args: unknown[]) => unknown
  all: (...args: unknown[]) => unknown[]
  run: (...args: unknown[]) => unknown
}

export interface HospitalCmAccountRosterDb {
  prepare: (sql: string) => StatementLike
  exec: (sql: string) => unknown
}

export interface HospitalCmAccountRosterActor {
  userId: string
  username: string
}

export interface HospitalCmAccountRosterCandidateEntryInput {
  accountKey: string
  partnerId?: string | null
  sourceCooperationCode: string
  sourceActivityCode: string
}

export interface CreateHospitalCmAccountRosterCandidateInput {
  serviceMonth: string
  claimedSourceKind: string
  sourceVersion: string
  sourceEvidenceRef: string
  sourceEvidenceHash: string
  changeReason: string
  entries: HospitalCmAccountRosterCandidateEntryInput[]
  actor: HospitalCmAccountRosterActor
  idempotencyKey: string
}

export interface HospitalCmAccountRosterCandidateEntry {
  accountKey: string
  partnerId: string | null
  sourceCooperationCode: string
  sourceActivityCode: string
  rowHash: string
}

export interface HospitalCmAccountRosterCandidate {
  id: string
  eventNumber: number
  serviceMonth: string
  versionNumber: number
  version: string
  usage: typeof HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE
  contractVersion: typeof HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION
  claimedSourceKind: string
  sourceVersion: string
  sourceEvidenceRef: string
  sourceEvidenceHash: string
  rowCount: number
  contentHash: string
  supersedesVersionId: string | null
  changeReason: string
  createdByUserId: string
  createdByUsername: string
  createdAt: string
  entries: HospitalCmAccountRosterCandidateEntry[]
}

export type HospitalCmAccountRosterCandidateMetadata = Omit<HospitalCmAccountRosterCandidate, 'entries'>

export interface HospitalCmAccountRosterCandidatePage {
  serviceMonth: string
  claimedSourceKind: string
  usage: typeof HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE
  current: HospitalCmAccountRosterCandidateMetadata | null
  versions: HospitalCmAccountRosterCandidateMetadata[]
  pagination: { limit: number; nextCursor: number | null }
}

interface NormalizedCandidateInput extends Omit<CreateHospitalCmAccountRosterCandidateInput, 'entries'> {
  entries: HospitalCmAccountRosterCandidateEntry[]
  contentHash: string
  requestHash: string
}

interface VersionRow {
  id: string
  eventNumber: number
  serviceMonth: string
  versionNumber: number
  contractVersion: string
  claimedSourceKind: string
  sourceVersion: string
  sourceEvidenceRef: string
  sourceEvidenceHash: string
  rowCount: number
  contentHash: string
  supersedesVersionId: string | null
  changeReason: string
  createdByUserId: string
  createdByUsername: string
  createdAt: string
  rowKind?: 'CURRENT' | 'PAGE'
}

interface EntryRow {
  accountKey: string
  partnerId: string | null
  sourceCooperationCode: string
  sourceActivityCode: string
  rowHash: string
}

interface IdempotencyRow {
  actorUserId: string
  requestHash: string
  resultId: string
}

export class HospitalCmAccountRosterError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = 'HospitalCmAccountRosterError'
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

function requireText(value: unknown, code: string, label: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max || hasControlCharacter(normalized)) {
    throw new HospitalCmAccountRosterError(code, 400, `${label}缺失、过长或含控制字符`)
  }
  return normalized
}

function requireOpaqueAscii(value: unknown, code: string, label: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > max || !PRINTABLE_ASCII_RE.test(normalized)) {
    throw new HospitalCmAccountRosterError(code, 400, `${label}必须是长度受限的可打印 ASCII 标识`)
  }
  return normalized
}

function requireExactFields(value: unknown, allowed: readonly string[], code: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HospitalCmAccountRosterError(code, 400, `${label}格式无效`)
  }
  const object = value as Record<string, unknown>
  if (Object.keys(object).some(key => !allowed.includes(key))) {
    throw new HospitalCmAccountRosterError(code, 400, `${label}含未批准字段`)
  }
  return object
}

function normalizeServiceMonth(value: unknown): string {
  const month = typeof value === 'string' ? value.trim() : ''
  if (!SERVICE_MONTH_RE.test(month)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SERVICE_MONTH_INVALID',
      400,
      'serviceMonth 必须是合法 YYYY-MM',
    )
  }
  return month
}

function normalizeHash(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!SHA256_RE.test(normalized)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SOURCE_EVIDENCE_INVALID',
      400,
      'sourceEvidenceHash 必须是 64 位 SHA-256',
    )
  }
  return normalized
}

function normalizeClaimedSourceKind(value: unknown): string {
  const kind = requireOpaqueAscii(
    value,
    'ACCOUNT_ROSTER_SOURCE_KIND_INVALID',
    'claimedSourceKind',
    64,
  )
  if (!SOURCE_KIND_RE.test(kind)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SOURCE_KIND_INVALID',
      400,
      'claimedSourceKind 必须是大写的安全来源代码',
    )
  }
  return kind
}

function normalizeEvidenceRef(value: unknown): string {
  const ref = requireOpaqueAscii(
    value,
    'ACCOUNT_ROSTER_SOURCE_EVIDENCE_REF_INVALID',
    'sourceEvidenceRef',
    512,
  )
  if (!ref.startsWith('manifest://') || /[?#\\]/.test(ref)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SOURCE_EVIDENCE_REF_INVALID',
      400,
      'sourceEvidenceRef 只接受不含查询、片段或路径转义的 manifest:// 引用',
    )
  }
  const tail = ref.slice('manifest://'.length)
  const segments = tail.split('/')
  if (!tail || segments.some(segment => !segment || segment === '.' || segment === '..')
    || !segments.every(segment => /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(segment))) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SOURCE_EVIDENCE_REF_INVALID',
      400,
      'sourceEvidenceRef 必须是安全的 manifest:// 不透明引用',
    )
  }
  return ref
}

function normalizeActor(value: unknown): HospitalCmAccountRosterActor {
  const actor = requireExactFields(value, ['userId', 'username'], 'ACCOUNT_ROSTER_ACTOR_INVALID', 'actor')
  return {
    userId: requireText(actor.userId, 'ACCOUNT_ROSTER_ACTOR_INVALID', 'actor.userId', 128),
    username: requireText(actor.username, 'ACCOUNT_ROSTER_ACTOR_INVALID', 'actor.username', 128),
  }
}

function normalizeIdempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_IDEMPOTENCY_KEY_INVALID',
      400,
      '幂等键必须是 8~128 位安全字符',
    )
  }
  return key
}

function normalizeCandidateEntry(value: unknown): Omit<HospitalCmAccountRosterCandidateEntry, 'rowHash'> {
  const entry = requireExactFields(
    value,
    ['accountKey', 'partnerId', 'sourceCooperationCode', 'sourceActivityCode'],
    'ACCOUNT_ROSTER_ENTRY_FIELD_FORBIDDEN',
    '候选账户行',
  )
  const accountKey = typeof entry.accountKey === 'string' ? entry.accountKey.trim() : ''
  if (!SAFE_KEY_RE.test(accountKey)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_ACCOUNT_KEY_INVALID',
      400,
      'accountKey 必须是安全的不透明标识',
    )
  }
  const rawPartnerId = entry.partnerId
  if (rawPartnerId !== null && rawPartnerId !== undefined && typeof rawPartnerId !== 'string') {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_PARTNER_ID_INVALID',
      400,
      'partnerId 只接受字符串或 null',
    )
  }
  const partnerId = rawPartnerId === null || rawPartnerId === undefined ? null : rawPartnerId.trim()
  if (partnerId !== null && !SAFE_KEY_RE.test(partnerId)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_PARTNER_ID_INVALID',
      400,
      'partnerId 必须是安全的不透明标识',
    )
  }
  const sourceCooperationCode = typeof entry.sourceCooperationCode === 'string'
    ? entry.sourceCooperationCode.trim()
    : ''
  if (!SAFE_CODE_RE.test(sourceCooperationCode)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SOURCE_COOPERATION_CODE_INVALID',
      400,
      'sourceCooperationCode 必须是安全的来源原始代码',
    )
  }
  const sourceActivityCode = typeof entry.sourceActivityCode === 'string' ? entry.sourceActivityCode.trim() : ''
  if (!SAFE_CODE_RE.test(sourceActivityCode)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SOURCE_ACTIVITY_CODE_INVALID',
      400,
      'sourceActivityCode 必须是安全的来源原始代码',
    )
  }
  return { accountKey, partnerId, sourceCooperationCode, sourceActivityCode }
}

function rowHash(entry: Omit<HospitalCmAccountRosterCandidateEntry, 'rowHash'>): string {
  return sha256(entry)
}

function candidateContentHash(input: {
  serviceMonth: string
  claimedSourceKind: string
  sourceVersion: string
  sourceEvidenceHash: string
  entries: HospitalCmAccountRosterCandidateEntry[]
}): string {
  return sha256({
    contractVersion: HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION,
    serviceMonth: input.serviceMonth,
    claimedSourceKind: input.claimedSourceKind,
    sourceVersion: input.sourceVersion,
    sourceEvidenceHash: input.sourceEvidenceHash,
    rowHashes: input.entries.map(entry => entry.rowHash).sort(),
  })
}

function normalizeCandidateInput(value: unknown): NormalizedCandidateInput {
  const input = requireExactFields(
    value,
    [
      'serviceMonth',
      'claimedSourceKind',
      'sourceVersion',
      'sourceEvidenceRef',
      'sourceEvidenceHash',
      'changeReason',
      'entries',
      'actor',
      'idempotencyKey',
    ],
    'ACCOUNT_ROSTER_RESULT_INPUT_FORBIDDEN',
    '候选名册请求',
  )
  const serviceMonth = normalizeServiceMonth(input.serviceMonth)
  const claimedSourceKind = normalizeClaimedSourceKind(input.claimedSourceKind)
  const sourceVersion = requireOpaqueAscii(
    input.sourceVersion,
    'ACCOUNT_ROSTER_SOURCE_VERSION_INVALID',
    'sourceVersion',
    128,
  )
  if (!SAFE_KEY_RE.test(sourceVersion)) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_SOURCE_VERSION_INVALID',
      400,
      'sourceVersion 必须是安全的不透明标识',
    )
  }
  const sourceEvidenceRef = normalizeEvidenceRef(input.sourceEvidenceRef)
  const sourceEvidenceHash = normalizeHash(input.sourceEvidenceHash)
  const changeReason = requireText(input.changeReason, 'ACCOUNT_ROSTER_CHANGE_REASON_INVALID', 'changeReason', 500)
  const actor = normalizeActor(input.actor)
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  if (!Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > MAX_ROWS) {
    throw new HospitalCmAccountRosterError(
      'ACCOUNT_ROSTER_ENTRIES_INVALID',
      400,
      `entries 必须包含 1~${MAX_ROWS} 行`,
    )
  }
  const normalizedEntries = input.entries.map(normalizeCandidateEntry)
  const accountKeys = new Set<string>()
  const partnerIds = new Set<string>()
  for (const entry of normalizedEntries) {
    if (accountKeys.has(entry.accountKey)) {
      throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_ACCOUNT_DUPLICATE', 409, '候选名册含重复 accountKey')
    }
    accountKeys.add(entry.accountKey)
    if (entry.partnerId !== null) {
      if (partnerIds.has(entry.partnerId)) {
        throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_PARTNER_DUPLICATE', 409, '候选名册含重复 partnerId')
      }
      partnerIds.add(entry.partnerId)
    }
  }
  const entries = normalizedEntries
    .map(entry => ({ ...entry, rowHash: rowHash(entry) }))
    .sort((left, right) => left.accountKey < right.accountKey ? -1 : left.accountKey > right.accountKey ? 1 : 0)
  const contentHash = candidateContentHash({
    serviceMonth,
    claimedSourceKind,
    sourceVersion,
    sourceEvidenceHash,
    entries,
  })
  const requestHash = sha256({
    operation: 'CREATE_HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE',
    actorUserId: actor.userId,
    contentHash,
    sourceEvidenceRef,
    changeReason,
  })
  return {
    serviceMonth,
    claimedSourceKind,
    sourceVersion,
    sourceEvidenceRef,
    sourceEvidenceHash,
    changeReason,
    entries,
    actor,
    idempotencyKey,
    contentHash,
    requestHash,
  }
}

export function ensureHospitalCmAccountRosterSchema(db: HospitalCmAccountRosterDb): void {
  // Deliberately no PRAGMA here: schema setup must not mutate a production connection's semantics.
  db.exec(`
    CREATE TABLE IF NOT EXISTS hospital_cm_account_roster_candidate_versions (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      service_month TEXT NOT NULL CHECK (
        length(service_month) = 7
        AND service_month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
        AND substr(service_month, 6, 2) BETWEEN '01' AND '12'
      ),
      version_number INTEGER NOT NULL CHECK (version_number > 0),
      contract_version TEXT NOT NULL CHECK (
        contract_version = '${HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION}'
      ),
      claimed_source_kind TEXT NOT NULL CHECK (
        length(claimed_source_kind) BETWEEN 1 AND 64
        AND claimed_source_kind NOT GLOB '*[^A-Z0-9._:-]*'
      ),
      source_version TEXT NOT NULL CHECK (
        length(source_version) BETWEEN 1 AND 128
        AND source_version NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
      source_evidence_ref TEXT NOT NULL CHECK (
        length(source_evidence_ref) BETWEEN 12 AND 512
        AND source_evidence_ref GLOB 'manifest://?*'
      ),
      source_evidence_hash TEXT NOT NULL CHECK (
        length(source_evidence_hash) = 64
        AND source_evidence_hash NOT GLOB '*[^0-9a-f]*'
      ),
      row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND ${MAX_ROWS}),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64
        AND content_hash NOT GLOB '*[^0-9a-f]*'
      ),
      supersedes_version_id TEXT,
      change_reason TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_by_username TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (service_month, claimed_source_kind, version_number),
      UNIQUE (service_month, claimed_source_kind, content_hash),
      FOREIGN KEY (supersedes_version_id) REFERENCES hospital_cm_account_roster_candidate_versions(id)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_account_roster_candidate_entries (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      roster_version_id TEXT NOT NULL,
      account_key TEXT NOT NULL CHECK (
        length(account_key) BETWEEN 1 AND 128
        AND account_key NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
      partner_id TEXT CHECK (
        partner_id IS NULL OR (
          length(partner_id) BETWEEN 1 AND 128
          AND partner_id NOT GLOB '*[^A-Za-z0-9._:-]*'
        )
      ),
      source_cooperation_code TEXT NOT NULL CHECK (
        length(source_cooperation_code) BETWEEN 1 AND 64
        AND source_cooperation_code NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
      source_activity_code TEXT NOT NULL CHECK (
        length(source_activity_code) BETWEEN 1 AND 64
        AND source_activity_code NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
      row_hash TEXT NOT NULL CHECK (
        length(row_hash) = 64
        AND row_hash NOT GLOB '*[^0-9a-f]*'
      ),
      UNIQUE (roster_version_id, account_key),
      UNIQUE (roster_version_id, partner_id),
      FOREIGN KEY (roster_version_id) REFERENCES hospital_cm_account_roster_candidate_versions(id)
    );

    CREATE TABLE IF NOT EXISTS hospital_cm_account_roster_candidate_idempotency (
      event_number INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE CHECK (
        length(idempotency_key) BETWEEN 8 AND 128
        AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
      ),
      operation TEXT NOT NULL CHECK (operation = 'CREATE_CANDIDATE'),
      actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
      request_hash TEXT NOT NULL CHECK (
        length(request_hash) = 64
        AND request_hash NOT GLOB '*[^0-9a-f]*'
      ),
      result_id TEXT NOT NULL CHECK (length(result_id) = 36),
      created_at TEXT NOT NULL,
      FOREIGN KEY (result_id) REFERENCES hospital_cm_account_roster_candidate_versions(id)
    );

    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_version_sequence
    BEFORE INSERT ON hospital_cm_account_roster_candidate_versions
    WHEN NEW.version_number <> COALESCE((
      SELECT MAX(version_number) + 1
      FROM hospital_cm_account_roster_candidate_versions
      WHERE service_month = NEW.service_month
        AND claimed_source_kind = NEW.claimed_source_kind
    ), 1)
      OR (NEW.version_number = 1 AND NEW.supersedes_version_id IS NOT NULL)
      OR (NEW.version_number > 1 AND NEW.supersedes_version_id IS NOT (
        SELECT id FROM hospital_cm_account_roster_candidate_versions
        WHERE service_month = NEW.service_month
          AND claimed_source_kind = NEW.claimed_source_kind
        ORDER BY version_number DESC LIMIT 1
      ))
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_VERSION_SEQUENCE_INVALID');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_versions_no_duplicate_insert
    BEFORE INSERT ON hospital_cm_account_roster_candidate_versions
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_account_roster_candidate_versions
      WHERE event_number = NEW.event_number
         OR id = NEW.id
         OR (service_month = NEW.service_month
             AND claimed_source_kind = NEW.claimed_source_kind
             AND version_number = NEW.version_number)
         OR (service_month = NEW.service_month
             AND claimed_source_kind = NEW.claimed_source_kind
             AND content_hash = NEW.content_hash)
    )
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_VERSION_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_versions_no_update
    BEFORE UPDATE ON hospital_cm_account_roster_candidate_versions
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_VERSION_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_versions_no_delete
    BEFORE DELETE ON hospital_cm_account_roster_candidate_versions
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_VERSION_APPEND_ONLY');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_entries_require_header
    BEFORE INSERT ON hospital_cm_account_roster_candidate_entries
    WHEN NOT EXISTS (
      SELECT 1 FROM hospital_cm_account_roster_candidate_versions WHERE id = NEW.roster_version_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_HEADER_MISSING');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_entries_sealed
    BEFORE INSERT ON hospital_cm_account_roster_candidate_entries
    WHEN (
      SELECT COUNT(*) FROM hospital_cm_account_roster_candidate_entries
      WHERE roster_version_id = NEW.roster_version_id
    ) >= (
      SELECT row_count FROM hospital_cm_account_roster_candidate_versions
      WHERE id = NEW.roster_version_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_VERSION_SEALED');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_entries_no_duplicate_insert
    BEFORE INSERT ON hospital_cm_account_roster_candidate_entries
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_account_roster_candidate_entries
      WHERE event_number = NEW.event_number
         OR (roster_version_id = NEW.roster_version_id AND account_key = NEW.account_key)
         OR (NEW.partner_id IS NOT NULL AND roster_version_id = NEW.roster_version_id AND partner_id = NEW.partner_id)
    )
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_ENTRY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_entries_no_update
    BEFORE UPDATE ON hospital_cm_account_roster_candidate_entries
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_ENTRY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_entries_no_delete
    BEFORE DELETE ON hospital_cm_account_roster_candidate_entries
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_ENTRY_APPEND_ONLY');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_idempotency_no_duplicate_insert
    BEFORE INSERT ON hospital_cm_account_roster_candidate_idempotency
    WHEN EXISTS (
      SELECT 1 FROM hospital_cm_account_roster_candidate_idempotency
      WHERE event_number = NEW.event_number
         OR idempotency_key = NEW.idempotency_key
    )
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_IDEMPOTENCY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_idempotency_require_result
    BEFORE INSERT ON hospital_cm_account_roster_candidate_idempotency
    WHEN NOT EXISTS (
      SELECT 1 FROM hospital_cm_account_roster_candidate_versions WHERE id = NEW.result_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_RESULT_MISSING');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_idempotency_no_update
    BEFORE UPDATE ON hospital_cm_account_roster_candidate_idempotency
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_IDEMPOTENCY_APPEND_ONLY');
    END;
    CREATE TRIGGER IF NOT EXISTS trg_hcm_account_roster_candidate_idempotency_no_delete
    BEFORE DELETE ON hospital_cm_account_roster_candidate_idempotency
    BEGIN
      SELECT RAISE(ABORT, 'ACCOUNT_ROSTER_CANDIDATE_IDEMPOTENCY_APPEND_ONLY');
    END;
  `)
}

function versionLabel(serviceMonth: string, claimedSourceKind: string, versionNumber: number): string {
  return `${serviceMonth}.${claimedSourceKind}.candidate.v${versionNumber}`
}

function metadataFromRow(row: VersionRow): HospitalCmAccountRosterCandidateMetadata {
  return {
    id: row.id,
    eventNumber: Number(row.eventNumber),
    serviceMonth: row.serviceMonth,
    versionNumber: Number(row.versionNumber),
    version: versionLabel(row.serviceMonth, row.claimedSourceKind, Number(row.versionNumber)),
    usage: HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE,
    contractVersion: HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION,
    claimedSourceKind: row.claimedSourceKind,
    sourceVersion: row.sourceVersion,
    sourceEvidenceRef: row.sourceEvidenceRef,
    sourceEvidenceHash: row.sourceEvidenceHash,
    rowCount: Number(row.rowCount),
    contentHash: row.contentHash,
    supersedesVersionId: row.supersedesVersionId,
    changeReason: row.changeReason,
    createdByUserId: row.createdByUserId,
    createdByUsername: row.createdByUsername,
    createdAt: row.createdAt,
  }
}

const VERSION_SELECT = `
  SELECT
    id,
    event_number AS eventNumber,
    service_month AS serviceMonth,
    version_number AS versionNumber,
    contract_version AS contractVersion,
    claimed_source_kind AS claimedSourceKind,
    source_version AS sourceVersion,
    source_evidence_ref AS sourceEvidenceRef,
    source_evidence_hash AS sourceEvidenceHash,
    row_count AS rowCount,
    content_hash AS contentHash,
    supersedes_version_id AS supersedesVersionId,
    change_reason AS changeReason,
    created_by_user_id AS createdByUserId,
    created_by_username AS createdByUsername,
    created_at AS createdAt
  FROM hospital_cm_account_roster_candidate_versions
`

function validateCandidateIntegrity(candidate: HospitalCmAccountRosterCandidate): void {
  if (candidate.contractVersion !== HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION
    || candidate.rowCount !== candidate.entries.length) {
    throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_CANDIDATE_CORRUPT', 500, '候选名册版本完整性校验失败')
  }
  for (const entry of candidate.entries) {
    const expected = rowHash({
      accountKey: entry.accountKey,
      partnerId: entry.partnerId,
      sourceCooperationCode: entry.sourceCooperationCode,
      sourceActivityCode: entry.sourceActivityCode,
    })
    if (entry.rowHash !== expected) {
      throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_CANDIDATE_CORRUPT', 500, '候选名册行完整性校验失败')
    }
  }
  const expectedContentHash = candidateContentHash(candidate)
  if (candidate.contentHash !== expectedContentHash) {
    throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_CANDIDATE_CORRUPT', 500, '候选名册内容完整性校验失败')
  }
}

export function getHospitalCmAccountRosterCandidate(
  db: HospitalCmAccountRosterDb,
  id: string,
): HospitalCmAccountRosterCandidate | null {
  const row = db.prepare(`${VERSION_SELECT} WHERE id = ?`).get(id) as VersionRow | undefined
  if (!row) return null
  const entries = db.prepare(`
    SELECT
      account_key AS accountKey,
      partner_id AS partnerId,
      source_cooperation_code AS sourceCooperationCode,
      source_activity_code AS sourceActivityCode,
      row_hash AS rowHash
    FROM hospital_cm_account_roster_candidate_entries
    WHERE roster_version_id = ?
    ORDER BY account_key ASC
  `).all(id) as EntryRow[]
  const candidate = { ...metadataFromRow(row), entries }
  validateCandidateIntegrity(candidate)
  return candidate
}

export function createHospitalCmAccountRosterCandidate(
  db: HospitalCmAccountRosterDb,
  rawInput: unknown,
): HospitalCmAccountRosterCandidate {
  const input = normalizeCandidateInput(rawInput)
  db.exec('BEGIN IMMEDIATE')
  try {
    const idempotency = db.prepare(`
      SELECT actor_user_id AS actorUserId, request_hash AS requestHash, result_id AS resultId
      FROM hospital_cm_account_roster_candidate_idempotency
      WHERE idempotency_key = ?
    `).get(input.idempotencyKey) as IdempotencyRow | undefined
    if (idempotency) {
      if (idempotency.actorUserId !== input.actor.userId || idempotency.requestHash !== input.requestHash) {
        throw new HospitalCmAccountRosterError(
          'ACCOUNT_ROSTER_IDEMPOTENCY_CONFLICT',
          409,
          '幂等键已绑定不同请求，请为新操作生成新的安全幂等键',
        )
      }
      const replay = getHospitalCmAccountRosterCandidate(db, idempotency.resultId)
      if (!replay) {
        throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_CANDIDATE_CORRUPT', 500, '幂等结果缺失')
      }
      db.exec('COMMIT')
      return replay
    }

    const sameContent = db.prepare(`
      SELECT id FROM hospital_cm_account_roster_candidate_versions
      WHERE service_month = ? AND claimed_source_kind = ? AND content_hash = ?
    `).get(input.serviceMonth, input.claimedSourceKind, input.contentHash) as { id: string } | undefined
    if (sameContent) {
      const existing = getHospitalCmAccountRosterCandidate(db, sameContent.id)
      if (!existing) {
        throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_CANDIDATE_CORRUPT', 500, '同内容候选版本缺失')
      }
      db.prepare(`
        INSERT INTO hospital_cm_account_roster_candidate_idempotency
          (idempotency_key, operation, actor_user_id, request_hash, result_id, created_at)
        VALUES (?, 'CREATE_CANDIDATE', ?, ?, ?, ?)
      `).run(input.idempotencyKey, input.actor.userId, input.requestHash, existing.id, new Date().toISOString())
      db.exec('COMMIT')
      return existing
    }

    const previous = db.prepare(`
      SELECT id, version_number AS versionNumber
      FROM hospital_cm_account_roster_candidate_versions
      WHERE service_month = ? AND claimed_source_kind = ?
      ORDER BY version_number DESC LIMIT 1
    `).get(input.serviceMonth, input.claimedSourceKind) as { id: string; versionNumber: number } | undefined
    const versionNumber = previous ? Number(previous.versionNumber) + 1 : 1
    const id = randomUUID()
    const createdAt = new Date().toISOString()

    // Header first; entries remain insertable only until the declared row_count is reached.
    db.prepare(`
      INSERT INTO hospital_cm_account_roster_candidate_versions (
        id, service_month, version_number, contract_version, claimed_source_kind,
        source_version, source_evidence_ref, source_evidence_hash, row_count,
        content_hash, supersedes_version_id, change_reason, created_by_user_id,
        created_by_username, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.serviceMonth,
      versionNumber,
      HOSPITAL_CM_ACCOUNT_ROSTER_CONTRACT_VERSION,
      input.claimedSourceKind,
      input.sourceVersion,
      input.sourceEvidenceRef,
      input.sourceEvidenceHash,
      input.entries.length,
      input.contentHash,
      previous?.id ?? null,
      input.changeReason,
      input.actor.userId,
      input.actor.username,
      createdAt,
    )
    const insertEntry = db.prepare(`
      INSERT INTO hospital_cm_account_roster_candidate_entries (
        roster_version_id, account_key, partner_id, source_cooperation_code,
        source_activity_code, row_hash
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const entry of input.entries) {
      insertEntry.run(
        id,
        entry.accountKey,
        entry.partnerId,
        entry.sourceCooperationCode,
        entry.sourceActivityCode,
        entry.rowHash,
      )
    }

    // Minimal audit evidence only: never duplicate row identifiers, source paths, reason, month, or version.
    db.prepare(`
      INSERT INTO abc_audit_logs (id, module, action, target_id, detail, operator)
      VALUES (?, 'hospital_cm_account_roster', 'candidate_snapshot_created', ?, ?, ?)
    `).run(randomUUID(), id, JSON.stringify({
      candidateOnly: true,
      claimedSourceKind: input.claimedSourceKind,
      sourceEvidenceHash: input.sourceEvidenceHash,
      rowCount: input.entries.length,
      contentHash: input.contentHash,
    }), input.actor.username)

    db.prepare(`
      INSERT INTO hospital_cm_account_roster_candidate_idempotency
        (idempotency_key, operation, actor_user_id, request_hash, result_id, created_at)
      VALUES (?, 'CREATE_CANDIDATE', ?, ?, ?, ?)
    `).run(input.idempotencyKey, input.actor.userId, input.requestHash, id, createdAt)

    // Read-back and hashes are validated inside the transaction; any failure rolls back all writes.
    const created = getHospitalCmAccountRosterCandidate(db, id)
    if (!created) {
      throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_CANDIDATE_CORRUPT', 500, '候选名册事务内回读失败')
    }
    db.exec('COMMIT')
    return created
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve the original failure if SQLite already closed the transaction.
    }
    throw error
  }
}

export function listHospitalCmAccountRosterCandidates(
  db: HospitalCmAccountRosterDb,
  rawServiceMonth: unknown,
  rawClaimedSourceKind: unknown,
  page: { limit?: number; beforeEvent?: number } = {},
): HospitalCmAccountRosterCandidatePage {
  const serviceMonth = normalizeServiceMonth(rawServiceMonth)
  const claimedSourceKind = normalizeClaimedSourceKind(rawClaimedSourceKind)
  const limit = page.limit ?? 50
  const beforeEvent = page.beforeEvent ?? null
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || (beforeEvent !== null && (!Number.isInteger(beforeEvent) || beforeEvent < 1))) {
    throw new HospitalCmAccountRosterError('ACCOUNT_ROSTER_PAGE_INVALID', 400, '分页参数无效')
  }
  const rows = db.prepare(`
    WITH current_row AS (
      SELECT 'CURRENT' AS rowKind, *
      FROM hospital_cm_account_roster_candidate_versions
      WHERE service_month = ? AND claimed_source_kind = ?
      ORDER BY version_number DESC LIMIT 1
    ), page_rows AS (
      SELECT 'PAGE' AS rowKind, *
      FROM hospital_cm_account_roster_candidate_versions
      WHERE service_month = ? AND claimed_source_kind = ? AND (? IS NULL OR event_number < ?)
      ORDER BY event_number DESC LIMIT ?
    )
    SELECT
      rowKind,
      id,
      event_number AS eventNumber,
      service_month AS serviceMonth,
      version_number AS versionNumber,
      contract_version AS contractVersion,
      claimed_source_kind AS claimedSourceKind,
      source_version AS sourceVersion,
      source_evidence_ref AS sourceEvidenceRef,
      source_evidence_hash AS sourceEvidenceHash,
      row_count AS rowCount,
      content_hash AS contentHash,
      supersedes_version_id AS supersedesVersionId,
      change_reason AS changeReason,
      created_by_user_id AS createdByUserId,
      created_by_username AS createdByUsername,
      created_at AS createdAt
    FROM current_row
    UNION ALL
    SELECT
      rowKind,
      id,
      event_number AS eventNumber,
      service_month AS serviceMonth,
      version_number AS versionNumber,
      contract_version AS contractVersion,
      claimed_source_kind AS claimedSourceKind,
      source_version AS sourceVersion,
      source_evidence_ref AS sourceEvidenceRef,
      source_evidence_hash AS sourceEvidenceHash,
      row_count AS rowCount,
      content_hash AS contentHash,
      supersedes_version_id AS supersedesVersionId,
      change_reason AS changeReason,
      created_by_user_id AS createdByUserId,
      created_by_username AS createdByUsername,
      created_at AS createdAt
    FROM page_rows
  `).all(
    serviceMonth,
    claimedSourceKind,
    serviceMonth,
    claimedSourceKind,
    beforeEvent,
    beforeEvent,
    limit + 1,
  ) as VersionRow[]

  const currentRow = rows.find(row => row.rowKind === 'CURRENT')
  const pageRows = rows.filter(row => row.rowKind === 'PAGE')
  const visibleRows = pageRows.slice(0, limit)
  return {
    serviceMonth,
    claimedSourceKind,
    usage: HOSPITAL_CM_ACCOUNT_ROSTER_CANDIDATE_USAGE,
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
