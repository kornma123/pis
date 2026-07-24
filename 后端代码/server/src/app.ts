import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import type { Server } from 'node:http'
import { initializeDatabase } from './database/DatabaseManager.js'
import { errorHandler } from './middleware/errorHandler.js'
import { authenticateToken } from './middleware/auth.js'
import { requirePermission } from './middleware/permissions.js'
import { auditWrite } from './middleware/audit-log.js'
import { isFixtureEnv } from './config/security.js'

// 路由导入
import authRoutes from './routes/auth.js'
import categoryRoutes from './routes/categories-v1.1.js'
import materialRoutes from './routes/materials.js'
import supplierRoutes from './routes/suppliers-v1.1.js'
import locationRoutes from './routes/locations-v1.1.js'
import inventoryRoutes from './routes/inventory-v1.1.js'
import inboundRoutes from './routes/inbound-v1.1.js'
import outboundRoutes from './routes/outbound-v1.1.js'
import projectRoutes from './routes/projects-v1.1.js'
import projectCatalogRoutes from './routes/project-catalog-v1.1.js'
import bomRoutes from './routes/bom-v1.1.js'
import reportRoutes from './routes/reports-v1.1.js'
import alertRoutes from './routes/alerts-v1.1.js'
import userRoutes from './routes/users-v1.1.js'
import roleRoutes from './routes/roles-v1.1.js'
import logRoutes from './routes/logs-v1.1.js'
import stocktakingRoutes from './routes/stocktaking-v1.1.js'
import returnRoutes from './routes/returns-v1.1.js'
import scrapRoutes from './routes/scraps-v1.1.js'
import purchaseOrderRoutes from './routes/purchase-orders-v1.1.js'
import transferRoutes from './routes/transfers-v1.1.js'
import supplierReturnRoutes from './routes/supplier-returns-v1.1.js'
import reconciliationRoutes from './routes/reconciliation-v1.1.js'
// ABC 成本核算路由（纯增量移植）
import equipmentRoutes from './routes/equipment-v1.1.js'
import equipmentTypeRoutes from './routes/equipment-types-v1.1.js'
import laborTimeRoutes from './routes/labor-time-v1.1.js'
import indirectCostRoutes from './routes/indirect-cost-v1.1.js'
import abcRoutes from './routes/abc-v1.1.js'
import costAdjustmentRoutes from './routes/cost-adjustment-v1.1.js'
import antibodyCostRoutes from './routes/antibody-cost-v1.1.js'
import accountReconcileRoutes from './routes/account-reconcile-v1.1.js'
// 按医院成本/盈利
import partnerRoutes from './routes/partners-v1.1.js'
import lisCaseRoutes from './routes/lis-cases-v1.1.js'
import caseRevenueRoutes from './routes/case-revenue-v1.1.js'
import partnerPnlRoutes from './routes/partner-pnl-v1.1.js'
import hospitalPnlRoutes from './routes/hospital-pnl-v1.1.js'
import ngsRoutes from './routes/ngs-v1.1.js'
// 配置驱动导入器（P4）：逐院配置单一事实源 + 对账单导入预览/归类
import partnerConfigRoutes from './routes/partner-config-v1.1.js'
import statementImportRoutes from './routes/statement-import-v1.1.js'
import statementBatchRoutes from './routes/statement-batches-v1.1.js'
import monthCloseRoutes from './routes/month-close-v1.1.js'
import {
  resolveAlertSchedulerConfig,
  startAlertScheduler,
  type AlertScheduler,
} from './services/alert-scheduler.js'

const app = express()
const PORT = process.env.PORT || 3001

// 中间件
app.use(cors())
// 显式声明请求体大小上限（express 默认即 100kb，这里写明以锁定意图、防止日后被无意放大）。
// LIS 病例导入走 JSON 体，行数上限在路由层（MAX_LIS_IMPORT_ROWS）兜底，此处再加一层体积约束。
app.use(express.json({ limit: '100kb' }))
app.use(express.urlencoded({ extended: true, limit: '100kb' }))

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  next()
})

// 全站写操作统一审计：给所有登录后的成功写操作留痕到 operation_logs（见 middleware/audit-log.ts）。
// 置于路由挂载之前——其 res.on('finish') 钩子在 authenticateToken 填充 req.user、业务处理完成之后触发，
// 故只记已鉴权且成功(2xx)的写；对读(GET)/公开接口(/auth 登录)/失败请求天然不记。
app.use(auditWrite)

// 初始化数据库
initializeDatabase()

