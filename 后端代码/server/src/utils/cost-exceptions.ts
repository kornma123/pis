import { v4 as uuidv4 } from 'uuid'
import { generateNo } from './generateNo.js'

export interface CostExceptionInput {
  sourceModule: string
  sourceType: string
  sourceId?: string | null
  projectId?: string | null
  bomId?: string | null
  outboundId?: string | null
  yearMonth?: string | null
  exceptionType: string
  severity?: 'info' | 'warning' | 'error'
  status?: 'open' | 'resolved' | 'ignored'
  message: string
  details?: unknown
}

export interface CostExceptionRecord {
  id: string
  exceptionNo: string
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch (_e) {
    return String(err)
  }
}

export function recordCostException(db: any, input: CostExceptionInput): CostExceptionRecord {
  const id = uuidv4()
  const exceptionNo = generateNo('CE')
  const details = input.details === undefined ? null : JSON.stringify(input.details)

  db.prepare(`
    INSERT INTO cost_exceptions (
      id, exception_no, source_module, source_type, source_id,
      project_id, bom_id, outbound_id, year_month,
      exception_type, severity, status, message, details
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    exceptionNo,
    input.sourceModule,
    input.sourceType,
    input.sourceId || null,
    input.projectId || null,
    input.bomId || null,
    input.outboundId || null,
    input.yearMonth || new Date().toISOString().slice(0, 7),
    input.exceptionType,
    input.severity || 'warning',
    input.status || 'open',
    input.message,
    details,
  )

  return { id, exceptionNo }
}
