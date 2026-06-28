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
import { success, error } from '../utils/response.js'
import { authenticateToken } from '../middleware/auth.js'
import { requireAnyRole } from '../middleware/permissions.js'
import { loadConfig, saveConfig, getChanges, rollbackConfig, setBaseline } from '../utils/partner-config.js'

const router = Router()
const requireConfig = requireAnyRole('finance') // 财务 + 管理员（admin 始终放行）
const genId = (): string => `PC-${uuidv4()}`
const userId = (req: any): string | undefined => req.user?.id

function partnerExists(db: any, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM partners WHERE id = ? AND is_deleted = 0').get(id)
}

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
    if (!config || !Array.isArray(config.lines)) { error(res, '配置格式无效（缺 lines）', 'BAD_REQUEST', 400); return }
    loadConfig(db, req.params.id, genId) // 确保已 seed
    const r = saveConfig(db, req.params.id, config, { changedBy: userId(req), tab, genId, expectedVersion })
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