// ABC-RETIRE-001：旧产品 API 保留稳定过渡语义，但在任何遗留 handler 前 fail-closed。
// 兼容 helper/表/字段仍由 hospital-cm、LIS、对账、BOM 与审计主线复用，本闸只封 HTTP 产品面。
const retiredProductApiPrefixes = [
  '/api/v1/auth/cost-visibility',
  '/api/v1/equipment',
  '/api/v1/equipment-types',
  '/api/v1/labor-times',
  '/api/v1/indirect-costs',
  '/api/v1/abc',
  '/api/v1/cost-adjustments',
  '/api/v1/partner-pnl',
]
const retiredProductApi = (_req: express.Request, res: express.Response) => {
  res.status(410).json({
    success: false,
    error: {
      code: 'FEATURE_RETIRED',
      message: '该产品能力已退役',
    },
  })
}
for (const prefix of retiredProductApiPrefixes) {
  app.use(prefix, authenticateToken, retiredProductApi)
}

// 路由注册 - 公开路由
app.use('/api/v1/auth', authRoutes)

// 路由注册 — 数据驱动 RBAC：挂载层按模块「读权限」放行（写权限由各路由内 requirePermission(module,'W') 守卫）。
// 单一事实源 = DB roles.permissions（matrix，可在「角色权限」页改，即时生效）。
app.use('/api/v1/users', authenticateToken, requirePermission('users', 'R'), userRoutes)
app.use('/api/v1/roles', authenticateToken, requirePermission('roles', 'R'), roleRoutes)

app.use('/api/v1/logs', authenticateToken, requirePermission('logs', 'R'), logRoutes)
app.use('/api/v1/reports', authenticateToken, requirePermission('cost_analysis', 'R'), reportRoutes)

app.use('/api/v1/inventory', authenticateToken, requirePermission('inventory', 'R'), inventoryRoutes)
app.use('/api/v1/alerts', authenticateToken, requirePermission('alerts', 'R'), alertRoutes)

app.use('/api/v1/inbound', authenticateToken, requirePermission('inbound', 'R'), inboundRoutes)
app.use('/api/v1/purchase-orders', authenticateToken, requirePermission('purchase_orders', 'R'), purchaseOrderRoutes)
app.use('/api/v1/suppliers', authenticateToken, requirePermission('suppliers', 'R'), supplierRoutes)

app.use('/api/v1/outbound', authenticateToken, requirePermission('outbound', 'R'), outboundRoutes)
app.use('/api/v1/stocktaking', authenticateToken, requirePermission('stocktaking', 'R'), stocktakingRoutes)
app.use('/api/v1/locations', authenticateToken, requirePermission('locations', 'R'), locationRoutes)
app.use('/api/v1/returns', authenticateToken, requirePermission('returns', 'R'), returnRoutes)
app.use('/api/v1/scraps', authenticateToken, requirePermission('scraps', 'R'), scrapRoutes)
app.use('/api/v1/transfers', authenticateToken, requirePermission('transfers', 'R'), transferRoutes)
app.use('/api/v1/supplier-returns', authenticateToken, requirePermission('supplier_returns', 'R'), supplierReturnRoutes)

app.use('/api/v1/projects', authenticateToken, requirePermission('projects', 'R'), projectRoutes)
// D2 统一检测项目目录（只读对照层）：复用 projects 权限，不新增权限模块
app.use('/api/v1/project-catalog', authenticateToken, requirePermission('projects', 'R'), projectCatalogRoutes)
app.use('/api/v1/boms', authenticateToken, requirePermission('bom', 'R'), bomRoutes)

// 成本对账：技术员 W（录入/提案），审批限 admin/finance/lab_director（路由内 requireAnyRole 守卫）
app.use('/api/v1/reconciliation', authenticateToken, requirePermission('reconciliation', 'R'), reconciliationRoutes)

app.use('/api/v1/categories', authenticateToken, requirePermission('categories', 'R'), categoryRoutes)
app.use('/api/v1/materials', authenticateToken, requirePermission('materials', 'R'), materialRoutes)

// ABC 成本核算（设备/工时主数据 + 成本工作台）
app.use('/api/v1/equipment', authenticateToken, requirePermission('equipment', 'R'), equipmentRoutes)
app.use('/api/v1/equipment-types', authenticateToken, requirePermission('equipment', 'R'), equipmentTypeRoutes)
app.use('/api/v1/labor-times', authenticateToken, requirePermission('labor_times', 'R'), laborTimeRoutes)
app.use('/api/v1/indirect-costs', authenticateToken, requirePermission('abc_config', 'R'), indirectCostRoutes)
app.use('/api/v1/abc', authenticateToken, requirePermission('abc_dashboard', 'R'), abcRoutes)
app.use('/api/v1/cost-adjustments', authenticateToken, requirePermission('cost_analysis', 'R'), costAdjustmentRoutes)
app.use('/api/v1/antibody-cost', authenticateToken, requirePermission('antibody_cost', 'R'), antibodyCostRoutes)
app.use('/api/v1/account-reconcile', authenticateToken, requirePermission('account_reconcile', 'R'), accountReconcileRoutes)

