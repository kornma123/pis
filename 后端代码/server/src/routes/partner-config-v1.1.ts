/**
 * 逐院配置 API（配置驱动导入器 P4）—— 配置页/测试台/月度向导共享的单一事实源读写。
 * RBAC：配置页「仅财务/管理员」→ requireAnyRole('finance')（admin 始终放行）。
 *
 * GET /:id            取配置（首访默认 seed）
 * PUT /:id            保存（生成版本+变更；乐观锁 expectedVersion 防并发覆盖）
 * GET /:id/changes    变更记录（调整前→后）
 * POST /:id/rollback  回滚到某版本（不抹历史，生成新版本）
 * POST /:id/baseline  设某版本为月度导入基线
 */
import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, successList, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireAnyRole } from '../middleware/permissions.js'
import { loadConfig, saveConfig, getChanges, rollbackConfig, setBaseline, normalizeConfig, caliberSignature, getConfigVersion } from '../utils/partner-config.js'

const router = Router()
const requireConfig = requireAnyRole('finance') // 财务 + 管理员（admin 始终放行）
const genId = (): string => `PC-${uuidv4()}`
const userId = (req: any): string | undefined => req.user?.id
/** 拆分/诊断口径 = 领域决策，仅 admin 可改（财务只配 in/out + 扣率 + 识别词）。 */
const isAdmin = (req: any): boolean => req.user?.role === 'admin' || (req.user?.roles ?? []).includes('admin')

function partnerExists(db: any, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM partners WHERE id = ? AND is_deleted = 0').get(id)
}

// 合作医院列表（配置页/测试台/向导左侧选院）。**按配置权限(财务/管理员)守卫**——
// 财务无 partners 模块能力，故不能走 /partners；这里在配置域内提供，口径与配置写一致。
router.get('/', authenticateToken, requireConfig, (req, res) => {
  try {
    const db = getDatabase()
    const keyword = (req.query.keyword as string) || ''
    let where = 'is_deleted = 0'
    const params: unknown[] = []
    if (keyword) { where += ' AND (name LIKE ? OR code LIKE ?)'; params.push(`%${keyword}%`, `%${keyword}%`) }
    const rows = db.prepare(`SELECT id, code, name, short_name, service_scope, status FROM partners WHERE ${where} ORDER BY name LIMIT 300`).all(...params) as any[]
    successList(res, rows.map((r) => ({ id: r.id, code: r.code, name: r.name, shortName: r.short_name, serviceScope: r.service_scope, status: r.status === 1 ? 'active' : 'inactive' })), 1, rows.length, rows.length)
  } catch (e: any) { error(res, e.message) }
})

router.get('/:id', authenticateToken, requireConfig, (req, res) => {
  try {
    const db = getDatabase()
    if (!partnerExists(db, req.params.id)) { error(res, '医院不存在', 'NOT_FOUND', 404); return }
    const r = loadConfig(db, req.params.id, genId)
    success(res, { partnerId: req.params.id, version: r.version, isBaseline: r.isBaseline, config: r.config })
  } catch (e: any) { error(res, e.message) }
})

router.put('/:id', authenticateToken, requireConfig, (req, res) => {
  try {
    const db = getDatabase()
    if (!partnerExists(db, req.params.id)) { error(res, '医院不存在', 'NOT_FOUND', 404); return }
    const { config, expectedVersion, tab } = req.body as any
    // codex HIGH-4 + MEDIUM-1：保存前归一扣率(90→0.9)+校验形状；非法不写版本，返回 400。
    let normalized
    try { normalized = normalizeConfig(config) } catch (ve: any) { error(res, ve.message || '配置格式无效', 'BAD_REQUEST', 400); return }
    const cur = loadConfig(db, req.params.id, genId) // 确保已 seed + 取现配置比对口径
    // 拆分/诊断口径门禁：本次改动了 split/diagnosis 线 → 仅 admin 可写（财务写 in/out + 扣率不受影响）。
    if (caliberSignature(normalized) !== caliberSignature(cur.config) && !isAdmin(req)) {
      error(res, '拆分/诊断口径仅管理员可改（国标费率与工艺拆分是口径决策，财务侧只读）', 'FORBIDDEN', 403); return
    }
    const r = saveConfig(db, req.params.id, normalized, { changedBy: userId(req), tab, genId, expectedVersion })
    success(res, { partnerId: req.params.id, version: r.version, diffs: r.diffs }, r.diffs.length ? `已保存 v${r.version}（${r.diffs.length} 项变更）` : '无改动')
  } catch (e: any) {
    if (/版本冲突/.test(e.message)) { error(res, e.message, 'CONFLICT', 409); return }
    error(res, e.message)
  }
})

router.get('/:id/changes', authenticateToken, requireConfig, (req, res) => {
  try {
    success(res, getChanges(getDatabase(), req.params.id))
  } catch (e: any) { error(res, e.message) }
})

router.post('/:id/rollback', authenticateToken, requireConfig, (req, res) => {
  try {
    const db = getDatabase()
    if (!partnerExists(db, req.params.id)) { error(res, '医院不存在', 'NOT_FOUND', 404); return }
    const toVersion = Number((req.body as any)?.toVersion)
    if (!Number.isFinite(toVersion)) { error(res, 'toVersion 无效', 'BAD_REQUEST', 400); return }
    // 口径门禁：回滚到的版本若拆分线与现配置不同（等于借回滚改口径）→ 仅 admin。
    const target = getConfigVersion(db, req.params.id, toVersion)
    if (target && caliberSignature(target) !== caliberSignature(loadConfig(db, req.params.id, genId).config) && !isAdmin(req)) {
      error(res, '回滚会改动拆分/诊断口径，仅管理员可操作', 'FORBIDDEN', 403); return
    }
    const r = rollbackConfig(db, req.params.id, toVersion, { changedBy: userId(req), genId })
    success(res, { partnerId: req.params.id, version: r.version }, `已回滚到 v${toVersion}（生成新版本 v${r.version}）`)
  } catch (e: any) {
    if (/找不到版本/.test(e.message)) { error(res, e.message, 'NOT_FOUND', 404); return }
    error(res, e.message)
  }
})

router.post('/:id/baseline', authenticateToken, requireConfig, (req, res) => {
  try {
    const db = getDatabase()
    if (!partnerExists(db, req.params.id)) { error(res, '医院不存在', 'NOT_FOUND', 404); return }
    const version = Number((req.body as any)?.version)
    if (!Number.isFinite(version)) { error(res, 'version 无效', 'BAD_REQUEST', 400); return }
    setBaseline(db, req.params.id, version, { changedBy: userId(req) })
    success(res, { partnerId: req.params.id, baselineVersion: version }, `已设 v${version} 为月度导入基线`)
  } catch (e: any) {
    if (/找不到版本/.test(e.message)) { error(res, e.message, 'NOT_FOUND', 404); return }
    error(res, e.message)
  }
})

export default router
