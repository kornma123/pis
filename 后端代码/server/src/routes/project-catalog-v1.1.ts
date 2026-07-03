/**
 * 统一检测项目目录 API（只读）—— D2 地基线 D。
 *
 * 只读对照层：把四套/五套叫法查到同一个标准项(PC-*)。**不改任何现有分类逻辑**（先并存）。
 * 权限：挂载层 requirePermission('projects','R')——复用现有 projects 模块，不新增权限模块（避免前后端 MODULES 漂移）。
 * 口径/建表/种子全在 utils/project-catalog.ts。本路由只做读，无任何写端点。
 */
import { Router } from 'express'
import { getDatabase } from '../database/DatabaseManager.js'
import { success, error } from '../utils/response.js'
import {
  listCatalog, getCatalogItem, getAliasesForCatalog, lookupProject,
  listReviewQueue, catalogSummary, type AliasSystem,
} from '../utils/project-catalog.js'

const router = Router()

const VALID_SYSTEMS: AliasSystem[] = ['project_code', 'guobiao_code', 'local_price_code', 'lis_name', 'lis_advice_type', 'statement_item']
const asSystem = (v: unknown): AliasSystem | undefined => (VALID_SYSTEMS.includes(v as AliasSystem) ? (v as AliasSystem) : undefined)

// GET /  —— 概览：标准项清单 + 汇总计数
router.get('/', (_req, res) => {
  try {
    const db = getDatabase()
    success(res, { catalog: listCatalog(db), summary: catalogSummary(db) })
  } catch (err: any) { error(res, err.message) }
})

// GET /catalog  —— 标准项清单
router.get('/catalog', (_req, res) => {
  try {
    success(res, listCatalog(getDatabase()))
  } catch (err: any) { error(res, err.message) }
})

// GET /catalog/:code/aliases  —— 某标准项的全部别名（反查）
router.get('/catalog/:code/aliases', (req, res) => {
  try {
    const db = getDatabase()
    const item = getCatalogItem(db, req.params.code)
    if (!item) return error(res, '标准项不存在', 'NOT_FOUND', 404)
    success(res, { catalog: item, aliases: getAliasesForCatalog(db, req.params.code) })
  } catch (err: any) { error(res, err.message) }
})

// GET /lookup?alias=&system=  —— 按任一叫法查规范项目（未命中返回 matched:false，不报错）
router.get('/lookup', (req, res) => {
  try {
    const alias = String(req.query.alias ?? '').trim()
    if (!alias) return error(res, '缺 alias', 'BAD_REQUEST', 400)
    const sysRaw = req.query.system ? String(req.query.system) : undefined
    if (sysRaw && !asSystem(sysRaw)) return error(res, `system 需为 ${VALID_SYSTEMS.join('/')} 之一`, 'BAD_REQUEST', 400)
    success(res, lookupProject(getDatabase(), alias, asSystem(sysRaw)))
  } catch (err: any) { error(res, err.message) }
})

// GET /review-queue?system=&limit=  —— 待校对只读清单（🔴 层：needs_review/未映射/低置信）
router.get('/review-queue', (req, res) => {
  try {
    const sysRaw = req.query.system ? String(req.query.system) : undefined
    if (sysRaw && !asSystem(sysRaw)) return error(res, `system 需为 ${VALID_SYSTEMS.join('/')} 之一`, 'BAD_REQUEST', 400)
    const limit = req.query.limit ? Math.max(0, Math.min(2000, Number(req.query.limit) || 0)) : undefined
    const rows = listReviewQueue(getDatabase(), { system: asSystem(sysRaw), limit })
    success(res, { count: rows.length, rows })
  } catch (err: any) { error(res, err.message) }
})

// GET /summary  —— 汇总计数
router.get('/summary', (_req, res) => {
  try {
    success(res, catalogSummary(getDatabase()))
  } catch (err: any) { error(res, err.message) }
})

export default router
