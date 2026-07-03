/**
 * 线 F —— 逐抗体成本弱锚校准（B4）+ 承重墙口径敏感性区间（B3）· TDD 红线。
 *
 * 设计基线 §1.2/§1.3 + 未决 B3/B4。本套锁三件事，全部围绕「诚实、不冒充精确」：
 *  B4-①诚实透出：工时/设备是 G2 估弱锚，`laborEquipmentSource` 随参数元数据派生
 *      'G2估' | '部分校准' | '已校准'——缺省仍 'G2估'（不冒充精确），校准后如实翻牌。
 *  B4-②校准写回输入路径：喂真实（月人力/月折旧/月房租/月产片量）→ 摊算每片工时/设备 →
 *      写回参数并把 source/confidence 翻成「已校准」，abc_audit_logs 落 before/after 留痕。
 *  B3 承重墙敏感性：把国标 36/105 套溢价单价 = 政策分摊、非真实制片价值证明；
 *      提供只读敏感性 band（诊断锚 105 → 本地协商值 ±30% 区间），默认锚锁死 = 收入侧 SPLIT_DIAG_FEE 防漂移。
 *
 * 真值（康湾真实工资/折旧/房租、本地协商诊断值）待 PM 补——本套只锁机制与口径，不锁具体金额。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'
import {
  computeFullSlideCost,
  deriveCalibrationState,
  isParamCalibrated,
  deriveLaborEquipmentPerSlide,
  manufactureShare,
  manufactureShareBand,
  DIAGNOSIS_ANCHOR_DEFAULT,
  DEFAULT_IHC_COST_PARAMS,
  type IhcCostParams,
} from '../src/utils/antibody-cost.js'
import { SPLIT_DIAG_FEE } from '../src/utils/statement-revenue.js'

// 收入侧 round2 的忠实复刻（用于 drift-guard 手核）
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

describe('B4-① 诚实透出：工时/设备 G2 估弱锚状态派生', () => {
  it('deriveCalibrationState：两半都未校准=G2估、其一=部分校准、都校准=已校准', () => {
    expect(deriveCalibrationState(false, false)).toBe('G2估')
    expect(deriveCalibrationState(true, false)).toBe('部分校准')
    expect(deriveCalibrationState(false, true)).toBe('部分校准')
    expect(deriveCalibrationState(true, true)).toBe('已校准')
  })

  it('isParamCalibrated：G2估/粗估/缺省 → 未校准；实测校准/台账真价 → 已校准', () => {
    expect(isParamCalibrated(undefined)).toBe(false)
    expect(isParamCalibrated({})).toBe(false)
    expect(isParamCalibrated({ source: 'G2估', confidence: '粗估' })).toBe(false)
    expect(isParamCalibrated({ source: '康湾实测校准', confidence: '已校准' })).toBe(true)
    expect(isParamCalibrated({ source: '台账', confidence: '台账真价' })).toBe(true)
  })

  it('computeFullSlideCost 缺元数据 → laborEquipmentSource 仍为 G2估（向后兼容·不冒充精确）', () => {
    const p: IhcCostParams = { secondaryPerSlide: 15, laborPerSlide: 8, equipmentPerSlide: 3 }
    const bd = computeFullSlideCost({ perTestPrice: 99.823009, category: '一抗' }, p)
    expect(bd.laborEquipmentSource).toBe('G2估')
    // 数值不受透出影响
    expect(bd.total).toBeCloseTo(99.823009 + 15 + 8 + 3, 4)
  })

  it('computeFullSlideCost 两半均已校准 → 已校准；仅一半 → 部分校准（数值不变）', () => {
    const both: IhcCostParams = { secondaryPerSlide: 15, laborPerSlide: 20, equipmentPerSlide: 4, laborCalibrated: true, equipmentCalibrated: true }
    const bdBoth = computeFullSlideCost({ perTestPrice: 10, category: '一抗' }, both)
    expect(bdBoth.laborEquipmentSource).toBe('已校准')
    expect(bdBoth.total).toBeCloseTo(10 + 15 + 20 + 4, 4)

    const partial: IhcCostParams = { ...both, equipmentCalibrated: false }
    expect(computeFullSlideCost({ perTestPrice: 10 }, partial).laborEquipmentSource).toBe('部分校准')
  })
})

describe('B4-② 校准摊算派生（deriveLaborEquipmentPerSlide）', () => {
  it('无房租：每片工时/设备 = 月成本 ÷ 月产片量', () => {
    const r = deriveLaborEquipmentPerSlide({
      monthlyTechnicianCost: 40000,
      monthlyEquipmentDepreciation: 6000,
      monthlySlideVolume: 2000,
    })
    expect(r.laborPerSlide).toBeCloseTo(20, 4) // 40000/2000
    expect(r.equipmentPerSlide).toBeCloseTo(3, 4) // 6000/2000
    expect(r.inputs.monthlySlideVolume).toBe(2000)
    expect(typeof r.method).toBe('string')
  })

  it('含房租：按 facilityToLaborRatio 摊入工时/设备（默认 0.5）', () => {
    const r = deriveLaborEquipmentPerSlide({
      monthlyTechnicianCost: 40000,
      monthlyEquipmentDepreciation: 6000,
      monthlyFacilityCost: 4000,
      monthlySlideVolume: 2000,
    })
    // 房租 4000 半半分：工时+2000、设备+2000
    expect(r.laborPerSlide).toBeCloseTo((40000 + 2000) / 2000, 4) // 21
    expect(r.equipmentPerSlide).toBeCloseTo((6000 + 2000) / 2000, 4) // 4
  })

  it('月产片量 <1（含 0/负/分数）→ 抛错（分母守卫 + 挡离谱摊算）', () => {
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: 1, monthlyEquipmentDepreciation: 1, monthlySlideVolume: 0 })).toThrow()
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: 1, monthlyEquipmentDepreciation: 1, monthlySlideVolume: -5 })).toThrow()
    // 分数片量 0.0001 若放行会摊出 4 亿/片——须挡
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: 40000, monthlyEquipmentDepreciation: 6000, monthlySlideVolume: 0.0001 })).toThrow()
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: 40000, monthlyEquipmentDepreciation: 6000, monthlySlideVolume: 0.5 })).toThrow()
  })

  it('Infinity/NaN/负值成本输入 → 抛错（防伪校准：node:sqlite 会接受 Infinity 写库）', () => {
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: Infinity, monthlyEquipmentDepreciation: 1, monthlySlideVolume: 100 })).toThrow()
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: 1, monthlyEquipmentDepreciation: Infinity, monthlySlideVolume: 100 })).toThrow()
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: NaN, monthlyEquipmentDepreciation: 1, monthlySlideVolume: 100 })).toThrow()
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: -1, monthlyEquipmentDepreciation: 1, monthlySlideVolume: 100 })).toThrow()
    expect(() => deriveLaborEquipmentPerSlide({ monthlyTechnicianCost: 1, monthlyEquipmentDepreciation: 1, monthlyFacilityCost: Infinity, monthlySlideVolume: 100 })).toThrow()
  })
})

describe('B3 承重墙敏感性 band（manufactureShare / manufactureShareBand）', () => {
  it('默认诊断锚 = 收入侧 SPLIT_DIAG_FEE（drift-guard：改了活公式这里必红）', () => {
    expect(DIAGNOSIS_ANCHOR_DEFAULT).toBe(SPLIT_DIAG_FEE)
    expect(DIAGNOSIS_ANCHOR_DEFAULT).toBe(105)
  })

  it('manufactureShare 忠实复刻活公式 f = (rate×workload)/(rate×workload+锚)', () => {
    // rate=36, workload=5 → 180/(180+105)=0.6315789…
    expect(manufactureShare(36, 5, 105)).toBeCloseTo(180 / 285, 10)
    // rate×workload=0 → f=0（活公式 denom>0?.:0 守卫）
    expect(manufactureShare(0, 5, 105)).toBe(0)
    expect(manufactureShare(36, 0, 105)).toBe(0)
  })

  it('band 基锚 inShare 与活公式手核逐分一致（round2 忠实复刻）', () => {
    const settle = 1234.56, rate = 36, workload = 5
    const liveInShare = round2(settle * ((rate * workload) / (rate * workload + SPLIT_DIAG_FEE)))
    const band = manufactureShareBand({ rate, workload, settle })
    expect(band.base.anchor).toBe(105)
    expect(band.base.labShare).toBe(liveInShare)
  })

  it('±30% 默认区间：锚越低制片份额越高（单调）；spread>0', () => {
    const band = manufactureShareBand({ rate: 36, workload: 5 })
    expect(band.low.anchor).toBeCloseTo(73.5, 4) // 105×0.7
    expect(band.high.anchor).toBeCloseTo(136.5, 4) // 105×1.3
    // 锚小→份额大：low.share > base.share > high.share
    expect(band.low.share).toBeGreaterThan(band.base.share)
    expect(band.base.share).toBeGreaterThan(band.high.share)
    expect(band.spreadPct).toBeGreaterThan(0)
    // 口径基调：政策分摊、非价值证明
    expect(band.note).toMatch(/政策分摊|非.*证明|占位/)
  })

  it('band 可配：显式 anchorLow/High 覆盖默认 ±30%', () => {
    const band = manufactureShareBand({ rate: 36, workload: 5, anchorLow: 90, anchorHigh: 200 })
    expect(band.low.anchor).toBe(90)
    expect(band.high.anchor).toBe(200)
  })

  it('band 健壮：非有限 bandPct/anchorBase 回退默认，绝不透出 NaN/Infinity', () => {
    const b1 = manufactureShareBand({ rate: 36, workload: 5, bandPct: NaN })
    expect(Number.isFinite(b1.low.anchor)).toBe(true)
    expect(b1.low.anchor).toBeCloseTo(73.5, 4) // 回退 ±30%
    const b2 = manufactureShareBand({ rate: 36, workload: 5, anchorBase: Infinity })
    expect(b2.base.anchor).toBe(105) // 回退默认锚
    expect([b2.low.anchor, b2.high.anchor, b2.base.share, b2.spreadPct].every(Number.isFinite)).toBe(true)
  })
})

describe('B4 路由：诚实透出 + 校准写回 + 留痕（antibody-cost-v1.1.ts）', () => {
  let app: any
  let token = ''

  beforeAll(async () => {
    await getDb()
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

  it('seed 初态诚实：GET /cost-preview → laborEquipmentSource=G2估、透出待校准备注', async () => {
    const res = await request(app).get('/api/v1/antibody-cost/cost-preview?name=2SC').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.laborEquipmentSource).toBe('G2估')
    // 透出每参数元数据（source/confidence/remark），供前端如实标注
    const meta = res.body.data.meta
    expect(meta).toBeTruthy()
    expect(JSON.stringify(meta)).toMatch(/待校准|G2/)
  })

  it('PUT /cost-params/:key 持久化 confidence + remark（回归：此前被丢弃）', async () => {
    const res = await request(app)
      .put('/api/v1/antibody-cost/cost-params/labor_per_slide')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 9, source: '手工调整', confidence: '粗估', remark: '手工微调占位' })
    expect(res.status).toBe(200)
    const db = await getDb()
    const row = db.prepare("SELECT value, source, confidence, remark FROM ihc_cost_params WHERE param_key='labor_per_slide'").get() as any
    expect(Number(row.value)).toBe(9)
    expect(row.confidence).toBe('粗估')
    expect(row.remark).toBe('手工微调占位')
  })

  it('诚实不变式：手工 PUT confidence=已校准 → 400（校准态只能经 calibrate 写回）', async () => {
    const res = await request(app)
      .put('/api/v1/antibody-cost/cost-params/labor_per_slide')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 5, source: '手工', confidence: '已校准' })
    expect(res.status).toBe(400)
    // 被拒 → 不改状态：cost-preview 仍不是「已校准」
    const preview = await request(app).get('/api/v1/antibody-cost/cost-preview?name=2SC').set('Authorization', `Bearer ${token}`)
    expect(preview.body.data.laborEquipmentSource).not.toBe('已校准')
  })

  it('诚实不变式：手工 PUT 伪造 source=康湾实测校准 → 400（不得走后门冒充校准来源）', async () => {
    const res = await request(app)
      .put('/api/v1/antibody-cost/cost-params/equipment_per_slide')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 5, source: '康湾实测校准' })
    expect(res.status).toBe(400)
  })

  it('POST /cost-params/calibrate：喂真实数据 → 写回 labor/equipment + 翻牌已校准 + abc_audit_logs 留痕', async () => {
    const db = await getDb()
    const before = db.prepare("SELECT COUNT(*) AS n FROM abc_audit_logs WHERE module='antibody_cost' AND action='calibrate'").get() as { n: number }

    const res = await request(app)
      .post('/api/v1/antibody-cost/cost-params/calibrate')
      .set('Authorization', `Bearer ${token}`)
      .send({ monthlyTechnicianCost: 40000, monthlyEquipmentDepreciation: 6000, monthlyFacilityCost: 0, monthlySlideVolume: 2000 })
    expect(res.status).toBe(200)
    expect(res.body.data.laborPerSlide).toBeCloseTo(20, 4)
    expect(res.body.data.equipmentPerSlide).toBeCloseTo(3, 4)

    const lab = db.prepare("SELECT value, source, confidence FROM ihc_cost_params WHERE param_key='labor_per_slide'").get() as any
    const eqp = db.prepare("SELECT value, source, confidence FROM ihc_cost_params WHERE param_key='equipment_per_slide'").get() as any
    expect(Number(lab.value)).toBeCloseTo(20, 4)
    expect(Number(eqp.value)).toBeCloseTo(3, 4)
    expect(lab.confidence).toBe('已校准')
    expect(eqp.confidence).toBe('已校准')

    // abc_audit_logs 落 before/after + operator=admin
    const after = db.prepare("SELECT * FROM abc_audit_logs WHERE module='antibody_cost' AND action='calibrate' ORDER BY created_at DESC").all() as any[]
    expect(after.length).toBe(before.n + 1)
    const log = after[0]
    expect(log.operator).toBe('admin')
    const detail = JSON.parse(log.detail)
    expect(detail.before).toBeTruthy()
    expect(detail.after).toBeTruthy()
    expect(detail.inputs.monthlySlideVolume).toBe(2000)
  })

  it('校准后 GET /cost-preview → laborEquipmentSource 翻成已校准', async () => {
    const res = await request(app).get('/api/v1/antibody-cost/cost-preview?name=2SC').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.laborEquipmentSource).toBe('已校准')
  })

  it('诚实降级：已校准参数被手工改值(不带 confidence) → 降级手工核定 → 整体转部分校准', async () => {
    const put = await request(app)
      .put('/api/v1/antibody-cost/cost-params/labor_per_slide')
      .set('Authorization', `Bearer ${token}`)
      .send({ value: 7 }) // 只改值、不带 confidence → 继承到的「已校准」应被降级
    expect(put.status).toBe(200)
    const db = await getDb()
    const lab = db.prepare("SELECT confidence FROM ihc_cost_params WHERE param_key='labor_per_slide'").get() as any
    expect(lab.confidence).toBe('手工核定')
    // labor 脱离校准、equipment 仍已校准 → 整体部分校准
    const preview = await request(app).get('/api/v1/antibody-cost/cost-preview?name=2SC').set('Authorization', `Bearer ${token}`)
    expect(preview.body.data.laborEquipmentSource).toBe('部分校准')
  })

  it('calibrate 校验：缺/非法月产片量 → 400', async () => {
    const res = await request(app)
      .post('/api/v1/antibody-cost/cost-params/calibrate')
      .set('Authorization', `Bearer ${token}`)
      .send({ monthlyTechnicianCost: 40000, monthlyEquipmentDepreciation: 6000, monthlySlideVolume: 0 })
    expect(res.status).toBe(400)
  })

  it('calibrate 防伪校准：原始 JSON 传 1e400(→Infinity) 成本 → 400，不写 Infinity 进库', async () => {
    const db = await getDb()
    const beforeVal = (db.prepare("SELECT value FROM ihc_cost_params WHERE param_key='labor_per_slide'").get() as any).value
    const res = await request(app)
      .post('/api/v1/antibody-cost/cost-params/calibrate')
      .set('Authorization', `Bearer ${token}`)
      .set('Content-Type', 'application/json')
      .send('{"monthlyTechnicianCost":1e400,"monthlyEquipmentDepreciation":1,"monthlySlideVolume":100}')
    expect(res.status).toBe(400)
    // 库里 labor 值未被 Infinity 污染（保持校准后的有限值）
    const afterVal = (db.prepare("SELECT value FROM ihc_cost_params WHERE param_key='labor_per_slide'").get() as any).value
    expect(afterVal).toBe(beforeVal)
    expect(Number.isFinite(Number(afterVal))).toBe(true)
  })
})
