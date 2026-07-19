export type ImportWorkflowKind = 'direct-inbound' | 'statement-import'
export type ImportWorkflowPhase = 'submitting' | 'needs-confirmation' | 'settled' | 'failed'

export interface DirectInboundReceiptSummary {
  total: number
  succeeded: number
  failed: number
  validationRejected: number
}

interface JournalBase {
  version: 1
  kind: ImportWorkflowKind
  phase: ImportWorkflowPhase
  updatedAt: string
  fileName: string
}

export interface DirectInboundWorkflowJournal extends JournalBase {
  kind: 'direct-inbound'
  phase: 'submitting' | 'settled'
  summary: DirectInboundReceiptSummary
  receiptIds?: string[]
}

export interface StatementImportWorkflowJournal extends JournalBase {
  kind: 'statement-import'
  partnerId: string
  serviceMonth: string
  receipt?: {
    importBatch: string
    caseCount: number
  }
}

export type ImportWorkflowJournal = DirectInboundWorkflowJournal | StatementImportWorkflowJournal

const STORAGE_KEYS: Record<ImportWorkflowKind, string> = {
  'direct-inbound': 'coreone.import-workflow.direct-inbound.v1',
  'statement-import': 'coreone.import-workflow.statement-import.v1',
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function sanitizeJournal(value: unknown): ImportWorkflowJournal | null {
  if (!value || typeof value !== 'object') return null
  const source = value as Record<string, unknown>
  if (source.version !== 1) return null
  const kind = source.kind
  const phase = source.phase
  const updatedAt = nonEmptyString(source.updatedAt)
  const fileName = nonEmptyString(source.fileName)
  if ((kind !== 'direct-inbound' && kind !== 'statement-import') || !updatedAt || !fileName) return null

  if (kind === 'direct-inbound') {
    if (phase !== 'submitting' && phase !== 'settled') return null
    if (!source.summary || typeof source.summary !== 'object') return null
    const summarySource = source.summary as Record<string, unknown>
    const total = finiteCount(summarySource.total)
    const succeeded = finiteCount(summarySource.succeeded)
    const failed = finiteCount(summarySource.failed)
    const validationRejected = finiteCount(summarySource.validationRejected)
    if (total === null || succeeded === null || failed === null || validationRejected === null) return null
    if (succeeded + failed + validationRejected > total) return null
    const receiptIds = Array.isArray(source.receiptIds)
      ? source.receiptIds.map(nonEmptyString).filter((id): id is string => Boolean(id)).slice(0, 1000)
      : undefined
    return {
      version: 1,
      kind,
      phase,
      updatedAt,
      fileName,
      summary: { total, succeeded, failed, validationRejected },
      ...(receiptIds?.length ? { receiptIds } : {}),
    }
  }

  if (!['submitting', 'needs-confirmation', 'settled', 'failed'].includes(String(phase))) return null
  const partnerId = nonEmptyString(source.partnerId)
  const serviceMonth = nonEmptyString(source.serviceMonth)
  if (!partnerId || !serviceMonth) return null
  let receipt: StatementImportWorkflowJournal['receipt']
  if (source.receipt && typeof source.receipt === 'object') {
    const receiptSource = source.receipt as Record<string, unknown>
    const importBatch = nonEmptyString(receiptSource.importBatch)
    const caseCount = finiteCount(receiptSource.caseCount)
    if (!importBatch || caseCount === null) return null
    receipt = { importBatch, caseCount }
  }
  if (phase === 'settled' && !receipt) return null
  return {
    version: 1,
    kind,
    phase: phase as StatementImportWorkflowJournal['phase'],
    updatedAt,
    fileName,
    partnerId,
    serviceMonth,
    ...(receipt ? { receipt } : {}),
  }
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function writeImportWorkflowJournal(journal: ImportWorkflowJournal): void {
  const safe = sanitizeJournal(journal)
  const target = storage()
  if (!safe || !target) return
  try {
    target.setItem(STORAGE_KEYS[safe.kind], JSON.stringify(safe))
  } catch {
    // Storage can be unavailable in hardened/private contexts; workflow remains usable in memory.
  }
}

export function readImportWorkflowJournal<T extends ImportWorkflowKind>(kind: T): Extract<ImportWorkflowJournal, { kind: T }> | null {
  const target = storage()
  if (!target) return null
  try {
    const raw = target.getItem(STORAGE_KEYS[kind])
    if (!raw) return null
    const safe = sanitizeJournal(JSON.parse(raw))
    return safe?.kind === kind ? safe as Extract<ImportWorkflowJournal, { kind: T }> : null
  } catch {
    return null
  }
}

export function clearImportWorkflowJournal(kind: ImportWorkflowKind): void {
  try {
    storage()?.removeItem(STORAGE_KEYS[kind])
  } catch {
    // Clearing a non-essential recovery hint must not block the live workflow.
  }
}
