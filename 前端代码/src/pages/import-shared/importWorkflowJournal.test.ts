import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearImportWorkflowJournal,
  readImportWorkflowJournal,
  writeImportWorkflowJournal,
} from './importWorkflowJournal'

describe('importWorkflowJournal', () => {
  beforeEach(() => window.sessionStorage.clear())

  it('round-trips only the minimal direct-inbound receipt in the current tab', () => {
    writeImportWorkflowJournal({
      version: 1,
      kind: 'direct-inbound',
      phase: 'settled',
      updatedAt: '2026-07-18T08:00:00.000Z',
      fileName: 'direct.csv',
      summary: { total: 2, succeeded: 1, failed: 0, validationRejected: 1 },
      receiptIds: ['IB-1'],
    })

    expect(readImportWorkflowJournal('direct-inbound')).toEqual({
      version: 1,
      kind: 'direct-inbound',
      phase: 'settled',
      updatedAt: '2026-07-18T08:00:00.000Z',
      fileName: 'direct.csv',
      summary: { total: 2, succeeded: 1, failed: 0, validationRejected: 1 },
      receiptIds: ['IB-1'],
    })
    const raw = window.sessionStorage.getItem('coreone.import-workflow.direct-inbound.v1') || ''
    expect(raw).not.toContain('grid')
    expect(raw).not.toContain('raw')
    expect(raw).not.toContain('payload')
  })

  it('keeps an interrupted submit as unknown instead of manufacturing a result', () => {
    writeImportWorkflowJournal({
      version: 1,
      kind: 'statement-import',
      phase: 'submitting',
      updatedAt: '2026-07-18T08:00:00.000Z',
      fileName: 'hospital.xlsx',
      partnerId: 'P-1',
      serviceMonth: '2026-06',
    })

    const journal = readImportWorkflowJournal('statement-import')
    expect(journal).toMatchObject({ phase: 'submitting' })
    expect(journal?.receipt).toBeUndefined()
    clearImportWorkflowJournal('statement-import')
    expect(readImportWorkflowJournal('statement-import')).toBeNull()
  })

  it('fails closed on corrupted or cross-kind storage', () => {
    window.sessionStorage.setItem('coreone.import-workflow.direct-inbound.v1', '{broken')
    expect(readImportWorkflowJournal('direct-inbound')).toBeNull()

    window.sessionStorage.setItem('coreone.import-workflow.direct-inbound.v1', JSON.stringify({
      version: 1,
      kind: 'statement-import',
      phase: 'settled',
    }))
    expect(readImportWorkflowJournal('direct-inbound')).toBeNull()
  })
})
