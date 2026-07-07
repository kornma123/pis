import { v4 as uuidv4 } from 'uuid'
import { buildBomSourceSnapshot, calculateSlideCostWithFee, getBomPerSampleDriverQty } from './cost-calculator.js'
import { errorMessage, recordCostException } from './cost-exceptions.js'
import { getActiveBomVersionId } from './bom-version.js'
import { canonicalCaseNo } from './classifier.js' // 病理号落库归一（NFKC+trim），与 lis_cases/case_revenue（消费侧 canonical）同一，堵成本侧全角号钱路 join 匹配漏

const currentMonth = () => new Date().toISOString().slice(0, 7)

export const normalizeMonth = (value: unknown) => String(value || currentMonth()).slice(0, 7)

export const writeAuditLog = (db: any, module: string, action: string, targetId: string | null, detail: unknown, operator: string) => {
  db.prepare(`
    INSERT INTO abc_audit_logs (id, module, action, target_id, detail, operator)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuidv4(), module, action, targetId, detail === undefined ? null : JSON.stringify(detail), operator)
}

export const getOrCreatePeriod = (db: any, yearMonth: string, operator: string) => {
  const existing = db.prepare('SELECT * FROM abc_periods WHERE year_month = ?').get(yearMonth) as any
  if (existing) return existing

  const id = uuidv4()
  db.prepare(`
    INSERT INTO abc_periods (id, year_month, status, started_at)
    VALUES (?, ?, 'open', CURRENT_TIMESTAMP)
  `).run(id, yearMonth)
  writeAuditLog(db, 'period', 'create', id, { yearMonth }, operator)
  return db.prepare('SELECT * FROM abc_periods WHERE id = ?').get(id) as any
}

export const ensurePeriodOpen = (db: any, yearMonth: string) => {
  const period = db.prepare('SELECT * FROM abc_periods WHERE year_month = ?').get(yearMonth) as any
  if (period?.status === 'closed') {
    throw new Error(`成本期间 ${yearMonth} 已关账，不能执行该操作`)
  }
  return period
}

export const writeOutboundAbcSnapshot = (db: any, outbound: any, costRunId: string | null, costStatus: string): any => {
  const yearMonth = normalizeMonth(outbound.cost_month || outbound.created_at)
  const bomId = outbound.bom_id || outbound.project_bom_id
  if (!bomId) throw new Error('缺少 BOM，无法重算 ABC 成本')

  // 病理号归一（NFKC+trim）：outbound_abc_details.case_no 是「成本↔LIS(partner 回填)」与「成本↔case_revenue(院级 P&L 服务月)」
  // 两条钱路的 join key，须与 lis_cases/case_revenue（消费侧 canonicalCaseNo）同一归一，否则全角号成本成孤儿、不归院、不入单月毛利。
  const caseNo = canonicalCaseNo(outbound.case_no) || null
  const sampleCount = Math.max(1, Number(outbound.sample_count) || 1)
  const materialCost = Number(outbound.total_cost) || 0
  // P0：真实块/片/例数 = 每样本驱动量 × 样本数（替代写死 block=1/slide=sampleCount，修期间费率分母）。
  // case 为每病例（非每样本）：本出库挂 case_no 则计 1。无块关联 → 块=0（诚实，对应中心走未吸收残差）。
  const perSampleDriver = getBomPerSampleDriverQty(db, bomId)
  const storedBlockCount = Math.round(perSampleDriver.block * sampleCount)
  const storedSlideCount = Math.round((perSampleDriver.slide > 0 ? perSampleDriver.slide : 1) * sampleCount)
  const storedCaseCount = caseNo ? 1 : 0
  const result = calculateSlideCostWithFee(db, {
    bomId,
    slideCount: sampleCount,
    blockCount: 1,
    month: yearMonth,
    materialCost,
    caseNo,
    // R1：逐单分摊按真实驱动量（块/片 = 每样本量 × 样本数；病例 = 本单实际病例数），与期间池同口径。
    sampleCount,
    caseCount: storedCaseCount,
  })
  const effectiveCostStatus = result.feeBreakdown.length === 0 ? 'cost_exception' : costStatus
  const sourceSnapshot = {
    outboundId: outbound.id,
    outboundNo: outbound.outbound_no,
    bomId,
    projectId: outbound.project_id || null,
    caseNo,
    sampleCount,
    materialCost,
    bomSnapshot: buildBomSourceSnapshot(db, bomId),
    feeBreakdown: result.feeBreakdown,
    yearMonth,
    calculatedAt: new Date().toISOString(),
  }

  db.prepare('DELETE FROM outbound_abc_details WHERE outbound_id = ?').run(outbound.id)
  db.prepare(`
    INSERT INTO outbound_abc_details (
      id, outbound_id, bom_id, project_id, sample_count, slide_count, block_count, case_count,
      material_cost, activity_cost, total_cost, cost_per_slide,
      fee_category, fee_standard_id, fee_amount, profit, profit_rate,
      activity_details, cost_month, cost_status, cost_run_id, case_no, charge_group_id,
      calculation_version, source_snapshot, bom_version_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    outbound.id,
    bomId,
    outbound.project_id || null,
    sampleCount,
    storedSlideCount,
    storedBlockCount,
    storedCaseCount,
    result.materialCost,
    result.totalActivityCost,
    result.totalCost,
    sampleCount > 0 ? result.totalCost / sampleCount : 0,
    result.feeCategory,
    result.feeStandardId,
    result.feeAmount,
    result.profit,
    result.profitRate,
    JSON.stringify(result.activityCosts),
    yearMonth,
    effectiveCostStatus,
    costRunId,
    caseNo,
    result.chargeGroupId || (caseNo ? `${caseNo}-${yearMonth}` : outbound.id),
    'v1',
    JSON.stringify(sourceSnapshot),
    getActiveBomVersionId(db, bomId), // 钉到当时活跃版本（历史可复现）
  )
  db.prepare(`
    UPDATE outbound_records
    SET abc_total_cost = ?, abc_activity_cost = ?, fee_amount = ?, profit = ?, cost_status = ?
    WHERE id = ?
  `).run(result.totalCost, result.totalActivityCost, result.feeAmount, result.profit, effectiveCostStatus, outbound.id)

  return { result, sourceSnapshot, costStatus: effectiveCostStatus }
}

export const runCostRecalculation = (
  db: any,
  yearMonth: string,
  operator: string,
  runType = 'recalculate',
  outboundId?: string,
) => {
  ensurePeriodOpen(db, yearMonth)
  getOrCreatePeriod(db, yearMonth, operator)

  const runId = uuidv4()
  db.prepare(`
    INSERT INTO cost_runs (id, year_month, run_type, status, started_by, started_at)
    VALUES (?, ?, ?, 'running', ?, CURRENT_TIMESTAMP)
  `).run(runId, yearMonth, runType, operator)

  const params: any[] = [yearMonth]
  let outboundFilter = ''
  if (outboundId) {
    outboundFilter = ' AND r.id = ?'
    params.push(outboundId)
  }
  const outbounds = db.prepare(`
    SELECT r.*, p.bom_id as project_bom_id, d.bom_id as detail_bom_id,
           COALESCE(d.cost_month, substr(r.created_at, 1, 7)) as cost_month
    FROM outbound_records r
    LEFT JOIN projects p ON r.project_id = p.id
    LEFT JOIN outbound_abc_details d ON d.outbound_id = r.id
    WHERE r.is_deleted = 0 AND r.status = 'completed' AND r.type = 'bom'
      AND substr(r.created_at, 1, 7) = ? ${outboundFilter}
    GROUP BY r.id
    ORDER BY r.created_at ASC
  `).all(...params) as any[]

  let succeeded = 0
  let failed = 0
  const failures: any[] = []

  for (const outbound of outbounds) {
    try {
      const costStatus = runType.includes('recalculate') ? 'recalculated' : 'costed'
      const snapshot = writeOutboundAbcSnapshot(db, {
        ...outbound,
        bom_id: outbound.detail_bom_id || outbound.project_bom_id,
      }, runId, costStatus)
      const missingFeeMapping = snapshot.result.feeBreakdown.length === 0
      if (missingFeeMapping) {
        const existing = db.prepare(`
          SELECT id FROM cost_exceptions
          WHERE outbound_id = ? AND exception_type = 'missing_fee_mapping' AND status = 'open'
        `).get(outbound.id) as any
        const details = {
          runId,
          outboundNo: outbound.outbound_no,
          bomId: outbound.detail_bom_id || outbound.project_bom_id || null,
          projectId: outbound.project_id || null,
          caseNo: canonicalCaseNo(outbound.case_no) || null,
          sampleCount: Math.max(1, Number(outbound.sample_count) || 1),
          action: 'configure_bom_fee_mapping',
        }
        if (existing) {
          db.prepare(`
            UPDATE cost_exceptions
            SET source_module = 'abc', source_type = 'cost_run', source_id = ?,
                project_id = ?, bom_id = ?, year_month = ?, message = ?,
                details = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).run(
            runId,
            outbound.project_id || null,
            outbound.detail_bom_id || outbound.project_bom_id || null,
            yearMonth,
            'BOM未配置收费映射，重算后收费与利润仍不可确认',
            JSON.stringify(details),
            existing.id,
          )
        } else {
          recordCostException(db, {
            sourceModule: 'abc',
            sourceType: 'cost_run',
            sourceId: runId,
            projectId: outbound.project_id || null,
            bomId: outbound.detail_bom_id || outbound.project_bom_id || null,
            outboundId: outbound.id,
            yearMonth,
            exceptionType: 'missing_fee_mapping',
            severity: 'warning',
            message: 'BOM未配置收费映射，重算后收费与利润仍不可确认',
            details,
          })
        }
      }
      db.prepare(`
        UPDATE cost_exceptions
        SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE outbound_id = ? AND status = 'open'
          AND exception_type IN ('abc_calculation_failed', 'missing_driver_rate')
      `).run(operator, outbound.id)
      if (!missingFeeMapping) {
        db.prepare(`
          UPDATE cost_exceptions
          SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE outbound_id = ? AND status = 'open' AND exception_type = 'missing_fee_mapping'
        `).run(operator, outbound.id)
      }
      succeeded += 1
    } catch (err) {
      const message = errorMessage(err)
      failed += 1
      failures.push({ outboundId: outbound.id, outboundNo: outbound.outbound_no, message })
      db.prepare("UPDATE outbound_records SET cost_status = 'cost_exception' WHERE id = ?").run(outbound.id)
      recordCostException(db, {
        sourceModule: 'abc',
        sourceType: 'cost_run',
        sourceId: runId,
        projectId: outbound.project_id || null,
        bomId: outbound.detail_bom_id || outbound.project_bom_id || null,
        outboundId: outbound.id,
        yearMonth,
        exceptionType: 'calculation_failed',
        severity: 'error',
        message: '成本重算失败',
        details: { runId, outboundNo: outbound.outbound_no, error: message },
      })
    }
  }

  const summary = { processed: outbounds.length, succeeded, failed, failures }
  const status = failed > 0 && succeeded === 0 ? 'failed' : 'completed'
  db.prepare(`
    UPDATE cost_runs SET status = ?, finished_at = CURRENT_TIMESTAMP, summary = ? WHERE id = ?
  `).run(status, JSON.stringify(summary), runId)
  db.prepare(`
    UPDATE abc_periods
    SET status = ?, calculated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE year_month = ?
  `).run(failed > 0 ? 'collecting' : 'calculated', yearMonth)
  writeAuditLog(db, 'cost_run', runType, runId, { yearMonth, ...summary }, operator)

  return {
    id: runId,
    yearMonth,
    runType,
    status,
    startedBy: operator,
    summary,
  }
}
