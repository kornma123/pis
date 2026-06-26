/**
 * P0 审计修复测试公共脚手架
 *
 * 提供完全隔离的 in-memory 测试环境：
 * - 在动态 import 任何被测模块之前设置 DATABASE_PATH=':memory:' 与 JWT_SECRET
 * - 构建一个只挂载被测路由的 express app（镜像 app.ts 的中间件链），供 supertest 使用
 *
 * 不依赖 localhost:3001 的运行中后端，因此可独立通过。
 */

// 必须在任何被测模块（含 middleware/auth.ts 读取 JWT_SECRET）import 之前设置
process.env.DATABASE_PATH = ':memory:'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-p0'

import express, { type Router } from 'express'

export interface MountSpec {
  path: string // 如 '/api/v1/reconciliation'
  router: Router
  middleware?: express.RequestHandler[] // authenticateToken / requireRole(...)
}

/**
 * 构建一个仅挂载指定路由的 express app。
 * 复用真实的 express.json + errorHandler，保证行为与 app.ts 一致。
 */
export async function buildTestApp(mounts: MountSpec[]): Promise<express.Express> {
  const { errorHandler } = await import('../src/middleware/errorHandler.js')
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  for (const m of mounts) {
    app.use(m.path, ...(m.middleware || []), m.router)
  }
  app.use(errorHandler)
  app.use((_req, res) => {
    res.status(404).json({ success: false, error: { message: 'Not found', code: 'NOT_FOUND' } })
  })
  return app
}

/** 动态 import 已隔离 DB 的 DatabaseManager（在 env 设置之后） */
export async function getDb() {
  const mod = await import('../src/database/DatabaseManager.js')
  mod.initializeDatabase()
  return mod.getDatabase()
}

/** 用 admin/admin123 登录，返回 access token */
export async function loginAdmin(app: express.Express): Promise<string> {
  const request = (await import('supertest')).default
  const res = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123' })
  if (!res.body?.data?.token) {
    throw new Error('loginAdmin failed: ' + JSON.stringify(res.body))
  }
  return res.body.data.token
}
