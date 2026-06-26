import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { initializeDatabase } from './database/DatabaseManager.js'
import { errorHandler } from './middleware/errorHandler.js'
import { authenticateToken, requireRole, requireCostWorkbenchAccess } from './middleware/auth.js'

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
import bomRoutes from './routes/bom-v1.1.js'
import reportRoutes from './routes/reports-v1.1.js'
import alertRoutes from './routes/alerts-v1.1.js'
import userRoutes from './routes/users-v1.1.js'
import roleRoutes from './routes/roles-v1.1.js'
import logRoutes from './routes/logs-v1.1.js'
import stocktakingRoutes from './routes/stocktaking-v1.1.js'
import returnRoutes from './routes/returns-v1.1.js'
import scrapRoutes from './routes/scraps-v1.1.js'
import depletionRoutes from './routes/depletion-v1.1.js'
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

const app = express()
const PORT = process.env.PORT || 3001

// 中间件
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
  next()
})

// 初始化数据库
initializeDatabase()

// 路由注册 - 公开路由
app.use('/api/v1/auth', authRoutes)

// 路由注册 - admin专属
app.use('/api/v1/users', authenticateToken, requireRole('admin'), userRoutes)
app.use('/api/v1/roles', authenticateToken, requireRole('admin'), roleRoutes)

// 路由注册 - finance可访问
app.use('/api/v1/logs', authenticateToken, requireRole('admin'), logRoutes)
app.use('/api/v1/reports', authenticateToken, requireRole('admin', 'pathologist', 'finance'), reportRoutes)
app.use('/api/v1/depletion', authenticateToken, requireRole('admin', 'pathologist', 'finance'), depletionRoutes)

// 路由注册 - warehouse/technician/pathologist/procurement共享 (库存/预警)
app.use('/api/v1/inventory', authenticateToken, requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement'), inventoryRoutes)
app.use('/api/v1/alerts', authenticateToken, requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance'), alertRoutes)

// 路由注册 - warehouse/procurement共享 (入库相关)
app.use('/api/v1/inbound', authenticateToken, requireRole('admin', 'warehouse_manager', 'procurement'), inboundRoutes)
app.use('/api/v1/purchase-orders', authenticateToken, requireRole('admin', 'procurement'), purchaseOrderRoutes)
app.use('/api/v1/suppliers', authenticateToken, requireRole('admin', 'warehouse_manager', 'procurement'), supplierRoutes)

// 路由注册 - warehouse专属 (库存操作)
app.use('/api/v1/outbound', authenticateToken, requireRole('admin', 'warehouse_manager', 'technician', 'pathologist'), outboundRoutes)
app.use('/api/v1/stocktaking', authenticateToken, requireRole('admin', 'warehouse_manager'), stocktakingRoutes)
app.use('/api/v1/locations', authenticateToken, requireRole('admin', 'warehouse_manager'), locationRoutes)
app.use('/api/v1/returns', authenticateToken, requireRole('admin', 'warehouse_manager'), returnRoutes)
app.use('/api/v1/scraps', authenticateToken, requireRole('admin', 'warehouse_manager'), scrapRoutes)
app.use('/api/v1/transfers', authenticateToken, requireRole('admin', 'warehouse_manager'), transferRoutes)
app.use('/api/v1/supplier-returns', authenticateToken, requireRole('admin', 'warehouse_manager', 'procurement', 'finance'), supplierReturnRoutes)

// 路由注册 - technician/pathologist共享
app.use('/api/v1/projects', authenticateToken, requireRole('admin', 'technician', 'pathologist'), projectRoutes)
app.use('/api/v1/boms', authenticateToken, requireRole('admin', 'technician', 'pathologist'), bomRoutes)

// 路由注册 - 成本对账 (admin/finance/pathologist可访问)
app.use('/api/v1/reconciliation', authenticateToken, requireRole('admin', 'pathologist', 'finance'), reconciliationRoutes)

// 路由注册 - 通用主数据 (所有已认证角色可查看)
app.use('/api/v1/categories', authenticateToken, categoryRoutes)
app.use('/api/v1/materials', authenticateToken, requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement'), materialRoutes)

// 路由注册 - ABC 成本核算（纯增量）
// 设备/工时主数据维护
app.use('/api/v1/equipment', authenticateToken, requireRole('admin', 'finance'), equipmentRoutes)
app.use('/api/v1/equipment-types', authenticateToken, requireRole('admin', 'finance'), equipmentTypeRoutes)
app.use('/api/v1/labor-times', authenticateToken, requireRole('admin', 'finance'), laborTimeRoutes)
app.use('/api/v1/indirect-costs', authenticateToken, requireCostWorkbenchAccess, indirectCostRoutes)
// 成本工作台（核算/池/披露）
app.use('/api/v1/abc', authenticateToken, requireRole('admin', 'pathologist', 'finance'), abcRoutes)
app.use('/api/v1/cost-adjustments', authenticateToken, requireCostWorkbenchAccess, costAdjustmentRoutes)

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

// 测试环境下不自动启动服务器（测试用 supertest 的 request(app)，无需常驻端口）
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`COREONE Backend Server running on port ${PORT}`)
    console.log(`API Base URL: http://localhost:${PORT}/api/v1`)
  })
}

export default app
