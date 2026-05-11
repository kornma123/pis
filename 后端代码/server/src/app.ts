import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { initializeDatabase } from './database/DatabaseManager.js'
import { errorHandler } from './middleware/errorHandler.js'
import { authenticateToken, requireRole } from './middleware/auth.js'

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

dotenv.config()

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
app.use('/api/v1/logs', authenticateToken, requireRole('admin', 'finance'), logRoutes)
app.use('/api/v1/reports', authenticateToken, requireRole('admin', 'pathologist', 'finance'), reportRoutes)
app.use('/api/v1/depletion', authenticateToken, requireRole('admin', 'pathologist', 'finance'), depletionRoutes)

// 路由注册 - warehouse/technician/pathologist/procurement共享 (库存/预警)
app.use('/api/v1/inventory', authenticateToken, requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement'), inventoryRoutes)
app.use('/api/v1/alerts', authenticateToken, requireRole('admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement'), alertRoutes)

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

// 路由注册 - technician/pathologist共享
app.use('/api/v1/projects', authenticateToken, requireRole('admin', 'technician', 'pathologist'), projectRoutes)
app.use('/api/v1/boms', authenticateToken, requireRole('admin', 'technician', 'pathologist'), bomRoutes)

// 路由注册 - 通用主数据 (所有已认证角色可查看)
app.use('/api/v1/categories', authenticateToken, categoryRoutes)
app.use('/api/v1/materials', authenticateToken, materialRoutes)

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

app.listen(PORT, () => {
  console.log(`COREONE Backend Server running on port ${PORT}`)
  console.log(`API Base URL: http://localhost:${PORT}/api/v1`)
})
