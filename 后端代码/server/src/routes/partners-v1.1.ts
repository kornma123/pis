/**
 * 合作医院（partner）CRUD —— 按医院成本/盈利的客户维度（W2）。
 * RBAC：读 requirePermission('partners','R')；写 'W'（种子授权 finance R / lab_director W / 诊断·技术线无写）。
 * service_scope（technical_only / with_diagnosis）决定该院收入取哪些组分（见收费引擎 computeCaseSplit）。
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requirePermission } from '../middleware/permissions.js'
import { findOrCreatePartner, type ServiceScope } from '../utils/partner-upsert.js'

const router = Router()
const requireRead = requirePermission('partners', 'R')
const requireWrite = requirePermission('partners', 'W')

const SCOPES: ServiceScope[] = ['technical_only', 'with_diagnosis']
const mapRow = (r: any) => ({
  id: r.id, code: r.code, name: r.name, shortName: r.short_name,
  contact: r.contact, phone: r.phone, address: r.address, contractNo: r.contract_no,
  serviceScope: r.service_scope, status: r.status === 1 ? 'active' : 'inactive',
  createdAt: r.created_at, updatedAt: r.updated_at,
})

router.get('/', authenticateToken, requireRead, (req, res) => {
  try {
    let { page = 1, pageSize = 20, keyword, status, serviceScope } = req.query as any
    page = Math.max(1, Number(page) || 1)
    pageSize = Math.max(1, Math.min(100, Number(pageSize) || 20))
    const db = getDatabase()
    let where = 'is_deleted = 0'
    const params: any[] = []
    if (keyword) { where += ' AND (name LIKE ? OR code LIKE ? OR short_name LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) }
    if (status) { where += ' AND status = ?'; params.push(status === 'active' ? 1 : 0) }
    if (serviceScope) { where += ' AND service_scope = ?'; params.push(serviceScope) }

    const total = (db.prepare(`SELECT COUNT(*) AS t FROM partners WHERE ${where}`).get(...params) as any)?.t || 0
    const offset = (page - 1) * pageSize
    const list = db.prepare(`SELECT * FROM partners WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset) as any[]
    successList(res, list.map(mapRow), page, pageSize, total)
  } catch (err: any) { error(res, err.message) }
})

router.get('/:id', authenticateToken, requireRead, (req, res) => {
  try {
    const db = getDatabase()
    const r = db.prepare('SELECT * FROM partners WHERE id = ? AND is_deleted = 0').get(req.params.id)
    if (!r) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    success(res, mapRow(r))
  } catch (err: any) { error(res, err.message) }
})

router.post('/', authenticateToken, requireWrite, (req, res) => {
  try {
    const { name, shortName, contact, phone, address, contractNo, serviceScope } = req.body
    if (!name || !String(name).trim()) { error(res, '医院名称必填', 'INVALID_PARAMETER', 400); return }
    if (serviceScope && !SCOPES.includes(serviceScope)) { error(res, 'serviceScope 非法', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    // 名称已存在（未删）→ 冲突，避免重复建院
    if (db.prepare('SELECT 1 FROM partners WHERE name = ? AND is_deleted = 0').get(String(name).trim())) {
      error(res, '同名医院已存在', 'RESOURCE_CONFLICT', 409); return
    }
    const ref = findOrCreatePartner(db, name, uuidv4, { serviceScope: serviceScope || 'technical_only', createdBy: (req as any).user?.id })
    // 建后补充可选字段
    db.prepare('UPDATE partners SET short_name = ?, contact = ?, phone = ?, address = ?, contract_no = ? WHERE id = ?')
      .run(shortName || null, contact || null, phone || null, address || null, contractNo || null, ref.id)
    success(res, { id: ref.id, code: ref.code }, 'Created', 201)
  } catch (err: any) {
    if (String(err.message).includes('UNIQUE')) { error(res, 'code 冲突', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.put('/:id', authenticateToken, requireWrite, (req, res) => {
  try {
    const { id } = req.params
    const d = req.body
    // 与 POST 同级校验：name 非空白、serviceScope/status 合法、code 非空白（避免脏数据进库）
    if (d.serviceScope !== undefined && !SCOPES.includes(d.serviceScope)) { error(res, 'serviceScope 非法', 'INVALID_PARAMETER', 400); return }
    if (d.name !== undefined && !String(d.name).trim()) { error(res, '医院名称不能为空', 'INVALID_PARAMETER', 400); return }
    if (d.code !== undefined && !String(d.code).trim()) { error(res, 'code 不能为空', 'INVALID_PARAMETER', 400); return }
    if (d.status !== undefined && !['active', 'inactive'].includes(d.status)) { error(res, 'status 只接受 active/inactive', 'INVALID_PARAMETER', 400); return }
    const db = getDatabase()
    if (!db.prepare('SELECT 1 FROM partners WHERE id = ? AND is_deleted = 0').get(id)) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    const fields: string[] = []; const params: any[] = []
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val) }
    if (d.code !== undefined) set('code', String(d.code).trim())
    if (d.name !== undefined) set('name', String(d.name).trim())
    if (d.shortName !== undefined) set('short_name', d.shortName)
    if (d.contact !== undefined) set('contact', d.contact)
    if (d.phone !== undefined) set('phone', d.phone)
    if (d.address !== undefined) set('address', d.address)
    if (d.contractNo !== undefined) set('contract_no', d.contractNo)
    if (d.serviceScope !== undefined) set('service_scope', d.serviceScope)
    if (d.status !== undefined) set('status', d.status === 'active' ? 1 : 0)
    if (fields.length) { params.push(id); db.prepare(`UPDATE partners SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND is_deleted = 0`).run(...params) }
    success(res, { id }, 'Updated')
  } catch (err: any) {
    if (String(err.message).includes('UNIQUE')) { error(res, 'code 冲突', 'RESOURCE_CONFLICT', 409); return }
    error(res, err.message)
  }
})

router.delete('/:id', authenticateToken, requireWrite, (req, res) => {
  try {
    const { id } = req.params
    const db = getDatabase()
    if (!db.prepare('SELECT 1 FROM partners WHERE id = ? AND is_deleted = 0').get(id)) { error(res, 'Not found', 'NOT_FOUND', 404); return }
    db.prepare('UPDATE partners SET is_deleted = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
    success(res, null, 'Deleted')
  } catch (err: any) { error(res, err.message) }
})

export default router
