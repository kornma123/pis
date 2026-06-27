import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { buildBomSourceSnapshot, calculateSlideCostWithFee, getBomPerSampleDriverQty } from '../utils/cost-calculator.js'
import { recordCostException } from '../utils/cost-exceptions.js'
import { getActiveBomVersionId } from '../utils/bom-version.js'
import { requirePermission } from '../middleware/permissions.js'

const router = Router()

function generateOutboundNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `OB-${date}-${timestamp}-${random}`
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, projectId, status, keyword, materialId, type, startDate, endDate } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'r.is_deleted = 0'
    const params: any[] = []
    if (projectId) { where += ' AND r.project_id = ?'; params.push(projectId) }
    if (status) { where += ' AND r.status = ?'; params.push(status) }
    if (type) { where += ' AND r.type = ?'; params.push(type) }
    if (startDate) { where += ' AND r.created_at >= ?'; params.push(startDate) }
    if (endDate) { where += ' AND r.created_at <= ?'; params.push(`${endDate}T23:59:59`) }
    if (keyword) {
      where += ` AND (r.outbound_no LIKE ? OR EXISTS (
        SELECT 1 FROM outbound_items oi JOIN materials m ON oi.material_id = m.id
        WHERE oi.outbound_id = r.id AND m.is_deleted = 0 AND m.name LIKE ?
      ))`
      params.push(`%${keyword}%`, `%${keyword}%`)
    }
    if (materialId) {
      where += ` AND EXISTS (
        SELECT 1 FROM outbound_items oi WHERE oi.outbound_id = r.id AND oi.material_id = ?
      )`
      params.push(materialId)
    }

    const count = (db.prepare(`SELECT COUNT(*) as total FROM outbound_records r WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (Number(page) - 1) * Number(pageSize)

    const records = db.prepare(`
      SELECT r.*, p.name as project_name
      FROM outbound_records r
      LEFT JOIN projects p ON r.project_id = p.id AND p.is_deleted = 0
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(pageSize), offset) as any[]

    const result = records.map((r: any) => {
      const items = db.prepare('SELECT oi.*, m.name as material_name FROM outbound_items oi LEFT JOIN materials m ON oi.material_id = m.id AND m.is_deleted = 0 WHERE oi.outbound_id = ?').all(r.id) as any[]
      return {
        id: r.id, outboundNo: r.outbound_no, type: r.type, projectId: r.project_id,
        projectName: r.project_name,
        items: items.map((i: any) => ({
          id: i.id, materialId: i.material_id, materialName: i.material_name,
          batchNo: i.batch_no, quantity: i.quantity, unit: i.unit,
          unitCost: i.unit_cost, totalCost: i.total_cost,
        })),
        totalCost: r.total_cost, operator: r.operator, status: r.status,
        remark: r.remark, createdAt: r.created_at,
      }
    })

    successList(res, result, Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.get('/stats', (req, res) => {
  try {
    const db = getDatabase()
    const total = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0").get() as any)?.c || 0
    const completed = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    const pending = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'pending'").get() as any)?.c || 0
    const cancelled = (db.prepare("SELECT COUNT(*) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'cancelled'").get() as any)?.c || 0
    const totalCost = (db.prepare("SELECT COALESCE(SUM(total_cost),0) as c FROM outbound_records WHERE is_deleted = 0 AND status = 'completed'").get() as any)?.c || 0
    success(res, { total, completed, pending, cancelled, totalCost })
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { type, projectId, items, remark } = req.body
    if (!type || !Array.isArray(items) || items.length === 0) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }

    const db = getDatabase()
    const outboundNo = generateOutboundNo()
    const id = uuidv4()
    const operator = req.body.operator || 'system'

    let totalCost = 0
    const outboundItems: any[] = []

    for (const item of items) {
      const { materialId, quantity } = item
      if (!materialId || quantity === undefined || quantity === null || isNaN(Number(quantity)) || Number(quantity) <= 0) {
        error(res, 'Invalid quantity', 'INVALID_PARAMETER', 400); return
      }
      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
      if (!inv || inv.stock < quantity) {
        error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422); return
      }

      const batch = db.prepare(`
        SELECT b.* FROM batches b
        JOIN materials m ON b.material_id = m.id
        WHERE b.material_id = ? AND b.remaining > 0 AND b.status = 1 AND m.is_deleted = 0
        ORDER BY b.expiry_date ASC
      `).get(materialId) as any
      const unitCost = batch?.inbound_price || 0
      const itemCost = unitCost * quantity
      totalCost += itemCost

      outboundItems.push({ materialId, batchId: batch?.id || null, batchNo: batch?.batch_no || null, quantity, unitCost, itemCost, usage: item.usage || 'self', receiver: item.receiver || null })
    }

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + items.map(() => '?').join(',') + ')').all(...items.map((i: any) => i.materialId)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))

    // 事务保护：出库涉及 records + items + inventory + batches + stock_logs 多表操作
    db.exec('BEGIN IMMEDIATE')
    try {
      // 事务内重新校验库存，防止并发窗口
      for (const item of items) {
        const { materialId, quantity } = item
        const invCheck = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
        if (!invCheck || invCheck.stock < quantity) {
          db.exec('ROLLBACK')
          error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422)
          return
        }
      }

      db.prepare(`
        INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, remark)
        VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
      `).run(id, outboundNo, type, projectId || null, totalCost, operator, remark || null)

      for (const oi of outboundItems) {
        const itemId = uuidv4()
        db.prepare(`
          INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, id, oi.materialId, oi.batchId, oi.batchNo, oi.quantity, unitMap.get(oi.materialId) || 'pcs', oi.unitCost, oi.itemCost, oi.usage || 'self', oi.receiver || null)

        db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(oi.quantity, oi.materialId)

        if (oi.batchId) {
          db.prepare('UPDATE batches SET remaining = remaining - ? WHERE id = ?').run(oi.quantity, oi.batchId)
          const batchRemaining = (db.prepare('SELECT remaining FROM batches WHERE id = ?').get(oi.batchId) as any)?.remaining
          if (batchRemaining <= 0) {
            db.prepare('UPDATE batches SET status = 0 WHERE id = ?').run(oi.batchId)
          }
        }

        // 自用物料创建使用中跟踪记录
        if ((oi.usage || 'self') === 'self' && oi.batchId) {
          const mat = db.prepare('SELECT name, spec FROM materials WHERE id = ? AND is_deleted = 0').get(oi.materialId) as any
          const trkId = `TRK-${Date.now()}-${Math.floor(Math.random() * 1000)}`
          const today = new Date().toISOString().split('T')[0]
          db.prepare(`
            INSERT INTO batch_usage_tracking
            (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
          `).run(trkId, oi.materialId, mat?.name || '', oi.batchNo || '', mat?.spec || '', oi.quantity, oi.quantity, unitMap.get(oi.materialId) || 'pcs', today, 30, 'self', null)
        }

        const logId = uuidv4()
        const beforeStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(oi.materialId) as any)?.stock || 0
        const afterStock = beforeStock - oi.quantity
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
        `).run(logId, oi.materialId, -oi.quantity, beforeStock, afterStock, id, operator)
      }

      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    success(res, { id, outboundNo, type, projectId, totalCost, status: 'completed', createdAt: new Date().toISOString() }, 'Outbound created', 201)
  } catch (err: any) { error(res, err.message) }
})

