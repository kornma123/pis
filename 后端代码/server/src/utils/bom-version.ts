/**
 * BOM 标准用量版本化纯函数集中地
 *
 * 由对账核准链 / BOM 编辑调用，把每次标准用量变更落为 bom_versions 一行快照，
 * 保留可追溯历史（snapshot + diff + changeLog）、影响范围（impact_summary）与生效范围
 * （effective_scope：future_only 不动历史 / retroactive 触发受控重算）。
 *
 * 移植自孤儿线 bom-v1.1.ts 的成熟实现，并按 master 极简 BOM 模型（boms + bom_items）改写
 * buildBomVersionSnapshot（不依赖通用试剂/质控/设备模板等 master BOM 路由不写的子表）。
 */
import { v4 as uuidv4 } from 'uuid'

function parseJsonOrNull(value: any): any {
  if (value == null) return null
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch (_e) {
    return null
  }
}

/** 'v1.2' → 1002，用于版本排序 */
export function versionNumber(version: string): number {
  const [major = 0, minor = 0] = String(version || 'v0.0')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number(part) || 0)
  return major * 1000 + minor
}

export function normalizeEffectiveScope(value: unknown): 'future_only' | 'retroactive' {
  return value === 'retroactive' ? 'retroactive' : 'future_only'
}

/** 快照当前 BOM 标准（master 模型：boms 字段 + bom_items 物料用量列表） */
export function buildBomVersionSnapshot(db: any, bomId: string): any {
  const bom = db
    .prepare(
      `SELECT id, code, name, version, type, service_id, description,
              supportable_samples, fee_standard_id, fee_category, status,
              unit_cost, standard_labor_cost, standard_equipment_cost,
              standard_indirect_cost, standard_total_cost, standard_slide_cost,
              standard_fee_per_slide, standard_margin_rate, updated_at
       FROM boms WHERE id = ? AND is_deleted = 0`,
    )
    .get(bomId) as any
  if (!bom) return null

  const materials = (
    db
      .prepare(
        `SELECT bi.material_id, bi.usage_per_sample, bi.unit, bi.group_name, bi.sort_order,
                m.code AS material_code, m.name AS material_name, m.spec
         FROM bom_items bi
         LEFT JOIN materials m ON bi.material_id = m.id AND m.is_deleted = 0
         WHERE bi.bom_id = ?
         ORDER BY bi.sort_order ASC, bi.created_at ASC`,
      )
      .all(bomId) as any[]
  ).map((row: any) => ({
    materialId: row.material_id,
    materialCode: row.material_code || null,
    materialName: row.material_name || null,
    spec: row.spec || null,
    unit: row.unit || null,
    usagePerSample: row.usage_per_sample ?? null,
    groupName: row.group_name || null,
    sortOrder: row.sort_order || 0,
  }))

  return {
    id: bom.id,
    code: bom.code,
    name: bom.name,
    version: bom.version,
    type: bom.type,
    serviceId: bom.service_id || null,
    description: bom.description || null,
    supportableSamples: bom.supportable_samples ?? null,
    feeStandardId: bom.fee_standard_id || null,
    feeCategory: bom.fee_category || null,
    status: bom.status,
    unitCost: Number(bom.unit_cost) || 0,
    standardLaborCost: Number(bom.standard_labor_cost) || 0,
    standardEquipmentCost: Number(bom.standard_equipment_cost) || 0,
    standardIndirectCost: Number(bom.standard_indirect_cost) || 0,
    standardTotalCost: Number(bom.standard_total_cost) || 0,
    standardSlideCost: Number(bom.standard_slide_cost) || 0,
    standardFeePerSlide: Number(bom.standard_fee_per_slide) || 0,
    standardMarginRate: Number(bom.standard_margin_rate) || 0,
    updatedAt: bom.updated_at,
    materials,
  }
}

function diffMaterialList(beforeItems: any[] = [], afterItems: any[] = []) {
  const beforeMap = new Map(beforeItems.map((item) => [item.materialId, item]))
  const afterMap = new Map(afterItems.map((item) => [item.materialId, item]))
  const addedMaterials = afterItems.filter((item) => !beforeMap.has(item.materialId))
  const removedMaterials = beforeItems.filter((item) => !afterMap.has(item.materialId))
  const changedMaterials = afterItems.flatMap((item) => {
    const before = beforeMap.get(item.materialId)
    if (!before) return []
    const changed =
      Number(before.usagePerSample) !== Number(item.usagePerSample) ||
      String(before.unit || '') !== String(item.unit || '') ||
      String(before.groupName || '') !== String(item.groupName || '')
    return changed ? [{ materialId: item.materialId, materialName: item.materialName, before, after: item }] : []
  })
  return { addedMaterials, removedMaterials, changedMaterials }
}

export function buildBomVersionDiff(beforeSnapshot: any, afterSnapshot: any) {
  if (!beforeSnapshot) {
    return { changedFields: [], addedMaterials: [], removedMaterials: [], changedMaterials: [] }
  }
  const changedFields = (
    [
      ['name', '名称'],
      ['type', '类型'],
      ['serviceId', '关联检测服务'],
      ['description', '描述'],
      ['supportableSamples', '支持样本数'],
      ['feeStandardId', '收费标准'],
      ['feeCategory', '收费分类'],
    ] as Array<[string, string]>
  ).flatMap(([field, label]) =>
    String(beforeSnapshot[field] ?? '') === String(afterSnapshot[field] ?? '')
      ? []
      : [{ field, label, before: beforeSnapshot[field] ?? null, after: afterSnapshot[field] ?? null }],
  )
  return {
    changedFields,
    ...diffMaterialList(beforeSnapshot.materials || [], afterSnapshot.materials || []),
  }
}

