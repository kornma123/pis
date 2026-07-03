/**
 * 抗体名称映射 A1+A3 —— TDD 红线（先写会失败的断言，守 PM 拍板口径）。
 *
 * 锁四条：
 *  1) 别名命中：LIS 写法 → 台账（价+剂型）——规范化(Ki67→Ki-67/S100→S-100/HER2→HER-2) + 生物学同义词种子(Ecad→E-cadherin 等 5)。
 *  2) 剂型歧义（A3）：同名多剂型 + LIS 无剂型 → 保守取高价 + formAssumed（剂型待确认）；给了 form 则精确取。
 *  3) 台账真缺（A1）：PD-1/cathepsinK/GPNMB/TROP-2/HP → missing（PD-1 ≠ PD-L1，绝不误映射）。
 *  4) 非抗体（白片/HE/深切重切/分子）不进缺价清单；HER2 等含 HE 的抗体不被误判为 HE 染色。
 * 并锁：规范化对台账单射（无碰撞）、DB 别名表 + 真缺 seed、resolve/别名 端点。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'
import {
  normalizeAntibodyName,
  classifyMarker,
  buildSeedLedgerIndex,
  buildSynonymMap,
  resolveForm,
  resolveAntibodyName,
  ANTIBODY_SYNONYM_SEED,
  ANTIBODY_MISSING_PRICE_SEED,
  type LedgerRow,
} from '../src/utils/antibody-name-map.js'
import { ANTIBODY_LEDGER_SEED } from '../src/utils/antibody-catalog.js'

const INDEX = buildSeedLedgerIndex()
const SYN = buildSynonymMap()
const resolve = (n: string, form?: string) => resolveAntibodyName(n, INDEX, SYN, form ? { form } : {})

describe('规范化 normalizeAntibodyName', () => {
  it('去括号克隆号/空格/连字符/点/大小写', () => {
    expect(normalizeAntibodyName('Ki-67')).toBe('KI67')
    expect(normalizeAntibodyName('Ki67')).toBe('KI67')
    expect(normalizeAntibodyName('S-100')).toBe('S100')
    expect(normalizeAntibodyName('PD-L1(22C3)')).toBe('PDL1')
    expect(normalizeAntibodyName('Melan A')).toBe('MELANA')
    expect(normalizeAntibodyName('SMARCA4(BRG1)')).toBe('SMARCA4')
  })
})

describe('规范化对台账 200 名单射（无碰撞）——安全自动匹配的前提', () => {
  it('每个台账名规范化后唯一映射回自己，无两名相撞', () => {
    const byNorm = new Map<string, string[]>()
    for (const a of ANTIBODY_LEDGER_SEED) {
      const k = normalizeAntibodyName(a.name)
      const arr = byNorm.get(k) ?? []
      if (!arr.includes(a.name)) arr.push(a.name)
      byNorm.set(k, arr)
    }
    const collisions = [...byNorm.entries()].filter(([, names]) => names.length > 1)
    expect(collisions).toEqual([])
  })
})

describe('classifyMarker：非抗体/特染识别', () => {
  it('白片/HE/深切重切/分子 各归位', () => {
    expect(classifyMarker('免组白片')).toBe('白片')
    expect(classifyMarker('免疫组化白片')).toBe('白片')
    expect(classifyMarker('免组HE')).toBe('HE')
    expect(classifyMarker('HE')).toBe('HE')
    expect(classifyMarker('深切')).toBe('重切深切')
    expect(classifyMarker('重切')).toBe('重切深切')
    expect(classifyMarker('分子白片')).toBe('分子')
  })
  it('特染仅返回「特染(疑)」提示（PAS/GMS/W-S/染色）', () => {
    expect(classifyMarker('PAS')).toBe('特染(疑)')
    expect(classifyMarker('PAS-D')).toBe('特染(疑)')
    expect(classifyMarker('GMS（六胺银染色）')).toBe('特染(疑)')
    expect(classifyMarker('W-S染色')).toBe('特染(疑)')
  })
  it('含 HE 的抗体不被误判为 HE 染色', () => {
    expect(classifyMarker('HER2')).toBe('抗体')
    expect(classifyMarker('HGAL')).toBe('抗体')
    expect(classifyMarker('hepatocyte')).toBe('抗体')
    expect(classifyMarker('Ki67')).toBe('抗体')
  })
})

describe('resolveAntibodyName：别名命中（台账已有价）', () => {
  it('规范化命中：Ki67→Ki-67（本月 52 次的大头）', () => {
    const r = resolve('Ki67')
    expect(r.matchKind).toBe('alias')
    expect(r.via).toBe('normalized')
    expect(r.canonicalName).toBe('Ki-67')
    expect(r.priceStatus).toBe('has_price')
    expect(r.perTestPrice).toBeCloseTo(4.261062, 4)
  })
  it('规范化命中：S100→S-100 / HER2→HER-2 / PD-L1(22C3)→PD-L1', () => {
    expect(resolve('S100').canonicalName).toBe('S-100')
    expect(resolve('HER2').canonicalName).toBe('HER-2')
    const pdl1 = resolve('PD-L1(22C3)')
    expect(pdl1.canonicalName).toBe('PD-L1')
    expect(pdl1.perTestPrice).toBeCloseTo(11.362832, 4)
  })
  it('生物学同义词种子：Ecad→E-cadherin（A1 五个假缺之一）', () => {
    const r = resolve('Ecad')
    expect(r.matchKind).toBe('alias')
    expect(r.via).toBe('synonym')
    expect(r.canonicalName).toBe('E-cadherin')
    expect(r.perTestPrice).toBeCloseTo(3.345133, 4)
  })
  it('A1 五个「假缺」全部经别名对上台账价', () => {
    expect(resolve('Ecad').canonicalName).toBe('E-cadherin')
    expect(resolve('Melan A').canonicalName).toBe('MART-1/melan-A')
    expect(resolve('Vimentin').canonicalName).toBe('VIM')
    expect(resolve('cyclinD1').canonicalName).toBe('CYCD-1')
    expect(resolve('SMARCA4(BRG1)').canonicalName).toBe('SMARC4')
    for (const n of ['Ecad', 'Melan A', 'Vimentin', 'cyclinD1', 'SMARCA4(BRG1)']) {
      expect(resolve(n).priceStatus).toBe('has_price')
    }
  })
})

describe('resolveAntibodyName：精确名命中', () => {
  it('P53/2SC 精确台账名', () => {
    expect(resolve('P53').matchKind).toBe('exact')
    const twosc = resolve('2SC')
    expect(twosc.matchKind).toBe('exact')
    expect(twosc.perTestPrice).toBeCloseTo(99.823009, 4)
  })
})

describe('resolveAntibodyName：剂型歧义（A3）—— 保守取高价 + 剂型待确认', () => {
  it('CK19（原液¥3.84 / 即用¥13.27）LIS 无剂型 → 保守取即用(高价) + formAssumed', () => {
    const r = resolve('CK19')
    expect(r.matchKind).toBe('exact')
    expect(r.formAssumed).toBe(true)
    expect(r.form).toBe('即用')
    expect(r.perTestPrice).toBeCloseTo(13.274336, 4)
    expect(r.note).toContain('剂型待确认')
  })
  it('指定 form=原液 → 精确取低价, 不再 formAssumed', () => {
    const r = resolve('CK19', '原液')
    expect(r.formAssumed).toBe(false)
    expect(r.form).toBe('原液')
    expect(r.perTestPrice).toBeCloseTo(3.838938, 4)
  })
  it('resolveForm 纯函数：单剂型不 assumed；多剂型取高价', () => {
    const single: LedgerRow[] = [{ name: 'X', form: '原液', perTestPrice: 2 }]
    expect(resolveForm(single).formAssumed).toBe(false)
    const multi: LedgerRow[] = [
      { name: 'CK19', form: '原液', perTestPrice: 3.84 },
      { name: 'CK19', form: '即用', perTestPrice: 13.27 },
    ]
    const rf = resolveForm(multi)
    expect(rf.formAssumed).toBe(true)
    expect(rf.row.form).toBe('即用')
  })
})

describe('resolveAntibodyName：台账真缺（A1）—— missing + PD-1≠PD-L1', () => {
  it('PD-1/cathepsinK/GPNMB/TROP-2/HP → missing', () => {
    for (const n of ['PD-1', 'cathepsinK', 'GPNMB', 'TROP-2', 'HP']) {
      const r = resolve(n)
      expect(r.matchKind, `${n} 应为 missing`).toBe('missing')
      expect(r.priceStatus).toBe('missing')
      expect(r.perTestPrice).toBeNull()
    }
  })
  it('PD-1 绝不被映射到 PD-L1（不同抗体）', () => {
    const r = resolve('PD-1')
    expect(r.canonicalName).not.toBe('PD-L1')
    expect(r.canonicalName).toBeNull()
  })
  it('真缺种子恰为 5 种', () => {
    expect(ANTIBODY_MISSING_PRICE_SEED.map((m) => m.name).sort()).toEqual(
      ['GPNMB', 'HP', 'PD-1', 'TROP-2', 'cathepsinK'].sort(),
    )
  })
})

describe('resolveAntibodyName：非抗体不进缺价清单', () => {
  it('白片/HE → non_antibody（不是 missing）', () => {
    expect(resolve('免组白片').matchKind).toBe('non_antibody')
    expect(resolve('免组白片').category).toBe('白片')
    expect(resolve('免组HE').matchKind).toBe('non_antibody')
    expect(resolve('免组HE').category).toBe('HE')
  })
})

describe('别名种子完整性', () => {
  it('5 个同义词目标台账名都真实存在', () => {
    const names = new Set(ANTIBODY_LEDGER_SEED.map((a) => a.name))
    expect(ANTIBODY_SYNONYM_SEED.length).toBe(5)
    for (const s of ANTIBODY_SYNONYM_SEED) {
      expect(names.has(s.canonicalName), `${s.lisName}→${s.canonicalName} 目标应在台账`).toBe(true)
    }
  })
})

// ———————————————————— DB + 路由（antibody_aliases 表 + resolve/别名端点） ————————————————————
describe('DB seed：antibody_aliases 表 + 真缺抗体入库', () => {
  let db: any
  beforeAll(async () => { db = await getDb() })

  it('antibody_aliases 已 seed 5 个同义词', () => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM antibody_aliases').get() as { n: number }).n
    expect(n).toBeGreaterThanOrEqual(5)
    const ecad = db.prepare("SELECT canonical_name FROM antibody_aliases WHERE lis_name = 'Ecad'").get() as { canonical_name: string }
    expect(ecad.canonical_name).toBe('E-cadherin')
  })
  it('5 种台账真缺抗体入 antibodies 表·price_status=missing', () => {
    for (const n of ['PD-1', 'GPNMB', 'HP', 'TROP-2', 'cathepsinK']) {
      const row = db.prepare('SELECT price_status, per_test_price FROM antibodies WHERE name = ? AND is_deleted = 0').get(n) as
        | { price_status: string; per_test_price: number | null }
        | undefined
      expect(row, `${n} 应入库`).toBeTruthy()
      expect(row!.price_status).toBe('missing')
    }
  })
})

describe('路由：GET /antibodies/resolve + 别名 CRUD + /cost-preview 别名可用', () => {
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

  it('GET /antibodies/resolve?name=Ki67 → alias + has_price', async () => {
    const res = await request(app).get('/api/v1/antibody-cost/antibodies/resolve?name=Ki67').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.matchKind).toBe('alias')
    expect(res.body.data.canonicalName).toBe('Ki-67')
    expect(res.body.data.priceStatus).toBe('has_price')
  })
  it('GET /antibodies/resolve?name=PD-1 → 缺价（priceStatus=missing）且绝非 PD-L1', async () => {
    // DB 路径下 PD-1 已作为「已知但无价」抗体入库（ANTIBODY_MISSING_PRICE_SEED），故精确命中该行、priceStatus=missing。
    // 关键不变量：缺价 + 不误映射到 PD-L1（缺价清单由 priceStatus 驱动，非 matchKind）。
    const res = await request(app).get('/api/v1/antibody-cost/antibodies/resolve?name=PD-1').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.priceStatus).toBe('missing')
    expect(res.body.data.perTestPrice).toBeNull()
    expect(res.body.data.canonicalName).not.toBe('PD-L1')
  })
  it('GET /antibodies/resolve?name=CK19 → 剂型待确认（保守取高价）', async () => {
    const res = await request(app).get('/api/v1/antibody-cost/antibodies/resolve?name=CK19').set('Authorization', `Bearer ${token}`)
    expect(res.body.data.formAssumed).toBe(true)
    expect(res.body.data.form).toBe('即用')
  })
  it('GET /cost-preview?name=Ecad 现在能算（此前别名对不上会 404）', async () => {
    const res = await request(app).get('/api/v1/antibody-cost/cost-preview?name=Ecad').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.primary).toBeCloseTo(3.345133, 4)
    expect(res.body.data.completeness).toBe('精算')
  })
  it('POST /antibody-aliases 加新别名 → resolve 立即命中', async () => {
    const add = await request(app)
      .post('/api/v1/antibody-cost/antibody-aliases')
      .set('Authorization', `Bearer ${token}`)
      .send({ lisName: 'CKpan', canonicalName: 'CK广', note: '测试别名' })
    expect(add.status).toBe(201)
    const res = await request(app).get('/api/v1/antibody-cost/antibodies/resolve?name=CKpan').set('Authorization', `Bearer ${token}`)
    expect(res.body.data.canonicalName).toBe('CK广')
    expect(res.body.data.via).toBe('synonym')
  })
})