router.post('/bom', (req, res) => {
  try {
    const { projectId, bomId, sampleCount, remark } = req.body
    if (!bomId || sampleCount === undefined || sampleCount === null) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }
    const sc = Number(sampleCount)
    if (isNaN(sc) || sc <= 0) {
      error(res, 'Invalid sampleCount', 'INVALID_PARAMETER', 400); return
    }

    const db = getDatabase()
    const outboundNo = generateOutboundNo()
    const id = uuidv4()
    const operator = req.body.operator || 'system'

    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND is_deleted = 0').get(projectId) as any
    if (!project) { error(res, 'Project not found', 'NOT_FOUND', 404); return }

    const bomItems = db.prepare(`
      SELECT bi.*, m.name, m.spec FROM bom_items bi
      JOIN materials m ON bi.material_id = m.id AND m.is_deleted = 0
      WHERE bi.bom_id = ?
    `).all(bomId) as any[]
    if (!bomItems || bomItems.length === 0) {
      error(res, 'BOM is empty', 'INVALID_PARAMETER', 400); return
    }

    let totalCost = 0
    const outboundItems: any[] = []

    for (const item of bomItems) {
      const quantity = item.usage_per_sample * sc
      if (quantity <= 0) continue
      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(item.material_id) as any
      if (!inv || inv.stock < quantity) {
        // P1-01: 辅料(is_alternative=1，如通用试剂/耗材/质控)缺货跳过该项，不计出库、不阻断整单；
        //        主料(is_alternative=0)缺货才阻断整单。
        if (item.is_alternative === 1) continue
        error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422); return
      }
      const batch = db.prepare(`
        SELECT b.* FROM batches b
        JOIN materials m ON b.material_id = m.id
        WHERE b.material_id = ? AND b.remaining > 0 AND b.status = 1 AND m.is_deleted = 0
        ORDER BY b.expiry_date ASC
      `).get(item.material_id) as any
      const unitCost = batch?.inbound_price || 0
      const itemCost = unitCost * quantity
      totalCost += itemCost
      outboundItems.push({ materialId: item.material_id, batchId: batch?.id || null, batchNo: batch?.batch_no || null, quantity, unitCost, itemCost })
    }

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + bomItems.map(() => '?').join(',') + ')').all(...bomItems.map((i: any) => i.material_id)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of bomItems) {
        const quantity = item.usage_per_sample * sc
        if (quantity <= 0) continue
        const invCheck = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(item.material_id) as any
        if (!invCheck || invCheck.stock < quantity) {
          // P1-01: 与预检一致——辅料缺货跳过（不在 outboundItems 中，不会被扣减），主料缺货才回滚整单
          if (item.is_alternative === 1) continue
          db.exec('ROLLBACK')
          error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422); return
        }
      }
      db.prepare(`
        INSERT INTO outbound_records (id, outbound_no, type, project_id, total_cost, operator, status, remark)
        VALUES (?, ?, ?, ?, ?, ?, 'completed', ?)
      `).run(id, outboundNo, 'bom', projectId || null, totalCost, operator, remark || null)
      for (const oi of outboundItems) {
        const itemId = uuidv4()
        db.prepare(`
          INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, id, oi.materialId, oi.batchId, oi.batchNo, oi.quantity, unitMap.get(oi.materialId) || 'pcs', oi.unitCost, oi.itemCost, 'self', null)
        db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(oi.quantity, oi.materialId)
        if (oi.batchId) {
          db.prepare('UPDATE batches SET remaining = remaining - ? WHERE id = ?').run(oi.quantity, oi.batchId)
          const batchRemaining = (db.prepare('SELECT remaining FROM batches WHERE id = ?').get(oi.batchId) as any)?.remaining
          if (batchRemaining <= 0) {
            db.prepare('UPDATE batches SET status = 0 WHERE id = ?').run(oi.batchId)
          }
        }
        const logId = uuidv4()
        const beforeStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(oi.materialId) as any)?.stock || 0
        const afterStock = beforeStock - oi.quantity
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
        `).run(logId, oi.materialId, -oi.quantity, beforeStock, afterStock, id, operator)
      }

      // ===== ABC 成本核算：写入 outbound_abc_details（失败不阻断出库）=====
      try {
        const costMonth = new Date().toISOString().slice(0, 7)
        const perSampleDriver = getBomPerSampleDriverQty(db, bomId)
        const storedBlockCount = Math.round(perSampleDriver.block * sc)
        const storedSlideCount = Math.round((perSampleDriver.slide > 0 ? perSampleDriver.slide : 1) * sc)
        const slideCostResult = calculateSlideCostWithFee(db, {
          bomId,
          slideCount: sc,
          blockCount: 1,
          month: costMonth,
          materialCost: totalCost,
          caseNo: null,
          applyCaseAggregation: true,
          sampleCount: sc,
          caseCount: 0,
        })
        const missingFeeMapping = slideCostResult.feeBreakdown.length === 0
        const abcDetailId = uuidv4()
        db.prepare(`
          INSERT INTO outbound_abc_details
          (id, outbound_id, bom_id, project_id, sample_count, slide_count, block_count, case_count,
           material_cost, activity_cost, total_cost, cost_per_slide,
           fee_category, fee_standard_id, fee_amount, profit, profit_rate,
           activity_details, cost_month, cost_status, case_no, charge_group_id, calculation_version, source_snapshot, bom_version_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          abcDetailId, id, bomId, projectId || null,
          sc, storedSlideCount, storedBlockCount, 0,
          slideCostResult.materialCost, slideCostResult.totalActivityCost, slideCostResult.totalCost,
          sc > 0 ? slideCostResult.totalCost / sc : 0,
          slideCostResult.feeCategory, slideCostResult.feeStandardId,
          slideCostResult.feeAmount, slideCostResult.profit, slideCostResult.profitRate,
          JSON.stringify(slideCostResult.activityCosts),
          costMonth,
          missingFeeMapping ? 'cost_exception' : 'costed',
          null,
          id,
          'v1',
          JSON.stringify({
            outboundId: id, outboundNo, bomId, projectId: projectId || null, caseNo: null,
            sampleCount: sc, materialCost: totalCost,
            bomSnapshot: buildBomSourceSnapshot(db, bomId),
            feeBreakdown: slideCostResult.feeBreakdown,
            calculatedAt: new Date().toISOString(),
          }),
          getActiveBomVersionId(db, bomId), // 钉到当时活跃版本（历史可复现）
        )
        db.prepare(`
          UPDATE outbound_records SET
            abc_total_cost = ?, abc_activity_cost = ?, fee_amount = ?, profit = ?, cost_status = ?
          WHERE id = ?
        `).run(
          slideCostResult.totalCost, slideCostResult.totalActivityCost,
          slideCostResult.feeAmount, slideCostResult.profit,
          missingFeeMapping ? 'cost_exception' : 'costed', id,
        )
        if (missingFeeMapping) {
          recordCostException(db, {
            sourceModule: 'abc', sourceType: 'bom_outbound', sourceId: id,
            projectId: projectId || null, bomId, outboundId: id, yearMonth: costMonth,
            exceptionType: 'missing_fee_mapping', severity: 'warning',
            message: 'BOM未配置收费映射，出库收费与利润核算不可确认',
            details: { outboundNo, bomId, projectId: projectId || null, caseNo: null, sampleCount: sc, action: 'configure_bom_fee_mapping' },
          })
        }
      } catch (abcErr) {
        console.error('ABC cost calculation failed (non-blocking):', abcErr)
      }

      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    success(res, { id, outboundNo, type: 'bom', projectId, totalCost, status: 'completed', createdAt: new Date().toISOString() }, 'BOM outbound created', 201)
  } catch (err: any) { error(res, err.message) }
})

// 写入权限检查
const requireWriteAccess = requirePermission('outbound', 'W')

router.put('/:id', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const { type, projectId, items: newItems, remark } = req.body
    if (!Array.isArray(newItems) || newItems.length === 0) {
      error(res, 'Missing required fields', 'INVALID_PARAMETER', 400); return
    }

    const db = getDatabase()
    const record = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, 'Not found', 'NOT_FOUND', 404); return }

    const oldItems = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]

    let newTotalCost = 0
    const processedItems: any[] = []
    for (const item of newItems) {
      const { materialId, quantity } = item
      if (!materialId || quantity === undefined || quantity === null || isNaN(Number(quantity)) || Number(quantity) <= 0) {
        error(res, 'Invalid quantity', 'INVALID_PARAMETER', 400); return
      }
      const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any
      if (!inv || inv.stock < quantity) {
        error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422); return
      }
      const batch = db.prepare(`
        SELECT b.* FROM batches b
        JOIN materials m ON b.material_id = m.id
        WHERE b.material_id = ? AND b.remaining > 0 AND b.status = 1 AND m.is_deleted = 0
        ORDER BY b.expiry_date ASC
      `).get(materialId) as any
      const unitCost = batch?.inbound_price || 0
      const itemCost = unitCost * quantity
      newTotalCost += itemCost
      processedItems.push({ materialId, batchId: batch?.id || null, batchNo: batch?.batch_no || null, quantity, unitCost, itemCost, usage: item.usage || 'self', receiver: item.receiver || null })
    }

    const materialUnits = db.prepare('SELECT id, unit FROM materials WHERE id IN (' + newItems.map(() => '?').join(',') + ')').all(...newItems.map((i: any) => i.materialId)) as any[]
    const unitMap = new Map(materialUnits.map((m: any) => [m.id, m.unit]))

    db.exec('BEGIN IMMEDIATE')
    try {
      // 1. 回退旧 items 库存
      for (const item of oldItems) {
        db.prepare('UPDATE inventory SET stock = stock + ? WHERE material_id = ?').run(item.quantity, item.material_id)
        if (item.batch_id) {
          db.prepare('UPDATE batches SET remaining = remaining + ?, status = 1 WHERE id = ?').run(item.quantity, item.batch_id)
        }
        if (item.batch_no) {
          db.prepare("DELETE FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'").run(item.material_id, item.batch_no)
        }
      }

      // 2. 删除旧 items
      db.prepare('DELETE FROM outbound_items WHERE outbound_id = ?').run(id)

      // 3. 重新校验库存（防止并发）
      for (const pi of processedItems) {
        const invCheck = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(pi.materialId) as any
        if (!invCheck || invCheck.stock < pi.quantity) {
          db.exec('ROLLBACK')
          error(res, 'Insufficient stock', 'STOCK_INSUFFICIENT', 422)
          return
        }
      }

      // 4. 更新记录
      db.prepare('UPDATE outbound_records SET type = ?, project_id = ?, total_cost = ?, remark = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(type || 'project', projectId || null, newTotalCost, remark || null, id)

      // 5. 创建新 items 并扣减库存
      for (const pi of processedItems) {
        const itemId = uuidv4()
        db.prepare(`
          INSERT INTO outbound_items (id, outbound_id, material_id, batch_id, batch_no, quantity, unit, unit_cost, total_cost, usage, receiver)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, id, pi.materialId, pi.batchId, pi.batchNo, pi.quantity, unitMap.get(pi.materialId) || 'pcs', pi.unitCost, pi.itemCost, pi.usage || 'self', pi.receiver || null)

        db.prepare('UPDATE inventory SET stock = stock - ? WHERE material_id = ?').run(pi.quantity, pi.materialId)
        if (pi.batchId) {
          db.prepare('UPDATE batches SET remaining = remaining - ? WHERE id = ?').run(pi.quantity, pi.batchId)
          const remaining = (db.prepare('SELECT remaining FROM batches WHERE id = ?').get(pi.batchId) as any)?.remaining
          if (remaining <= 0) {
            db.prepare('UPDATE batches SET status = 0 WHERE id = ?').run(pi.batchId)
          }
        }

        if ((pi.usage || 'self') === 'self' && pi.batchId) {
          const mat = db.prepare('SELECT name, spec FROM materials WHERE id = ? AND is_deleted = 0').get(pi.materialId) as any
          const trkId = `TRK-${Date.now()}-${Math.floor(Math.random() * 1000)}`
          const today = new Date().toISOString().split('T')[0]
          db.prepare(`
            INSERT INTO batch_usage_tracking
            (id, material_id, material_name, batch, spec, total_qty, remaining, unit, start_date, days_used, expected_days, progress, usage, receiver, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, 'in-use', datetime('now'), datetime('now'))
          `).run(trkId, pi.materialId, mat?.name || '', pi.batchNo || '', mat?.spec || '', pi.quantity, pi.quantity, unitMap.get(pi.materialId) || 'pcs', today, 30, 'self', null)
        }

        const logId = uuidv4()
        const beforeStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(pi.materialId) as any)?.stock || 0
        const afterStock = beforeStock - pi.quantity
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator)
          VALUES (?, 'outbound', ?, ?, ?, ?, ?, 'outbound', ?)
        `).run(logId, pi.materialId, -pi.quantity, beforeStock, afterStock, id, req.body.operator || 'system')
      }

      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }

    success(res, { id, totalCost: newTotalCost }, 'Outbound updated')
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', requireWriteAccess, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM outbound_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在', 'NOT_FOUND', 404); return }

    const items = db.prepare('SELECT * FROM outbound_items WHERE outbound_id = ?').all(id) as any[]

    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of items) {
        db.prepare('UPDATE inventory SET stock = stock + ? WHERE material_id = ?').run(item.quantity, item.material_id)
        if (item.batch_id) {
          db.prepare('UPDATE batches SET remaining = remaining + ?, status = 1 WHERE id = ?').run(item.quantity, item.batch_id)
        }
        if (item.batch_no) {
          db.prepare("DELETE FROM batch_usage_tracking WHERE material_id = ? AND batch = ? AND status = 'in-use'").run(item.material_id, item.batch_no)
        }
      }

      db.prepare('UPDATE outbound_records SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)

      for (const item of items) {
        const before = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(item.material_id) as any)?.stock || 0
        const after = before + item.quantity
        const logId = uuidv4()
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'delete', ?, ?, ?, ?, ?, 'outbound_delete', ?, '删除出库记录')
        `).run(logId, item.material_id, item.quantity, before, after, id, req.body.operator || 'system')
      }

      db.exec('COMMIT')
      success(res, null, '删除成功，库存已同步回退')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
