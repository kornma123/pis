/**
 * Phase 0 逐抗体成本地基 —— TDD 红线（先写会失败的断言，守设计基线 §1.3）。
 *
 * 锁三条口径红线：
 *  1) 每片一抗成本 = 台账「每人份价（已换算）」直接取，**勿再除换算率**（曾除重致数字离谱的坑）。
 *  2) 「算全」= 一抗真价 + 二抗/显色 + 工时(G2) + 设备(G2)；完整度分档 精算↔粗估，缺价降级 + 行级标注。
 *  3) 特染 = 盒价 ÷ 标称次数（+可选实际得率 + 工时）。
 * 并锁真台账手核值（2SC ¥99.82、AFP ¥0.287）与 192 种目录完整性 + 建表/seed/CRUD。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'
import {
  perSlidePrimaryCost,
  computeFullSlideCost,
  fallbackAveragePrimary,
  specialStainPerTestCost,
  DEFAULT_IHC_COST_PARAMS,
  type AntibodyCostInput,
} from '../src/utils/antibody-cost.js'
import { ANTIBODY_LEDGER_SEED, DETECTION_LEDGER_SEED } from '../src/utils/antibody-catalog.js'

// —— 真台账手核锚（sheet「2025 (2)」，PII 安全）——
const AB_2SC = ANTIBODY_LEDGER_SEED.find((a) => a.name === '2SC')!
const AB_AFP = ANTIBODY_LEDGER_SEED.find((a) => a.name === 'AFP')!

describe('逐抗体成本 · 纯函数口径（antibody-cost.ts）', () => {
  it('每片一抗成本直接取台账每人份价——勿再除换算率（坑守卫）', () => {
    // 2SC：瓶价 1497.35 / 换算 15 = 99.823009（台账已换算列）；每片成本必须 = 99.82，不是再除一次 15
    expect(AB_2SC.perTestPrice).toBeCloseTo(99.823009, 5)
    expect(AB_2SC.convRate).toBe(15)
    const cost = perSlidePrimaryCost({ perTestPrice: AB_2SC.perTestPrice })
    expect(cost).toBeCloseTo(99.823009, 5)
    // 若误再除换算率 → 6.65，必须不等
    expect(cost).not.toBeCloseTo(99.823009 / 15, 3)
  })

  it('AFP（原液）每片一抗成本 = 0.286726', () => {
    expect(perSlidePrimaryCost({ perTestPrice: AB_AFP.perTestPrice })).toBeCloseTo(0.286726, 6)
  })

  it('缺价/零价 → null（触发粗估降级）', () => {
    expect(perSlidePrimaryCost({ perTestPrice: null })).toBeNull()
    expect(perSlidePrimaryCost({ perTestPrice: 0 })).toBeNull()
    expect(perSlidePrimaryCost({})).toBeNull()
  })

  it('「算全」= 一抗 + 二抗/显色 + 工时 + 设备，且完整度=精算', () => {
    const p = { secondaryPerSlide: 15, laborPerSlide: 8, equipmentPerSlide: 3 }
    const bd = computeFullSlideCost({ perTestPrice: AB_2SC.perTestPrice, category: '一抗' }, p)
    expect(bd.primary).toBeCloseTo(99.823009, 4)
    expect(bd.secondary).toBe(15)
    expect(bd.labor).toBe(8)
    expect(bd.equipment).toBe(3)
    expect(bd.total).toBeCloseTo(99.823009 + 15 + 8 + 3, 4)
    expect(bd.completeness).toBe('精算')
    // 工时/设备透明标注为 G2 估（弱锚·待校准 B4），不冒充精确
    expect(bd.laborEquipmentSource).toBe('G2估')
    expect(bd.note).toBeUndefined()
  })

  it('缺台账价 → 完整度=粗估、降级全院均价、行级标注「成本缺价·毛利待定」', () => {
    const bd = computeFullSlideCost({ perTestPrice: null, category: '一抗' }, DEFAULT_IHC_COST_PARAMS, { fallbackAvg: 8 })
    expect(bd.completeness).toBe('粗估')
    expect(bd.primary).toBe(8)
    expect(bd.note).toContain('缺价')
  })

  it('全院一抗降级均价在真台账区间内（¥0.29~99.82）', () => {
    const avg = fallbackAveragePrimary(ANTIBODY_LEDGER_SEED)
    expect(avg).toBeGreaterThan(0.29)
    expect(avg).toBeLessThan(99.83)
  })

  it('特染每次成本 = 盒价 ÷ 标称次数（+工时）', () => {
    expect(specialStainPerTestCost({ name: 'Masson', kitPrice: 318, nominalTests: 50 })).toBeCloseTo(6.36, 2)
    // 可选工时叠加
    expect(specialStainPerTestCost({ name: 'Masson', kitPrice: 318, nominalTests: 50, laborPerTest: 14 })).toBeCloseTo(20.36, 2)
    // 实际得率优先于标称次数
    expect(specialStainPerTestCost({ name: '网状', kitPrice: 549, nominalTests: 50, actualYield: 45 })).toBeCloseTo(549 / 45, 2)
  })
})

describe('抗体台账目录完整性（antibody-catalog.ts）', () => {
  it('192 种标记（191 一抗 + 1 EBER），一抗全部有每人份价', () => {
    expect(ANTIBODY_LEDGER_SEED.length).toBe(192)
    const primaries = ANTIBODY_LEDGER_SEED.filter((a) => a.category === '一抗')
    expect(primaries.length).toBe(191)
    expect(primaries.every((a) => typeof a.perTestPrice === 'number' && (a.perTestPrice as number) > 0)).toBe(true)
  })

  it('抗体真价跨度 ≈ 344 倍（证明必须逐抗体、不能均价）', () => {
    const prices = ANTIBODY_LEDGER_SEED.filter((a) => a.category === '一抗').map((a) => a.perTestPrice as number)
    const max = Math.max(...prices)
    const min = Math.min(...prices)
    expect(min).toBeCloseTo(0.286726, 5)
    expect(max).toBeCloseTo(99.823009, 5)
    expect(max / min).toBeGreaterThan(300)
  })

  it('二抗/辅料共享项存在（上机二抗测试条 ~¥15/片）', () => {
    expect(DETECTION_LEDGER_SEED.length).toBeGreaterThanOrEqual(3)
    const sec = DETECTION_LEDGER_SEED.filter((d) => d.type === 'secondary')
    expect(sec.length).toBeGreaterThanOrEqual(1)
    const onMachine = DETECTION_LEDGER_SEED.find((d) => d.name.includes('上机') && d.name.includes('二抗'))
    expect(onMachine).toBeTruthy()
    expect(onMachine!.perSlideCost as number).toBeGreaterThan(10)
    expect(onMachine!.perSlideCost as number).toBeLessThan(20)
  })
})

describe('抗体成本路由 + 建表 + seed（antibody-cost-v1.1.ts）', () => {
  let app: any
  let token = ''

  beforeAll(async () => {
    const db = await getDb()
    void db
    const antibodyRoutes = (await import('../src/routes/antibody-cost-v1.1.js')).default
    const { authenticateToken } = await import('../src/middleware/auth.js')
    const { requirePermission } = await import('../src/middleware/permissions.js')
    app = await buildTestApp([
      { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
      {
        path: '/api/v1/antibody-cost',
        router: antibodyRoutes,
        middleware: [authenticateToken, requirePermission('antibody_cost', 'R')],
      },
    ])
    token = await loginAdmin(app)
  })

  it('初始化后 antibodies 表已 seed 192 种', async () => {
    const db = await getDb()
    const row = db.prepare("SELECT COUNT(*) AS n FROM antibodies WHERE is_deleted = 0").get() as { n: number }
    expect(row.n).toBeGreaterThanOrEqual(192)
    const twosc = db.prepare("SELECT per_test_price FROM antibodies WHERE name = '2SC'").get() as { per_test_price: number }
    expect(twosc.per_test_price).toBeCloseTo(99.823009, 4)
  })

  it('GET /antibodies 返回抗体库列表', async () => {
    const res = await request(app).get('/api/v1/antibody-cost/antibodies?pageSize=500').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    const list = res.body.data.list as Array<{ name: string; perSlideCost: number }>
    const twosc = list.find((a) => a.name === '2SC')!
    expect(twosc.perSlideCost).toBeCloseTo(99.823009, 4)
  })

  it('GET /cost-preview 返回每片算全成本 + 完整度', async () => {
    const res = await request(app)
      .get('/api/v1/antibody-cost/cost-preview?name=2SC')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const bd = res.body.data
    expect(bd.primary).toBeCloseTo(99.823009, 4)
    expect(bd.completeness).toBe('精算')
    expect(bd.total).toBeGreaterThan(99.82)
  })

  it('POST /antibodies 新增抗体 → 落库 + 可算成本', async () => {
    const res = await request(app)
      .post('/api/v1/antibody-cost/antibodies')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'TEST-AB-9', form: '即用', perTestPrice: 12.5, category: '一抗', supplier: '测试' })
    expect(res.status).toBe(201)
    const db = await getDb()
    const row = db.prepare("SELECT per_test_price FROM antibodies WHERE name = 'TEST-AB-9'").get() as { per_test_price: number }
    expect(row.per_test_price).toBeCloseTo(12.5, 4)
  })
})