export function summarizeBomVersionDiff(diff: any, hasPrevious: boolean): string {
  if (!hasPrevious) return '初始版本'
  const parts: string[] = []
  if (diff.changedFields?.length) {
    parts.push(`${diff.changedFields.map((item: any) => item.label).join('、')}变更`)
  }
  if (diff.addedMaterials?.length) parts.push(`新增物料 ${diff.addedMaterials.length} 项`)
  if (diff.removedMaterials?.length) parts.push(`移除物料 ${diff.removedMaterials.length} 项`)
  if (diff.changedMaterials?.length) parts.push(`物料用量 ${diff.changedMaterials.length} 项调整`)
  return parts.length ? parts.join('；') : '版本更新'
}

/**
 * 影响范围：该 BOM 关联的已核算月份及其关账状态（用于追溯重算决策）。
 * recalculable = 期间未关账。已关账月不可机械重算，须走关账后调整单。
 */
export function buildBomChangeImpact(db: any, bomId: string) {
  const rows = db
    .prepare(
      `SELECT
         COALESCE(d.cost_month, substr(r.created_at, 1, 7)) AS year_month,
         COALESCE(p.status, 'open') AS period_status,
         COUNT(DISTINCT r.id) AS outbound_count
       FROM outbound_records r
       LEFT JOIN outbound_abc_details d ON d.outbound_id = r.id
       LEFT JOIN abc_periods p ON p.year_month = COALESCE(d.cost_month, substr(r.created_at, 1, 7))
       WHERE r.is_deleted = 0
         AND r.status = 'completed'
         AND r.type = 'bom'
         AND (d.bom_id = ? OR r.project_id IN (
           SELECT id FROM projects WHERE bom_id = ? AND is_deleted = 0
         ))
       GROUP BY year_month, period_status
       ORDER BY year_month DESC`,
    )
    .all(bomId, bomId) as any[]

  const months = rows.map((row) => ({
    yearMonth: row.year_month,
    periodStatus: row.period_status,
    outboundCount: Number(row.outbound_count) || 0,
    recalculable: row.period_status !== 'closed',
  }))

  return {
    totalOutboundCount: months.reduce((sum, item) => sum + item.outboundCount, 0),
    affectedMonthCount: months.length,
    closedMonthCount: months.filter((item) => !item.recalculable).length,
    recalculableMonthCount: months.filter((item) => item.recalculable).length,
    months,
  }
}

/** 写一行版本快照（INSERT OR REPLACE，按 UNIQUE(bom_id, version) 幂等） */
export function writeBomVersionSnapshot(
  db: any,
  bomId: string,
  previousSnapshot?: any,
  operator?: string,
  options?: { effectiveScope?: string; impactSummary?: any },
): { snapshot: any; diff: any; changeLog: string } | null {
  const snapshot = buildBomVersionSnapshot(db, bomId)
  if (!snapshot) return null
  const diff = buildBomVersionDiff(previousSnapshot, snapshot)
  const changeLog = summarizeBomVersionDiff(diff, Boolean(previousSnapshot))
  db.prepare(
    `INSERT OR REPLACE INTO bom_versions (
       id, bom_id, version, snapshot, diff_summary, change_log,
       effective_scope, impact_summary, changed_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uuidv4(),
    bomId,
    snapshot.version,
    JSON.stringify(snapshot),
    JSON.stringify(diff),
    changeLog,
    normalizeEffectiveScope(options?.effectiveScope),
    options?.impactSummary ? JSON.stringify(options.impactSummary) : null,
    operator || null,
  )
  return { snapshot, diff, changeLog }
}

export function getLatestBomVersionSnapshot(db: any, bomId: string): any {
  const rows = db.prepare('SELECT version, snapshot FROM bom_versions WHERE bom_id = ?').all(bomId) as any[]
  const latest = rows.sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0]
  return parseJsonOrNull(latest?.snapshot)
}

/** 当前活跃版本行 id（最新 version），用于 outbound_abc_details.bom_version_id 回填 */
export function getActiveBomVersionId(db: any, bomId: string): string | null {
  const rows = db.prepare('SELECT id, version FROM bom_versions WHERE bom_id = ?').all(bomId) as any[]
  if (!rows.length) return null
  const latest = rows.sort((a, b) => versionNumber(b.version) - versionNumber(a.version))[0]
  return latest?.id || null
}

export function getBomVersionHistory(db: any, bomId: string, currentVersion: string) {
  const rows = db
    .prepare(
      `SELECT version, snapshot, diff_summary, change_log,
              effective_scope, impact_summary, changed_by, created_at
       FROM bom_versions WHERE bom_id = ?`,
    )
    .all(bomId) as any[]
  return rows
    .sort((a, b) => versionNumber(b.version) - versionNumber(a.version))
    .map((row) => ({
      version: row.version,
      updatedAt: row.created_at,
      changeLog: row.change_log || '-',
      effectiveScope: row.effective_scope || 'future_only',
      impactSummary: parseJsonOrNull(row.impact_summary),
      changedBy: row.changed_by || null,
      isCurrent: row.version === currentVersion,
      snapshot: parseJsonOrNull(row.snapshot),
      diff: parseJsonOrNull(row.diff_summary) || {},
    }))
}
