/**
 * ABC 作业成本法集成测试
 * 测试作业中心、成本动因、成本池、BOM作业关联、成本计算等功能
 *
 * 数据库隔离：本文件用静态 `import app`，其 import 被 ESM 提升，无法像其它测试文件那样在
 * 文件首行设置 `process.env.DATABASE_PATH=':memory:'`（会晚于 import 求值而失效）。隔离由
 * vitest setupFiles（tests/db-isolation.setup.ts，在本文件 import 之前执行）统一强制 `:memory:`，
 * 故无需也不应在此再设。下方 L5-3 块的 beforeAll/afterAll 清理保持幂等即可（内存库下为空操作）。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import app from '../../src/app.js'
import { getDatabase } from '../../src/database/DatabaseManager.js'

// 辅助函数：从响应中提取列表数据
function getItems(res: any): any[] {
  const data = res.body?.data
  if (!data) return []
  if (Array.isArray(data)) return data
  if (data.list) return data.list
  if (data.items) return data.items
  return []
}

function latestOperationLog(db: any, operation: string, entityId: string) {
  return db.prepare(`
    SELECT *
    FROM operation_logs
    WHERE operation = ?
      AND (request_data LIKE ? OR response_data LIKE ?)
    ORDER BY rowid DESC
    LIMIT 1
  `).get(operation, `%${entityId}%`, `%${entityId}%`) as any
}

describe('ABC 作业成本法', () => {
  let token: string
  let db: any

  beforeAll(async () => {
    db = getDatabase()

    // 登录获取 token
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'admin123' })

    token = loginRes.body.data.token
  })

  afterAll(() => {
    // 清理
  })

  describe('作业中心管理', () => {
    let activityCenterId: string
    let activityCenterCode: string

    it('创建作业中心', async () => {
      activityCenterCode = `TEST_${Date.now()}`
      const res = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: activityCenterCode,
          name: '测试标本处理中心',
          description: '用于测试的标本处理中心',
          costDriverType: 'block_count',
          sortOrder: 1,
        })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
      expect(res.body.data.id).toBeDefined()
      activityCenterId = res.body.data.id
    })

    it('获取作业中心列表', async () => {
      const res = await request(app)
        .get('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const items = getItems(res)
      expect(items.length).toBeGreaterThan(0)
    })

    it('作业中心列表支持按审计回跳 ID 和业务编码精确承接', async () => {
      const byId = await request(app)
        .get('/api/v1/abc/activity-centers')
        .query({ keyword: activityCenterId })
        .set('Authorization', `Bearer ${token}`)

      expect(byId.status).toBe(200)
      expect(getItems(byId)).toHaveLength(1)
      expect(getItems(byId)[0]).toMatchObject({
        id: activityCenterId,
        code: activityCenterCode,
      })

      const byCode = await request(app)
        .get('/api/v1/abc/activity-centers')
        .query({ keyword: activityCenterCode })
        .set('Authorization', `Bearer ${token}`)

      expect(byCode.status).toBe(200)
      expect(getItems(byCode)).toHaveLength(1)
      expect(getItems(byCode)[0].id).toBe(activityCenterId)
    })

    it('获取作业中心详情', async () => {
      const res = await request(app)
        .get(`/api/v1/abc/activity-centers/${activityCenterId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      expect(res.body.data.code).toBe(activityCenterCode)
    })

    it('更新作业中心', async () => {
      const res = await request(app)
        .put(`/api/v1/abc/activity-centers/${activityCenterId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: '更新后的标本处理中心',
          description: '更新后的描述',
        })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('删除作业中心', async () => {
      // 先创建一个新的用于删除
      const uniqueCode = `DELETE_${Date.now()}`
      const createRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: uniqueCode,
          name: '待删除的作业中心',
          costDriverType: 'slide_count',
        })

      const deleteId = createRes.body.data.id

      const res = await request(app)
        .delete(`/api/v1/abc/activity-centers/${deleteId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('作业中心必须引用启用成本动因，且已有成本池引用时不能删除', async () => {
      const suffix = Date.now()
      const invalidDriver = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `BAD_DRIVER_${suffix}`,
          name: '非法动因作业中心',
          costDriverType: `unknown_driver_${suffix}`,
        })

      expect(invalidDriver.status).toBe(400)
      expect(invalidDriver.body.error.message).toBe('成本动因类型不存在或已停用')

      const createRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `POOL_GUARD_${suffix}`,
          name: '成本池引用保护作业中心',
          costDriverType: 'slide_count',
        })
      expect(createRes.status).toBe(201)
      const guardedId = createRes.body.data.id
      db.prepare(`
        INSERT INTO abc_cost_pools (id, activity_center_id, year_month, direct_cost, total_cost, driver_quantity, driver_rate)
        VALUES (?, ?, '2099-01', 100, 100, 10, 10)
      `).run(`pool-${suffix}`, guardedId)

      const deleteGuarded = await request(app)
        .delete(`/api/v1/abc/activity-centers/${guardedId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(deleteGuarded.status).toBe(409)
      expect(deleteGuarded.body.error.message).toBe('作业中心已有成本池记录，不能删除')
    })

    it('作业中心父级和状态必须可治理且拒绝无效层级', async () => {
      const suffix = Date.now()
      const parentRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `PARENT_${suffix}`,
          name: '父级作业中心',
          costDriverType: 'slide_count',
        })
      expect(parentRes.status).toBe(201)
      const parentId = parentRes.body.data.id

      const childRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `CHILD_${suffix}`,
          name: '子级作业中心',
          costDriverType: 'slide_count',
          parentId,
          status: 'inactive',
        })
      expect(childRes.status).toBe(201)
      const childId = childRes.body.data.id

      const childDetail = await request(app)
        .get(`/api/v1/abc/activity-centers/${childId}`)
        .set('Authorization', `Bearer ${token}`)
      expect(childDetail.status).toBe(200)
      expect(childDetail.body.data).toMatchObject({
        parentId,
        status: 'inactive',
      })

      const selfParent = await request(app)
        .put(`/api/v1/abc/activity-centers/${childId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: childId })
      expect(selfParent.status).toBe(400)
      expect(selfParent.body.error.message).toBe('作业中心不能选择自己或下级作为上级')

      const missingParent = await request(app)
        .put(`/api/v1/abc/activity-centers/${childId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ parentId: `missing-parent-${suffix}` })
      expect(missingParent.status).toBe(400)
      expect(missingParent.body.error.message).toBe('上级作业中心不存在')

      const reactivate = await request(app)
        .put(`/api/v1/abc/activity-centers/${childId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'active', parentId: '' })
      expect(reactivate.status).toBe(200)

      const updated = await request(app)
        .get(`/api/v1/abc/activity-centers/${childId}`)
        .set('Authorization', `Bearer ${token}`)
      expect(updated.body.data).toMatchObject({
        parentId: null,
        status: 'active',
      })
    })
  })

  describe('成本动因管理', () => {
    it('创建成本动因', async () => {
      const uniqueCode = `test_slide_${Date.now()}`
      const res = await request(app)
        .post('/api/v1/abc/cost-drivers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: uniqueCode,
          name: '测试切片数',
          unit: '张',
          calculationMethod: 'linear',
          description: '用于测试的成本动因',
        })

      expect(res.status).toBe(201)
      expect(res.body.success).toBe(true)
    })

    it('获取成本动因列表', async () => {
      const res = await request(app)
        .get('/api/v1/abc/cost-drivers')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      const items = getItems(res)
      expect(items.length).toBeGreaterThan(0)
    })

    it('阶梯成本动因必须配置可解释的区间费率并可回看', async () => {
      const suffix = Date.now()
      const invalidRes = await request(app)
        .post('/api/v1/abc/cost-drivers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `tier_invalid_${suffix}`,
          name: '非法阶梯动因',
          unit: '张',
          calculationMethod: 'tiered',
          tierRules: [
            { from: 0, to: 100, rate: 2 },
            { from: 90, to: 200, rate: 1.5 },
          ],
        })

      expect(invalidRes.status).toBe(400)
      expect(invalidRes.body.error.code).toBe('INVALID_TIER_RULES')

      const createRes = await request(app)
        .post('/api/v1/abc/cost-drivers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `tier_driver_${suffix}`,
          name: '阶梯切片动因',
          unit: '张',
          calculationMethod: 'tiered',
          tierRules: [
            { from: 0, to: 100, rate: 2, label: '0-100张' },
            { from: 100, to: null, rate: 1.5, label: '100张以上' },
          ],
          description: '阶梯费率回归',
        })

      expect(createRes.status).toBe(201)
      const driverId = createRes.body.data.id
      const row = db.prepare('SELECT calculation_method, tier_rules FROM abc_cost_drivers WHERE id = ?').get(driverId) as any
      expect(row.calculation_method).toBe('tiered')
      expect(JSON.parse(row.tier_rules)).toEqual([
        { from: 0, to: 100, rate: 2, label: '0-100张' },
        { from: 100, to: null, rate: 1.5, label: '100张以上' },
      ])

      const listRes = await request(app)
        .get('/api/v1/abc/cost-drivers')
        .set('Authorization', `Bearer ${token}`)
      const listed = getItems(listRes).find((item: any) => item.id === driverId)
      expect(listed.tierRules).toEqual([
        { from: 0, to: 100, rate: 2, label: '0-100张' },
        { from: 100, to: null, rate: 1.5, label: '100张以上' },
      ])

      const byId = await request(app)
        .get('/api/v1/abc/cost-drivers')
        .query({ keyword: driverId })
        .set('Authorization', `Bearer ${token}`)
      expect(byId.status).toBe(200)
      expect(getItems(byId)).toHaveLength(1)
      expect(getItems(byId)[0]).toMatchObject({
        id: driverId,
        code: `tier_driver_${suffix}`,
        status: 'active',
      })

      const byTierLabel = await request(app)
        .get('/api/v1/abc/cost-drivers')
        .query({ keyword: '100张以上' })
        .set('Authorization', `Bearer ${token}`)
      expect(byTierLabel.status).toBe(200)
      expect(getItems(byTierLabel).some((item: any) => item.id === driverId)).toBe(true)
    })

    it('成本动因被作业中心引用时不能删除', async () => {
      const suffix = Date.now()
      const driverCode = `guard_driver_${suffix}`
      const driverRes = await request(app)
        .post('/api/v1/abc/cost-drivers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: driverCode,
          name: '引用保护动因',
          unit: '次',
          calculationMethod: 'linear',
        })

      expect(driverRes.status).toBe(201)
      const driverId = driverRes.body.data.id

      const centerRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `DRIVER_GUARD_${suffix}`,
          name: '引用动因作业中心',
          costDriverType: driverCode,
        })
      expect(centerRes.status).toBe(201)

      const deleteDriver = await request(app)
        .delete(`/api/v1/abc/cost-drivers/${driverId}`)
        .set('Authorization', `Bearer ${token}`)

      expect(deleteDriver.status).toBe(409)
      expect(deleteDriver.body.error.message).toBe('成本动因已被作业中心引用，不能删除')
    })
  })

  describe('成本池管理', () => {
    it('创建成本池', async () => {
      // 先获取一个作业中心
      const centersRes = await request(app)
        .get('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)

      const centers = getItems(centersRes)
      if (centers.length === 0) {
        return // 跳过测试
      }

      const centerId = centers[0].id

      const res = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth: '2026-06',
          directCost: 10000,
          indirectCost: 5000,
          driverQuantity: 100,
          adjustmentReason: '集成测试手工录入成本池',
        })

      // 接受 200（更新）或 201（创建）
      expect([200, 201]).toContain(res.status)
      expect(res.body.success).toBe(true)
    })

    it('获取成本池列表', async () => {
      const res = await request(app)
        .get('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
    })

    it('拒绝会污染期间费率的成本池输入', async () => {
      const suffix = Date.now()
      const centerRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `POOL_INPUT_${suffix}`,
          name: '成本池输入校验作业中心',
          costDriverType: 'slide_count',
        })
      expect(centerRes.status).toBe(201)
      const centerId = centerRes.body.data.id

      const negativeCost = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth: '2099-02',
          directCost: -1,
          indirectCost: 0,
          driverQuantity: 10,
          adjustmentReason: '负数校验',
        })
      expect(negativeCost.status).toBe(400)
      expect(negativeCost.body.error.message).toBe('直接成本不能为负数')

      const zeroDriver = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth: '2099-02',
          directCost: 100,
          indirectCost: 0,
          driverQuantity: 0,
          adjustmentReason: '动因校验',
        })
      expect(zeroDriver.status).toBe(400)
      expect(zeroDriver.body.error.message).toBe('动因数量必须大于0')

      await request(app)
        .put(`/api/v1/abc/activity-centers/${centerId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ status: 'inactive' })

      const inactiveCenter = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth: '2099-02',
          directCost: 100,
          indirectCost: 0,
          driverQuantity: 10,
          adjustmentReason: '停用中心校验',
        })
      expect(inactiveCenter.status).toBe(400)
      expect(inactiveCenter.body.error.message).toBe('作业中心不存在或已停用')
    })

    it('已关账期间不能新增或更新成本池', async () => {
      const suffix = Date.now()
      const yearMonth = '2099-03'
      const centerRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `POOL_CLOSED_${suffix}`,
          name: '成本池关账保护作业中心',
          costDriverType: 'slide_count',
        })
      expect(centerRes.status).toBe(201)
      const centerId = centerRes.body.data.id
      db.prepare(`
        INSERT OR REPLACE INTO abc_periods (id, year_month, status, closed_at, closed_by)
        VALUES (?, ?, 'closed', CURRENT_TIMESTAMP, 'test')
      `).run(`period-pool-closed-${suffix}`, yearMonth)

      const res = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth,
          directCost: 100,
          indirectCost: 50,
          driverQuantity: 10,
          adjustmentReason: '关账保护校验',
        })

      expect(res.status).toBe(422)
      expect(res.body.error.code).toBe('PERIOD_CLOSED')
    })

    it('手工成本池录入必须沉淀调整原因和更新前后值', async () => {
      const suffix = Date.now()
      const yearMonth = '2099-04'
      const centerRes = await request(app)
        .post('/api/v1/abc/activity-centers')
        .set('Authorization', `Bearer ${token}`)
        .send({
          code: `POOL_MANUAL_${suffix}`,
          name: '成本池手工调整作业中心',
          costDriverType: 'slide_count',
        })
      expect(centerRes.status).toBe(201)
      const centerId = centerRes.body.data.id

      const missingReason = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth,
          directCost: 100,
          indirectCost: 20,
          driverQuantity: 10,
        })

      expect(missingReason.status).toBe(400)
      expect(missingReason.body.error.code).toBe('COST_POOL_ADJUSTMENT_REASON_REQUIRED')

      const createRes = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth,
          directCost: 100,
          indirectCost: 20,
          driverQuantity: 10,
          adjustmentReason: '月末人工成本补录',
          sourceDocumentNo: 'MANUAL-POOL-001',
          attachmentUrl: 'https://example.test/manual-pool-001.pdf',
        })

      expect(createRes.status).toBe(201)
      const poolId = createRes.body.data.id
      let row = db.prepare(`
        SELECT adjustment_reason, source_document_no, attachment_url, total_cost, driver_rate
        FROM abc_cost_pools
        WHERE id = ?
      `).get(poolId) as any
      expect(row).toMatchObject({
        adjustment_reason: '月末人工成本补录',
        source_document_no: 'MANUAL-POOL-001',
        attachment_url: 'https://example.test/manual-pool-001.pdf',
        total_cost: 120,
        driver_rate: 12,
      })

      const createLog = latestOperationLog(db, 'POST /abc/cost-pools', poolId)
      expect(createLog).toBeTruthy()
      expect(JSON.parse(createLog.request_data)).toMatchObject({
        module: 'abc_cost_pools',
        id: poolId,
        action: 'create',
        before: null,
        after: {
          totalCost: 120,
          driverRate: 12,
          adjustmentReason: '月末人工成本补录',
          sourceDocumentNo: 'MANUAL-POOL-001',
        },
      })

      const listByPoolId = await request(app)
        .get('/api/v1/abc/cost-pools')
        .query({ keyword: poolId })
        .set('Authorization', `Bearer ${token}`)
      expect(listByPoolId.status).toBe(200)
      expect(getItems(listByPoolId)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: poolId }),
      ]))

      const listBySourceDocument = await request(app)
        .get('/api/v1/abc/cost-pools')
        .query({ keyword: 'MANUAL-POOL-001' })
        .set('Authorization', `Bearer ${token}`)
      expect(listBySourceDocument.status).toBe(200)
      expect(getItems(listBySourceDocument)).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: poolId, sourceDocumentNo: 'MANUAL-POOL-001' }),
      ]))

      const updateRes = await request(app)
        .post('/api/v1/abc/cost-pools')
        .set('Authorization', `Bearer ${token}`)
        .send({
          activityCenterId: centerId,
          yearMonth,
          directCost: 150,
          indirectCost: 30,
          driverQuantity: 12,
          adjustmentReason: '复核后补录设备共用分摊',
          sourceDocumentNo: 'MANUAL-POOL-002',
        })

      expect(updateRes.status).toBe(200)
      row = db.prepare(`
        SELECT adjustment_reason, source_document_no, total_cost, driver_rate
        FROM abc_cost_pools
        WHERE id = ?
      `).get(poolId) as any
      expect(row).toMatchObject({
        adjustment_reason: '复核后补录设备共用分摊',
        source_document_no: 'MANUAL-POOL-002',
        total_cost: 180,
        driver_rate: 15,
      })

      const updateLog = latestOperationLog(db, 'POST /abc/cost-pools', poolId)
      expect(JSON.parse(updateLog.request_data)).toMatchObject({
        module: 'abc_cost_pools',
        id: poolId,
        action: 'update',
        before: {
          totalCost: 120,
          adjustmentReason: '月末人工成本补录',
        },
        after: {
          totalCost: 180,
          adjustmentReason: '复核后补录设备共用分摊',
        },
      })
    })
  })

  describe('BOM作业关联', () => {
    it('获取BOM的作业关联', async () => {
      // 先获取一个BOM
      const bomsRes = await request(app)
        .get('/api/v1/boms')
        .set('Authorization', `Bearer ${token}`)

      const items = getItems(bomsRes)
      if (items.length > 0) {
        const bomId = items[0].id

        const res = await request(app)
          .get(`/api/v1/abc/bom-links/${bomId}`)
          .set('Authorization', `Bearer ${token}`)

        expect(res.status).toBe(200)
        expect(res.body.success).toBe(true)
      }
    })
  })

  describe('收费标准', () => {
    it('收费标准数据已导入', async () => {
      // 直接查询数据库验证
      const count = db.prepare('SELECT COUNT(*) as count FROM fee_standards').get()
      expect(count.count).toBeGreaterThan(0)
    })

    it('收费标准包含完整编码', async () => {
      // 验证关键编码存在
      const codes = [
        '012100000010000', // 病理诊断费
        '012100000030000', // 标本处理费（常规）
        '012100000120000', // IHC染色检查费
        '012100000150000', // FISH检测费
        '012100000170000', // 实时荧光PCR
        '012100000200000', // NGS
      ]

      for (const code of codes) {
        const row = db.prepare('SELECT * FROM fee_standards WHERE code = ?').get(code)
        expect(row).toBeDefined()
        expect(row.name).toBeDefined()
        expect(row.base_price).toBeGreaterThan(0)
      }
    })
  })

  describe('ABC种子数据', () => {
    it('作业中心数据已导入', async () => {
      const count = db.prepare('SELECT COUNT(*) as count FROM abc_activity_centers').get()
      expect(count.count).toBeGreaterThanOrEqual(8) // 至少8个作业中心
    })

    it('成本动因数据已导入', async () => {
      const count = db.prepare('SELECT COUNT(*) as count FROM abc_cost_drivers').get()
      expect(count.count).toBeGreaterThanOrEqual(7) // 至少7种成本动因
    })

    it('作业中心包含正确类型', async () => {
      const centers = db.prepare('SELECT * FROM abc_activity_centers ORDER BY sort_order').all()
      const codes = centers.map((c: any) => c.code)
      expect(codes).toContain('SPECIMEN')
      expect(codes).toContain('SECTION')
      expect(codes).toContain('HE_STAIN')
      expect(codes).toContain('IHC')
      expect(codes).toContain('SS')
      expect(codes).toContain('MP')
      expect(codes).toContain('DIAGNOSIS')
      expect(codes).toContain('CYTOLOGY')
    })
  })

  describe('L5-3 切片成本下钻：逐中心作业动因分解', () => {
    const MONTH = '2095-07'
    const cleanup = () => {
      db.prepare(`DELETE FROM outbound_abc_details WHERE bom_id IN ('bom-brk','bom-brk-legacy')`).run()
      db.prepare(`DELETE FROM outbound_records WHERE id LIKE 'oad-brk-%'`).run()
    }
    afterAll(cleanup) // 持久库：清理本块种子，避免污染盈利/对账等聚合测试
    beforeAll(() => {
      cleanup() // 幂等：清掉上次残留再种
      db.prepare(`INSERT OR IGNORE INTO boms (id, code, name, version, type, status) VALUES ('bom-brk','BOM-BRK','下钻用例','v1.0','ihc',1)`).run()
      const mk = (id: string, details: any[]) => {
        db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, total_cost, sample_count, operator, status, created_at)
                    VALUES (?, ?, 'bom', 0, 1, 'admin', 'completed', ?)`).run(id, `OB-${id}`, `${MONTH}-15 10:00:00`)
        db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, bom_id, sample_count, cost_month, cost_status, activity_details)
                    VALUES (?, ?, 'bom-brk', 1, ?, 'costed', ?)`).run(id, id, MONTH, JSON.stringify(details))
      }
      mk('oad-brk-1', [
        { activityCenterId: 'ac-s', activityCenterName: '切片', activityCenterCode: 'SEC', driverType: 'block_count', quantity: 3, driverRate: 10, rateSource: 'period', poolCost: 100, allocatedCost: 30, totalCost: 30 },
        { activityCenterId: 'ac-i', activityCenterName: '免疫组化', activityCenterCode: 'IHC', driverType: 'slide_count', quantity: 6, driverRate: 4, rateSource: 'period', poolCost: 90, allocatedCost: 24, totalCost: 24 },
      ])
      mk('oad-brk-2', [
        { activityCenterId: 'ac-s', activityCenterName: '切片', activityCenterCode: 'SEC', driverType: 'block_count', quantity: 2, driverRate: 10, rateSource: 'period', poolCost: 100, allocatedCost: 20, totalCost: 20 },
        { activityCenterId: 'ac-i', activityCenterName: '免疫组化', activityCenterCode: 'IHC', driverType: 'slide_count', quantity: 4, driverRate: 4, rateSource: 'period', poolCost: 90, allocatedCost: 16, totalCost: 16 },
      ])
      // 旧格式快照：activity_details 为 {中心标识: 分摊额} 对象（历史数据，无逐动因明细）。
      db.prepare(`INSERT OR IGNORE INTO boms (id, code, name, version, type, status) VALUES ('bom-brk-legacy','BOM-BRK-L','旧格式下钻','v1.0','ihc',1)`).run()
      db.prepare(`INSERT INTO outbound_records (id, outbound_no, type, total_cost, sample_count, operator, status, created_at) VALUES ('oad-brk-legacy','OB-LEG','bom',0,1,'admin','completed','${MONTH}-15 10:00:00')`).run()
      db.prepare(`INSERT INTO outbound_abc_details (id, outbound_id, bom_id, sample_count, cost_month, cost_status, activity_details) VALUES ('oad-brk-legacy','oad-brk-legacy','bom-brk-legacy',1,?, 'costed', ?)`)
        .run(MONTH, JSON.stringify({ specimen: 26.38, section: 35.57, diagnosis: 54.23 }))
    })

    it('按 BOM 聚合逐中心：分摊额/动因量求和，费率为期间代表值', async () => {
      const res = await request(app)
        .get('/api/v1/abc/profitability/activity-breakdown')
        .query({ bomId: 'bom-brk', startDate: MONTH, endDate: MONTH })
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      const d = res.body.data
      expect(d.snapshotCount).toBe(2)
      expect(d.totalActivityCost).toBe(90) // (30+20)+(30+20)
      const sec = d.breakdown.find((c: any) => c.activityCenterId === 'ac-s')
      const ihc = d.breakdown.find((c: any) => c.activityCenterId === 'ac-i')
      expect(sec).toMatchObject({ driverType: 'block_count', driverQuantity: 5, driverRate: 10, allocatedCost: 50 })
      expect(ihc).toMatchObject({ driverType: 'slide_count', driverQuantity: 10, driverRate: 4, allocatedCost: 40 })
      // 排序：分摊额降序
      expect(d.breakdown[0].activityCenterId).toBe('ac-s')
    })

    it('旧格式快照（对象 {中心: 分摊额}）也能还原逐中心分摊额（legacy=true，不误显空）', async () => {
      const res = await request(app)
        .get('/api/v1/abc/profitability/activity-breakdown')
        .query({ bomId: 'bom-brk-legacy', startDate: MONTH, endDate: MONTH })
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(200)
      const d = res.body.data
      expect(d.legacy).toBe(true)
      expect(d.breakdown.length).toBe(3)
      expect(d.totalActivityCost).toBe(116.18) // 26.38+35.57+54.23
      // 旧格式行：有分摊额、rateSource=legacy、无费率/动因量
      const top = d.breakdown[0]
      expect(top.allocatedCost).toBe(54.23) // diagnosis 最大，降序在首
      expect(top.rateSource).toBe('legacy')
      expect(top.driverRate).toBe(0)
    })

    it('缺 bomId 返回 400', async () => {
      const res = await request(app)
        .get('/api/v1/abc/profitability/activity-breakdown')
        .set('Authorization', `Bearer ${token}`)
      expect(res.status).toBe(400)
    })
  })
})