// 按医院成本/盈利：合作医院（客户）维度 CRUD（W2）。读 partners R，写由路由内 requirePermission('partners','W') 守卫。
app.use('/api/v1/partners', authenticateToken, requirePermission('partners', 'R'), partnerRoutes)
// LIS 病例导入/列表/样本覆盖（W3）。读 reconciliation R，写由路由内 requirePermission('reconciliation','W') 守卫。
app.use('/api/v1/lis-cases', authenticateToken, requirePermission('reconciliation', 'R'), lisCaseRoutes)
// 财务收费单据→逐 case 实收导入（W4）。读 reconciliation R，写由路由内 requirePermission('reconciliation','W') 守卫。
app.use('/api/v1/case-revenue', authenticateToken, requirePermission('reconciliation', 'R'), caseRevenueRoutes)
// 院级 P&L 视图 + ABC 成本维度回填（W6/W5）。读权限由路由内 cost_analysis R 守卫（成本敏感）。
app.use('/api/v1/partner-pnl', authenticateToken, partnerPnlRoutes)
// 院级贡献毛利（P0 内圈·标准成本口径·四轮外审收敛两层框架）。与 partner-pnl 并存(ADR-003)·读权限路由内 cost_analysis R 守卫·零 MODULES 漂移。
app.use('/api/v1/hospital-pnl', authenticateToken, hospitalPnlRoutes)
// NGS 基因检测外购转销（独立渠道）：订单导入/产品目录/院级 NGS P&L。读写权限由路由内守卫（reconciliation W / cost_analysis R）。
app.use('/api/v1/ngs', authenticateToken, ngsRoutes)
// 配置驱动导入器（P4）：逐院配置单一事实源（CRUD/版本/回滚/基线）。权限由路由内守卫（财务/管理员）。
app.use('/api/v1/partner-config', authenticateToken, partnerConfigRoutes)
// 对账单导入（P4）：预览(干跑) + 归类写回该院配置。权限由路由内守卫（财务/管理员）。
app.use('/api/v1/statement-import', authenticateToken, statementImportRoutes)
// Phase 1A 月结子账本：与既有逐病例 statement-import/account-reconcile 分离，固定 statement_internal 口径。
app.use('/api/v1/statement-batches', authenticateToken, statementBatchRoutes)
app.use('/api/v1/month-close', authenticateToken, monthCloseRoutes)

// 健康检查
app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', version: '1.1.0' } })
})

// 错误处理
app.use(errorHandler)

// 404处理
app.use((_req, res) => {
  res.status(404).json({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } })
})

export interface ServerRuntime {
  server: Server
  stop(): Promise<void>
  dispose(): Promise<void>
}

export interface StartServerOptions {
  host?: string
  port?: number
  schedulerEnv?: NodeJS.ProcessEnv
}

let activeServerRuntime: ServerRuntime | undefined

export function startServer(options: StartServerOptions = {}): ServerRuntime {
  if (activeServerRuntime) {
    throw new Error('COREONE server runtime is already active')
  }

  const schedulerConfig = resolveAlertSchedulerConfig(options.schedulerEnv)
  const host = options.host ?? (isFixtureEnv() ? '127.0.0.1' : '0.0.0.0')
  const port = options.port ?? Number(PORT)
  let scheduler: AlertScheduler | undefined
  let stopPromise: Promise<void> | undefined
  let stopped = false
  let hasListened = false
  const server = app.listen(port, host, () => {
    hasListened = true
    if (stopped) return
    scheduler = startAlertScheduler({ config: schedulerConfig })
    console.log(`COREONE Backend Server running on ${host}:${port}`)
    console.log(`API Base URL: http://localhost:${port}/api/v1`)
  })

  const releaseActiveRuntime = (): void => {
    if (activeServerRuntime === runtime) activeServerRuntime = undefined
  }

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopped = true
    scheduler?.stop()
    stopPromise = new Promise((resolve, reject) => {
      const closeListeningServer = (): void => {
        server.close(error => {
          releaseActiveRuntime()
          if (error) reject(error)
          else resolve()
        })
      }

      if (server.listening) {
        closeListeningServer()
        return
      }
      if (hasListened) {
        releaseActiveRuntime()
        resolve()
        return
      }

      const onListening = (): void => {
        server.off('error', onStartupError)
        closeListeningServer()
      }
      const onStartupError = (error: Error): void => {
        server.off('listening', onListening)
        releaseActiveRuntime()
        reject(error)
      }
      server.once('listening', onListening)
      server.once('error', onStartupError)
    })
    return stopPromise
  }

  const runtime: ServerRuntime = { server, stop, dispose: stop }
  activeServerRuntime = runtime
  return runtime
}

let automaticServerRuntime: ServerRuntime | undefined

export function getAutomaticServerRuntime(): ServerRuntime | undefined {
  return automaticServerRuntime
}

// 测试环境下不自动启动服务器（测试用 supertest 的 request(app)，无需常驻端口）
if (process.env.NODE_ENV !== 'test') {
  automaticServerRuntime = startServer()
  const shutdown = (): void => {
    void automaticServerRuntime?.dispose().catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

export default app
