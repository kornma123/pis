import { createHash } from 'node:crypto'
import {
  CM_MARGIN_FOR_VARLABOR,
  CM_TARGET,
  CM_THRESHOLDS,
  currentHospitalCmFormulaBehaviorArtifact,
  HOSPITAL_CM_FORMULA_VERSION,
  P0_ANTIBODY_ADVICE_TYPES,
  P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK,
  SECONDARY_PER_SLIDE_DEFAULT,
} from './hospital-cm.js'
import { DEFAULT_IHC_COST_PARAMS, DIAGNOSIS_ANCHOR_DEFAULT } from './antibody-cost.js'
import {
  DEFAULT_READINESS_OWNER,
  READINESS_FOUNDATION_GATES,
  READINESS_MIN_CLOSED_PERIODS,
  READINESS_PARAM_VERSION,
  REVIVAL_ACCOUNT_CAP,
  REVIVAL_UNMEASURED_SHARE,
  type FoundationGate,
} from './portfolio-health.js'
import { SPLIT_DIAG_FEE, SPLIT_FORMULA_VERSION } from './statement-revenue.js'

export const HOSPITAL_CM_FOUNDATION_PROBE_VERSION = '2026-07-12.a'
export const HOSPITAL_CM_READINESS_SOURCE_TABLES = [
  'materials',
  'inventory',
  'batches',
  'case_revenue',
  'lis_cases',
  'lis_case_markers',
  'antibodies',
  'antibody_aliases',
  'ihc_cost_params',
  'special_stain_kits',
] as const
export type HospitalCmReadinessSourceTable = (typeof HOSPITAL_CM_READINESS_SOURCE_TABLES)[number]

export interface FoundationProbeDb {
  prepare: (sql: string) => {
    get: (...args: unknown[]) => unknown
    all: (...args: unknown[]) => unknown[]
  }
}

export interface HospitalCmFoundationProbeCheck {
  key: FoundationGate
  met: boolean
  status: 'passed' | 'failed' | 'error'
  resultCode: string
  summary: Record<string, unknown>
  inputFingerprint: string
}

