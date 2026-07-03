import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'

const router = Router()

function generateNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `ST-${date}-${timestamp}-${random}`
}

function generateSheetNo(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const timestamp = Date.now().toString().slice(-6)
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0')
  return `STS-${date}-${timestamp}-${random}`
}

router.get('/', (req, res) => {
  try {
    let { page = 1, pageSize = 20, keyword } = req.query
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) { where += ' AND (stocktaking_no LIKE ? OR material_name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    const count = (db.prepare(`SELECT COUNT(*) as total FROM stocktaking_records WHERE ${where}`).get(...params) as any)?.total || 0
    const offset = (page - 1) * pageSize
    const list = db.prepare(`SELECT * FROM stocktaking_records WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]
    successList(res, list.map((r: any) => ({
      id: r.id, stocktakingNo: r.stocktaking_no, sheetNo: r.sheet_no, materialId: r.material_id,
      systemStock: r.system_stock, actualStock: r.actual_stock,
      difference: r.difference, operator: r.operator, status: r.status,
      remark: r.remark, createdAt: r.created_at,
    })), Number(page), Number(pageSize), count)
  } catch (err: any) { error(res, err.message) }
})

router.post('/', (req, res) => {
  try {
    const { materialId, actualStock, operator, remark } = req.body
    if (!materialId || actualStock === undefined) { error(res, 'Missing fields', 'INVALID_PARAMETER', 400); return }
    if (isNaN(Number(actualStock))) { error(res, 'Invalid actual stock', 'INVALID_PARAMETER', 400); return }
    if (Number(actualStock) < 0) { error(res, 'actualStock 不能为负数', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    const material = db.prepare('SELECT 1 FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)
    if (!material) { error(res, '物料不存在或已删除', 'NOT_FOUND', 404); return }

    // 两阶段·第一阶段「登记」：只记录盘点结果，不入账（不改 inventory、不写 stock_logs）。
    // 差异=0 → completed（账实相符，无需入账）；差异≠0 → pending（待「处理差异」入账）。
    // 真正的库存调整改由 POST /:id/adjust 完成，把「清点」与「审批入账」拆成两步（内控分离）。
    const systemStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock || 0
    const difference = Number(actualStock) - Number(systemStock)
    const status = difference === 0 ? 'completed' : 'pending'
    const id = uuidv4()
    db.prepare('INSERT INTO stocktaking_records (id, stocktaking_no, material_id, system_stock, actual_stock, difference, operator, status, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, generateNo(), materialId, systemStock, Number(actualStock), difference, operator || 'system', status, remark || null)

    success(res, { id, status }, '盘点记录已创建')
  } catch (err: any) { error(res, err.message) }
})

// 差异原因白名单（受控口径，与前端弹窗 select 一致；非白名单一律拒绝，防手写脏原因）
const ADJUST_REASONS: Record<string, string> = {
  normal: '正常损耗',
  record: '账务问题',
  physical: '实物问题',
  other: '其他',
}

/**
 * 处理盘点差异（两阶段·第二阶段「入账」）——仅对 pending 记录生效。
 * body: { reason: normal|record|physical|other, remark? }
 * - 受控原因校验：非白名单 → 400，无任何库存副作用。
 * - 幂等：非 pending（completed/confirmed/…）→ 400，防重复入账把库存双计。
 * - 防过期：入账前若账面已不等于创建时快照(system_stock) → 409，不入账（防旧盘点覆盖期间发生的新库存变动）。
 * - 入账 = inventory.stock 改到实盘 + 写 stock_logs 'adjust' + status='confirmed' + 差异原因/说明落 remark。
 * - 操作人以登录用户(req.user)为准，忽略 body 伪造；成功写操作由全局 auditWrite 统一留痕 operation_logs。
 */
router.post('/:id/adjust', (req, res) => {
  try {
    const { id } = req.params
    const { reason, remark } = req.body
    const operator = (req as any).user?.username || 'system'
    // 用 own-property 校验做白名单，避免 constructor/toString 等原型链键绕过 `if (!label)`（原型污染式脏原因）。
    // 用 Object.prototype.hasOwnProperty.call（而非 Object.hasOwn）以免依赖 ES2022 运行时/lib。
    const hasReason = Object.prototype.hasOwnProperty.call(ADJUST_REASONS, reason)
    const label = (typeof reason === 'string' && hasReason) ? ADJUST_REASONS[reason] : undefined
    if (!label) { error(res, '差异原因无效', 'INVALID_PARAMETER', 400); return }

    const db = getDatabase()
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }
    if (record.status !== 'pending') { error(res, '该盘点差异已处理，不可重复调整', 'ALREADY_ADJUSTED', 400); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      const systemStock = record.system_stock
      const currentStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any)?.stock ?? 0
      // 防过期：账面已变（期间发生了出入库）→ 拒绝用旧盘点结果覆盖当前库存
      if (Number(currentStock) !== Number(systemStock)) {
        db.exec('ROLLBACK')
        error(res, '当前库存已变化，请重新盘点后再处理', 'STOCK_CHANGED', 409)
        return
      }
      const actualStock = record.actual_stock
      const difference = record.difference

      db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(actualStock, record.material_id)
      // 负库存兜底
      const afterStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any)?.stock
      if (Number(afterStock) < 0) {
        db.exec('ROLLBACK')
        error(res, '库存不能为负数', 'STOCK_NEGATIVE', 422)
        return
      }

      const noteText = String(remark || '').trim()
      const reasonNote = noteText ? `差异原因：${label}；处理说明：${noteText}` : `差异原因：${label}`
      const logId = uuidv4()
      db.prepare('INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(logId, 'adjust', record.material_id, difference, systemStock, actualStock, id, 'stocktaking', operator, reasonNote)

      const mergedRemark = record.remark ? `${record.remark} ｜ ${reasonNote}` : reasonNote
      db.prepare("UPDATE stocktaking_records SET status = 'confirmed', remark = ? WHERE id = ?").run(mergedRemark, id)

      db.exec('COMMIT')
      success(res, { id, status: 'confirmed' }, '盘点差异已处理，库存已更新')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

/**
 * 批量盘点：一次事务提交多物料盘点，同一 sheet_no 归组。
 * 全行预校验，任一行非法 → 整单 422 回滚（all-or-nothing），不写任何记录、不动库存。
 * body: { items: [{ materialId, actualStock, remark? }], operator?, remark? }
 */
router.post('/batch', (req, res) => {
  try {
    const { items, operator, remark } = req.body
    if (!Array.isArray(items) || items.length === 0) {
      error(res, '盘点明细不能为空', 'INVALID_PARAMETER', 400); return
    }

    const db = getDatabase()

    // ── 全行预校验（任一非法整单拒绝，未进事务前不写任何数据）──
    const seen = new Set<string>()
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const rowLabel = `第 ${i + 1} 行`
      if (!it || typeof it !== 'object') { error(res, `${rowLabel}格式错误`, 'INVALID_PARAMETER', 422); return }
      const { materialId, actualStock } = it
      if (!materialId || actualStock === undefined || actualStock === null) {
        error(res, `${rowLabel}缺少物料或实盘数量`, 'INVALID_PARAMETER', 422); return
      }
      if (isNaN(Number(actualStock))) { error(res, `${rowLabel}实盘数量无效`, 'INVALID_PARAMETER', 422); return }
      if (Number(actualStock) < 0) { error(res, `${rowLabel}实盘数量不能为负数`, 'INVALID_PARAMETER', 422); return }
      if (seen.has(materialId)) { error(res, `${rowLabel}物料重复`, 'INVALID_PARAMETER', 422); return }
      seen.add(materialId)
      const material = db.prepare('SELECT 1 FROM materials WHERE id = ? AND is_deleted = 0').get(materialId)
      if (!material) { error(res, `${rowLabel}物料不存在或已删除`, 'NOT_FOUND', 422); return }
    }

    // ── 全行合法，单事务内创建（all-or-nothing）──
    const sheetNo = generateSheetNo()
    const op = operator || 'system'
    db.exec('BEGIN IMMEDIATE')
    try {
      const ids: string[] = []
      for (const it of items) {
        const { materialId, actualStock, remark: rowRemark } = it
        const systemStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock || 0
        const difference = Number(actualStock) - Number(systemStock)
        const id = uuidv4()
        ids.push(id)
        db.prepare('INSERT INTO stocktaking_records (id, stocktaking_no, sheet_no, material_id, system_stock, actual_stock, difference, operator, remark) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, generateNo(), sheetNo, materialId, systemStock, actualStock, difference, op, rowRemark || remark || null)

        if (difference !== 0) {
          db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(actualStock, materialId)
          const afterStock = (db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(materialId) as any)?.stock
          if (afterStock < 0) {
            db.exec('ROLLBACK')
            error(res, '库存不能为负数', 'STOCK_NEGATIVE', 422)
            return
          }
          const logId = uuidv4()
          db.prepare('INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(logId, 'adjust', materialId, difference, systemStock, actualStock, id, 'stocktaking', op)
        }
      }

      db.exec('COMMIT')
      success(res, { sheetNo, count: ids.length, ids }, '批量盘点完成', 201)
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

router.delete('/:id', (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    const record = db.prepare('SELECT * FROM stocktaking_records WHERE id = ? AND is_deleted = 0').get(id) as any
    if (!record) { error(res, '记录不存在或已删除', 'NOT_FOUND', 404); return }

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE stocktaking_records SET is_deleted = 1 WHERE id = ?').run(id)

      // 仅回滚**已入账**的差异：pending 从未动过库存（两阶段第一步只登记）→ 只软删不回滚；
      // confirmed（单条已处理）/ completed（批量或旧数据，创建即入账）+ 差异≠0 → 回滚到账面。
      if (record.difference !== 0 && record.status !== 'pending') {
        const inv = db.prepare('SELECT stock FROM inventory WHERE material_id = ?').get(record.material_id) as any
        const beforeStock = inv?.stock || 0
        const afterStock = record.system_stock
        db.prepare('UPDATE inventory SET stock = ? WHERE material_id = ?').run(afterStock, record.material_id)

        const logId = uuidv4()
        db.prepare(`
          INSERT INTO stock_logs (id, type, material_id, quantity, before_stock, after_stock, related_id, related_type, operator, remark)
          VALUES (?, 'cancel', ?, ?, ?, ?, ?, 'stocktaking_cancel', ?, '撤销盘点记录')
        `).run(logId, record.material_id, record.system_stock - beforeStock, beforeStock, afterStock, id, req.body.operator || 'system')
      }

      db.exec('COMMIT')
      success(res, null, '盘点记录已撤销')
    } catch (e: any) {
      db.exec('ROLLBACK')
      throw e
    }
  } catch (err: any) { error(res, err.message) }
})

export default router