export interface HospitalCmReadinessSourceState {
  revisions: Record<HospitalCmReadinessSourceTable, number>
  schemaSql: Record<HospitalCmReadinessSourceTable, string>
  inventorySchemaFingerprint: string
  periodSchemaFingerprint: string
  costDataSchemaFingerprint: string
  constantFingerprint: string
  stateFingerprint: string
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function numberOf(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

export function readHospitalCmReadinessSourceState(db: FoundationProbeDb): HospitalCmReadinessSourceState {
  const revisionRows = db.prepare(`
    SELECT source_key AS sourceKey, revision
    FROM hospital_cm_readiness_source_revisions
    ORDER BY source_key
  `).all() as Array<{ sourceKey: HospitalCmReadinessSourceTable; revision: number }>
  if (revisionRows.length !== HOSPITAL_CM_READINESS_SOURCE_TABLES.length) {
    throw new Error('READINESS_SOURCE_REVISION_INCOMPLETE')
  }
  const revisions = Object.fromEntries(HOSPITAL_CM_READINESS_SOURCE_TABLES.map((source) => [source, 0])) as Record<HospitalCmReadinessSourceTable, number>
  for (const row of revisionRows) {
    if (!HOSPITAL_CM_READINESS_SOURCE_TABLES.includes(row.sourceKey) || !Number.isInteger(Number(row.revision)) || Number(row.revision) < 0) {
      throw new Error('READINESS_SOURCE_REVISION_INVALID')
    }
    revisions[row.sourceKey] = numberOf(row.revision)
  }

  const schemaRows = db.prepare(`
    SELECT name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('materials','inventory','batches','case_revenue','lis_cases','lis_case_markers',
                   'antibodies','antibody_aliases','ihc_cost_params','special_stain_kits')
    ORDER BY name
  `).all() as Array<{ name: HospitalCmReadinessSourceTable; sql: string }>
  const schemaSql = Object.fromEntries(HOSPITAL_CM_READINESS_SOURCE_TABLES.map((source) => [source, ''])) as Record<HospitalCmReadinessSourceTable, string>
  for (const row of schemaRows) {
    if (HOSPITAL_CM_READINESS_SOURCE_TABLES.includes(row.name)) schemaSql[row.name] = String(row.sql ?? '')
  }
  const inventorySchemaFingerprint = sha256(['materials', 'inventory', 'batches'].map((name) => ({ name, sql: schemaSql[name as HospitalCmReadinessSourceTable] })))
  const periodSchemaFingerprint = sha256(['case_revenue', 'lis_cases', 'lis_case_markers'].map((name) => ({ name, sql: schemaSql[name as HospitalCmReadinessSourceTable] })))
  const costDataSchemaFingerprint = sha256(['antibodies', 'antibody_aliases', 'ihc_cost_params', 'special_stain_kits'].map((name) => ({ name, sql: schemaSql[name as HospitalCmReadinessSourceTable] })))
  const constantFingerprint = sha256(currentHospitalCmConstantManifest())
  return {
    revisions,
    schemaSql,
    inventorySchemaFingerprint,
    periodSchemaFingerprint,
    costDataSchemaFingerprint,
    constantFingerprint,
    stateFingerprint: sha256({ revisions, inventorySchemaFingerprint, periodSchemaFingerprint, costDataSchemaFingerprint, constantFingerprint }),
  }
}

function errorCheck(key: FoundationGate, resultCode = 'SOURCE_TABLE_MISSING'): HospitalCmFoundationProbeCheck {
  const summary = { evidenceScope: 'aggregate_only', error: resultCode }
  return {
    key,
    met: false,
    status: 'error',
    resultCode,
    summary,
    inputFingerprint: sha256({ key, resultCode, probeVersion: HOSPITAL_CM_FOUNDATION_PROBE_VERSION }),
  }
}

function probeInventoryConservation(db: FoundationProbeDb, sourceState: HospitalCmReadinessSourceState): HospitalCmFoundationProbeCheck {
  const key: FoundationGate = 'inventory_conservation'
  try {
    const raw = db.prepare(`
      WITH batch_totals AS (
        SELECT material_id,
               SUM(CASE WHEN status = 1 THEN COALESCE(remaining, 0) ELSE 0 END) AS active_remaining
        FROM batches
        GROUP BY material_id
      ),
      ledger AS (
        SELECT i.material_id,
               COALESCE(i.stock, 0) AS stock,
               COALESCE(bt.active_remaining, 0) AS batch_remaining
        FROM inventory i
        JOIN materials m ON m.id = i.material_id AND m.is_deleted = 0 AND m.status = 1
        LEFT JOIN batch_totals bt ON bt.material_id = i.material_id
      )
      SELECT
        (SELECT COUNT(*) FROM materials WHERE is_deleted = 0 AND status = 1) AS activeMaterialRows,
        COUNT(*) AS ledgerRows,
        (SELECT COUNT(*)
           FROM materials m
           LEFT JOIN inventory i ON i.material_id = m.id
          WHERE m.is_deleted = 0 AND m.status = 1 AND i.material_id IS NULL) AS missingInventoryRows,
        (SELECT COUNT(*)
           FROM inventory
          WHERE typeof(stock) NOT IN ('integer', 'real')
             OR stock >= 1e999
             OR stock <= -1e999) AS nonFiniteInventoryRows,
        COALESCE(SUM(CASE WHEN stock < -0.0001 THEN 1 ELSE 0 END), 0) AS negativeInventoryRows,
        COALESCE(SUM(CASE WHEN ABS(stock - batch_remaining) > 0.0001 THEN 1 ELSE 0 END), 0) AS driftRows,
        COALESCE(SUM(stock), 0) AS inventoryTotal,
        COALESCE(SUM(batch_remaining), 0) AS activeBatchTotal,
        (SELECT COUNT(*)
           FROM batches
          WHERE status = 1
            AND (typeof(remaining) NOT IN ('integer', 'real')
              OR remaining >= 1e999
              OR remaining <= -1e999)) AS nonFiniteBatchRows,
        (SELECT COUNT(*) FROM batches WHERE status = 1 AND COALESCE(remaining, 0) < -0.0001) AS negativeBatchRows,
        (SELECT COUNT(*)
           FROM batches b
           LEFT JOIN materials m ON m.id = b.material_id
           LEFT JOIN inventory i ON i.material_id = b.material_id
          WHERE b.status = 1
            AND ABS(COALESCE(b.remaining, 0)) > 0.0001
            AND (m.id IS NULL OR m.is_deleted <> 0 OR m.status <> 1 OR i.material_id IS NULL)) AS orphanBatchRows,
        (SELECT COUNT(*)
           FROM inventory i
           LEFT JOIN materials m ON m.id = i.material_id
          WHERE ABS(COALESCE(i.stock, 0)) > 0.0001
            AND (m.id IS NULL OR m.is_deleted <> 0 OR m.status <> 1)) AS orphanInventoryRows,
        (SELECT COALESCE(MAX(updated_at), '') FROM inventory) AS inventoryWatermark,
        (SELECT COALESCE(MAX(updated_at), '') FROM batches) AS batchWatermark,
        (SELECT COALESCE(SUM(LENGTH(id) + LENGTH(material_id)), 0) FROM inventory) AS inventoryIdentityMass,
        (SELECT COALESCE(SUM(LENGTH(id) + LENGTH(material_id) + LENGTH(batch_no)), 0) FROM batches) AS batchIdentityMass
      FROM ledger
    `).get() as Record<string, unknown> | undefined

    if (!raw) return errorCheck(key, 'PROBE_QUERY_EMPTY')
    const summary = {
      evidenceScope: 'aggregate_only',
      activeMaterialRows: numberOf(raw.activeMaterialRows),
      ledgerRows: numberOf(raw.ledgerRows),
      missingInventoryRows: numberOf(raw.missingInventoryRows),
      nonFiniteInventoryRows: numberOf(raw.nonFiniteInventoryRows),
      nonFiniteBatchRows: numberOf(raw.nonFiniteBatchRows),
      negativeInventoryRows: numberOf(raw.negativeInventoryRows),
      negativeBatchRows: numberOf(raw.negativeBatchRows),
      orphanBatchRows: numberOf(raw.orphanBatchRows),
      orphanInventoryRows: numberOf(raw.orphanInventoryRows),
      driftRows: numberOf(raw.driftRows),
      inventoryTotal: numberOf(raw.inventoryTotal),
      activeBatchTotal: numberOf(raw.activeBatchTotal),
      sourceRevisions: {
        materials: sourceState.revisions.materials,
        inventory: sourceState.revisions.inventory,
        batches: sourceState.revisions.batches,
      },
      schemaFingerprint: sourceState.inventorySchemaFingerprint,
    }
    const fingerprintInput = {
      ...summary,
      inventoryWatermark: String(raw.inventoryWatermark ?? ''),
      batchWatermark: String(raw.batchWatermark ?? ''),
      inventoryIdentityMass: numberOf(raw.inventoryIdentityMass),
      batchIdentityMass: numberOf(raw.batchIdentityMass),
      probeVersion: HOSPITAL_CM_FOUNDATION_PROBE_VERSION,
    }

    let resultCode = 'PASSED'
    if (summary.activeMaterialRows === 0 || summary.ledgerRows === 0) resultCode = 'EMPTY_INVENTORY_BASELINE'
    else if (summary.missingInventoryRows > 0) resultCode = 'MISSING_INVENTORY_BASELINE'
    else if (summary.nonFiniteInventoryRows > 0 || summary.nonFiniteBatchRows > 0) resultCode = 'NON_FINITE_INVENTORY_FACT'
    else if (summary.negativeInventoryRows > 0 || summary.negativeBatchRows > 0) resultCode = 'NEGATIVE_INVENTORY_FACT'
    else if (summary.orphanBatchRows > 0 || summary.orphanInventoryRows > 0) resultCode = 'ORPHAN_INVENTORY_FACT'
    else if (summary.driftRows > 0) resultCode = 'LEDGER_DRIFT'
    const met = resultCode === 'PASSED'
    return {
      key,
      met,
      status: met ? 'passed' : 'failed',
      resultCode,
      summary,
      inputFingerprint: sha256(fingerprintInput),
    }
  } catch {
    return errorCheck(key)
  }
}

const PERIOD_TABLES = ['case_revenue', 'lis_cases', 'lis_case_markers'] as const
const PERIOD_REQUIRED_COLUMNS: Record<(typeof PERIOD_TABLES)[number], readonly string[]> = {
  case_revenue: ['partner_id', 'case_no', 'service_month'],
  lis_cases: ['partner_id', 'case_no'],
  lis_case_markers: ['partner_id', 'case_no'],
}

function hasSqlIdentifier(sql: string, identifier: string): boolean {
  return new RegExp(`\\b${identifier}\\b`, 'i').test(sql)
}

function probePeriodKey(db: FoundationProbeDb, sourceState: HospitalCmReadinessSourceState): HospitalCmFoundationProbeCheck {
  const key: FoundationGate = 'period_key'
  try {
    const missingTables = PERIOD_TABLES.filter((table) => !sourceState.schemaSql[table])
    const missingColumns = PERIOD_TABLES.flatMap((table) => {
      const sql = sourceState.schemaSql[table] ?? ''
      return PERIOD_REQUIRED_COLUMNS[table].filter((column) => !hasSqlIdentifier(sql, column)).map((column) => `${table}.${column}`)
    })
    const tableCounts = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM case_revenue) AS caseRevenueRows,
        (SELECT COUNT(*) FROM lis_cases) AS lisCaseRows,
        (SELECT COUNT(*) FROM lis_case_markers) AS lisMarkerRows
    `).get() as Record<string, unknown>
    const baseSummary = {
      evidenceScope: 'aggregate_only',
      caseRevenueRows: numberOf(tableCounts.caseRevenueRows),
      lisCaseRows: numberOf(tableCounts.lisCaseRows),
      lisMarkerRows: numberOf(tableCounts.lisMarkerRows),
      missingTables,
      missingColumns,
      schemaFingerprint: sourceState.periodSchemaFingerprint,
      sourceRevisions: {
        caseRevenue: sourceState.revisions.case_revenue,
        lisCases: sourceState.revisions.lis_cases,
        lisMarkers: sourceState.revisions.lis_case_markers,
      },
    }

    if (missingTables.length > 0 || missingColumns.length > 0) {
      return {
        key,
        met: false,
        status: 'failed',
        resultCode: 'SCHEMA_NOT_READY',
        summary: baseSummary,
        inputFingerprint: sha256({ ...baseSummary, probeVersion: HOSPITAL_CM_FOUNDATION_PROBE_VERSION }),
      }
    }

    const aggregate = db.prepare(`
      WITH invalid_revenue_keys AS (
        SELECT COUNT(*) AS n
        FROM case_revenue
        WHERE TRIM(COALESCE(partner_id, '')) = ''
           OR TRIM(COALESCE(case_no, '')) = ''
           OR service_month IS NULL
           OR service_month NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
           OR CAST(SUBSTR(service_month, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
      ), invalid_lis_keys AS (
        SELECT
          (SELECT COUNT(*) FROM lis_cases
            WHERE TRIM(COALESCE(partner_id, '')) = '' OR TRIM(COALESCE(case_no, '')) = '')
          +
          (SELECT COUNT(*) FROM lis_case_markers
            WHERE TRIM(COALESCE(partner_id, '')) = '' OR TRIM(COALESCE(case_no, '')) = '') AS n
      ), cross_month AS (
        SELECT COUNT(*) AS n FROM (
          SELECT partner_id, case_no
          FROM case_revenue
          WHERE TRIM(COALESCE(partner_id, '')) <> '' AND TRIM(COALESCE(case_no, '')) <> ''
          GROUP BY partner_id, case_no
          HAVING COUNT(DISTINCT service_month) > 1
        )
      ), revenue_orphans AS (
        SELECT COUNT(*) AS n
        FROM case_revenue cr
        LEFT JOIN lis_cases lc ON lc.partner_id = cr.partner_id AND lc.case_no = cr.case_no
        WHERE lc.case_no IS NULL
      ), marker_orphans AS (
        SELECT COUNT(*) AS n
        FROM lis_case_markers lm
        LEFT JOIN lis_cases lc ON lc.partner_id = lm.partner_id AND lc.case_no = lm.case_no
        WHERE lc.case_no IS NULL
      )
      SELECT
        (SELECT n FROM invalid_revenue_keys) + (SELECT n FROM invalid_lis_keys) AS invalidKeyRows,
        (SELECT n FROM cross_month) AS crossMonthReuseRows,
        (SELECT n FROM revenue_orphans) AS revenueOrphanRows,
        (SELECT n FROM marker_orphans) AS markerOrphanRows,
        (SELECT COALESCE(SUM(LENGTH(partner_id) + LENGTH(case_no) + LENGTH(service_month)), 0) FROM case_revenue)
        + (SELECT COALESCE(SUM(LENGTH(partner_id) + LENGTH(case_no)), 0) FROM lis_cases)
        + (SELECT COALESCE(SUM(LENGTH(partner_id) + LENGTH(case_no)), 0) FROM lis_case_markers) AS keyIdentityMass
    `).get() as Record<string, unknown>
    const summary = {
      ...baseSummary,
      invalidKeyRows: numberOf(aggregate.invalidKeyRows),
      crossMonthReuseRows: numberOf(aggregate.crossMonthReuseRows),
      revenueOrphanRows: numberOf(aggregate.revenueOrphanRows),
      markerOrphanRows: numberOf(aggregate.markerOrphanRows),
    }
    let resultCode = 'PASSED'
    if (summary.caseRevenueRows === 0 || summary.lisCaseRows === 0 || summary.lisMarkerRows === 0) resultCode = 'EMPTY_PERIOD_BASELINE'
    else if (summary.invalidKeyRows > 0) resultCode = 'INVALID_PERIOD_KEY'
    else if (summary.crossMonthReuseRows > 0) resultCode = 'CROSS_MONTH_KEY_COLLISION'
    else if (summary.revenueOrphanRows > 0 || summary.markerOrphanRows > 0) resultCode = 'PERIOD_KEY_ORPHAN'
    const met = resultCode === 'PASSED'
    return {
      key,
      met,
      status: met ? 'passed' : 'failed',
      resultCode,
      summary,
      inputFingerprint: sha256({
        ...summary,
        keyIdentityMass: numberOf(aggregate.keyIdentityMass),
        probeVersion: HOSPITAL_CM_FOUNDATION_PROBE_VERSION,
      }),
    }
  } catch {
    return errorCheck(key)
  }
}

export function currentHospitalCmConstantManifest(): Record<string, unknown> {
  return {
    readiness: {
      version: READINESS_PARAM_VERSION,
      minimumClosedPeriods: READINESS_MIN_CLOSED_PERIODS,
      foundationGates: [...READINESS_FOUNDATION_GATES],
      defaultOwners: DEFAULT_READINESS_OWNER,
    },
    revenueSplit: { diagnosisFee: SPLIT_DIAG_FEE, formulaVersion: SPLIT_FORMULA_VERSION },
    hospitalCm: {
      formulaVersion: HOSPITAL_CM_FORMULA_VERSION,
      formulaBehaviorArtifact: currentHospitalCmFormulaBehaviorArtifact(),
      antibodyAdviceTypes: [...P0_ANTIBODY_ADVICE_TYPES].sort(),
      secondaryPerSlideDefault: SECONDARY_PER_SLIDE_DEFAULT,
      tissueProcessingMaterialPerBlock: P0_TISSUE_PROCESSING_MATERIAL_PER_BLOCK,
      thresholds: CM_THRESHOLDS,
      cmTarget: CM_TARGET,
      cmMarginForVariableLabor: CM_MARGIN_FOR_VARLABOR,
      revivalAccountCap: REVIVAL_ACCOUNT_CAP,
      revivalUnmeasuredShare: REVIVAL_UNMEASURED_SHARE,
    },
    costDefaults: {
      ihc: DEFAULT_IHC_COST_PARAMS,
      diagnosisAnchor: DIAGNOSIS_ANCHOR_DEFAULT,
    },
  }
}

/**
 * 受代码评审与 drift-guard 保护的基线签名。口径常量变化时，必须显式 bump 版本、更新本签名并让差异进入 PR。
 * 它不是数据库开关，也没有运行时“设为通过”的入口。
 */
export const EXPECTED_HOSPITAL_CM_CONSTANT_MANIFEST_FINGERPRINT = '4233fa066b3ac2df4b78d23e574bdaf5bb96c41bf2fcbae27778d12c790db0e7'

function probeConstantFreeze(sourceState: HospitalCmReadinessSourceState): HospitalCmFoundationProbeCheck {
  const key: FoundationGate = 'constant_freeze'
  const runtimeFingerprint = sourceState.constantFingerprint
  const costSourcesPresent = ['antibodies', 'antibody_aliases', 'ihc_cost_params', 'special_stain_kits']
    .every((source) => Boolean(sourceState.schemaSql[source as HospitalCmReadinessSourceTable]))
  const manifestMatches = runtimeFingerprint === EXPECTED_HOSPITAL_CM_CONSTANT_MANIFEST_FINGERPRINT
  const met = costSourcesPresent && manifestMatches
  const summary = {
    evidenceScope: 'code_manifest_only',
    readinessPolicyVersion: READINESS_PARAM_VERSION,
    splitFormulaVersion: SPLIT_FORMULA_VERSION,
    hospitalCmFormulaVersion: HOSPITAL_CM_FORMULA_VERSION,
    runtimeFingerprint,
    expectedFingerprint: EXPECTED_HOSPITAL_CM_CONSTANT_MANIFEST_FINGERPRINT,
    costDataSchemaFingerprint: sourceState.costDataSchemaFingerprint,
    costSourceRevisions: {
      antibodies: sourceState.revisions.antibodies,
      antibodyAliases: sourceState.revisions.antibody_aliases,
      ihcCostParams: sourceState.revisions.ihc_cost_params,
      specialStainKits: sourceState.revisions.special_stain_kits,
    },
  }
  return {
    key,
    met,
    status: met ? 'passed' : 'failed',
    resultCode: met ? 'PASSED' : costSourcesPresent ? 'CONSTANT_MANIFEST_MISMATCH' : 'COST_SOURCE_SCHEMA_NOT_READY',
    summary,
    inputFingerprint: sha256({
      runtimeFingerprint,
      costDataSchemaFingerprint: sourceState.costDataSchemaFingerprint,
      costSourceRevisions: summary.costSourceRevisions,
    }),
  }
}

export function inspectHospitalCmFoundation(
  db: FoundationProbeDb,
  suppliedSourceState?: HospitalCmReadinessSourceState,
): HospitalCmFoundationProbeCheck[] {
  let sourceState: HospitalCmReadinessSourceState
  try {
    sourceState = suppliedSourceState ?? readHospitalCmReadinessSourceState(db)
  } catch {
    return [errorCheck('inventory_conservation'), errorCheck('period_key'), errorCheck('constant_freeze')]
  }
  return [probeInventoryConservation(db, sourceState), probePeriodKey(db, sourceState), probeConstantFreeze(sourceState)]
}

export function combinedFoundationFingerprint(
  checks: Array<Pick<HospitalCmFoundationProbeCheck, 'key' | 'inputFingerprint'>>,
): string {
  return sha256({
    probeVersion: HOSPITAL_CM_FOUNDATION_PROBE_VERSION,
    checks: [...checks]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((check) => ({ key: check.key, inputFingerprint: check.inputFingerprint })),
  })
}
