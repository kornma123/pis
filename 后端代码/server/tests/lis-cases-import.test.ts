/**
 * W3 LIS 病例导入路由 —— 医院 upsert + 数量落库 + 自动样本判定 + 人工覆盖(manual 不被重传覆盖) + RBAC。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
let adminToken = ''
let whmToken = '' // warehouse_manager：reconciliation R 但无 W
let financeToken = '' // finance：LIS 导入新口径 owner（管理员+财务）
let techToken = '' // technician：持 reconciliation W，但导入被收窄 → 应 403

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function req() { return (await import('supertest')).default }

// 真实形态的导入行（3 家医院、组织+细胞学混合）
const CASES = [
  { 病理号: 'S26-02725', 送检医院: '上海和睦家医院', 送检部位: '宫颈3点', 蜡块数: 5, HE切片数: 5, 免疫组化数: 2, 病例状态: '已签发' },
  { 病理号: 'X26-00150', 送检医院: '上海和睦家医院', 送检部位: '右侧胸腔积液', 大体描述: '制成细胞蜡块', 蜡块数: 3, HE切片数: 3, 免疫组化数: 12 },
  { 病理号: 'X26-00151', 送检医院: '东安县人民医院', 送检部位: '胸水', 蜡块数: 1, HE切片数: 2 },
  { 病理号: 'S26-03046', 送检医院: '上海中大肿瘤医院', 送检部位: '左颈部淋巴结', 蜡块数: 4, HE切片数: 1, 免疫组化数: 12, 特染数: 1 },
  { 病理号: '', 送检医院: '空行' }, // 无效 → skip
]

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const lisRoutes = (await import('../src/routes/lis-cases-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/lis-cases', router: lisRoutes },
  ])
  adminToken = await login('admin', 'admin123')
  whmToken = await login('cangguan', 'CoreOne2026!')
  financeToken = await login('caiwu', 'CoreOne2026!')
  techToken = await login('jishuyuan1', 'CoreOne2026!')
})

describe('W3 LIS 导入：医院 upsert + 数量 + 自动样本', () => {
  it('导入 4 有效例（跳 1 空行）、新建 3 家医院、和睦家匹配同一 partner', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`).send({ cases: CASES })
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(4)
    expect(res.body.data.skipped).toBe(1)
    expect(res.body.data.partnersMatched).toBe(3) // 和睦家/东安/中大
    expect(res.body.data.partnersCreated).toBe(3)
  })

  it('数量落库 + 自动样本类型：组织=tissue / 积液=cytology', async () => {
    const request = await req()
    const res = await request(app).get('/api/v1/lis-cases?keyword=S26-02725').set('Authorization', `Bearer ${adminToken}`)
    const tissue = res.body.data.list.find((x: any) => x.caseNo === 'S26-02725')
    expect(tissue.quantities).toMatchObject({ block: 5, heSlide: 5, ihc: 2 })
    expect(tissue.specimenType).toBe('tissue')
    expect(tissue.specimenTypeSource).toBe('auto')
    expect(tissue.partnerName).toBe('上海和睦家医院')

    const cyto = (await request(app).get('/api/v1/lis-cases?keyword=X26-00150').set('Authorization', `Bearer ${adminToken}`)).body.data.list[0]
    expect(cyto.specimenType).toBe('cytology')
  })

  it('幂等：重复导入相同 case 不增 partner（matched 不变，数量覆盖更新）', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'S26-02725', 送检医院: '上海和睦家医院', 送检部位: '宫颈', 蜡块数: 6, HE切片数: 5 }] })
    expect(res.body.data.partnersCreated).toBe(0)
    const got = (await request(app).get('/api/v1/lis-cases?keyword=S26-02725').set('Authorization', `Bearer ${adminToken}`)).body.data.list[0]
    expect(got.quantities.block).toBe(6) // 覆盖更新
  })
})

describe('W3 样本类型人工覆盖（manual 永远赢）', () => {
  it('覆盖 S26-02725 → cytology(manual)，再导入(auto=tissue)不被覆盖', async () => {
    const request = await req()
    const ov = await request(app).put('/api/v1/lis-cases/S26-02725/specimen-type').set('Authorization', `Bearer ${adminToken}`).send({ specimenType: 'cytology' })
    expect(ov.status).toBe(200)
    let got = (await request(app).get('/api/v1/lis-cases?keyword=S26-02725').set('Authorization', `Bearer ${adminToken}`)).body.data.list[0]
    expect(got.specimenType).toBe('cytology')
    expect(got.specimenTypeSource).toBe('manual')

    // 重新导入（自动会判 tissue）→ manual 保留
    await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'S26-02725', 送检医院: '上海和睦家医院', 送检部位: '宫颈', 蜡块数: 5, HE切片数: 5 }] })
    got = (await request(app).get('/api/v1/lis-cases?keyword=S26-02725').set('Authorization', `Bearer ${adminToken}`)).body.data.list[0]
    expect(got.specimenType).toBe('cytology')
    expect(got.specimenTypeSource).toBe('manual')
  })

  it('非法 specimenType → 400；不存在 case → 404', async () => {
    const request = await req()
    expect((await request(app).put('/api/v1/lis-cases/S26-02725/specimen-type').set('Authorization', `Bearer ${adminToken}`).send({ specimenType: 'bogus' })).status).toBe(400)
    expect((await request(app).put('/api/v1/lis-cases/NO-SUCH/specimen-type').set('Authorization', `Bearer ${adminToken}`).send({ specimenType: 'tissue' })).status).toBe(404)
  })
})

describe('W3 RBAC：导入/预览收窄到管理员+财务；样本覆盖仍 reconciliation W', () => {
  it('finance（LIS 导入新口径 owner）：导入 200、预览 200', async () => {
    const request = await req()
    expect((await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${financeToken}`).send({ cases: CASES })).status).toBe(200)
    expect((await request(app).post('/api/v1/lis-cases/preview').set('Authorization', `Bearer ${financeToken}`).send({ cases: CASES })).status).toBe(200)
  })

  it('technician（持 reconciliation W 但非管理员/财务）：导入 403、预览 403（口径数据源已收窄）', async () => {
    const request = await req()
    expect((await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${techToken}`).send({ cases: CASES })).status).toBe(403)
    expect((await request(app).post('/api/v1/lis-cases/preview').set('Authorization', `Bearer ${techToken}`).send({ cases: CASES })).status).toBe(403)
  })

  it('technician 仍可做样本类型人工覆盖（reconciliation W，单例技术更正不随导入收窄）', async () => {
    const request = await req()
    const ov = await request(app).put('/api/v1/lis-cases/S26-02725/specimen-type').set('Authorization', `Bearer ${techToken}`).send({ specimenType: 'tissue' })
    expect(ov.status).toBe(200)
  })

  it('warehouse_manager（reconciliation R 无 W）：列表可读，导入被拒 403', async () => {
    const request = await req()
    expect((await request(app).get('/api/v1/lis-cases').set('Authorization', `Bearer ${whmToken}`)).status).toBe(200)
    expect((await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${whmToken}`).send({ cases: CASES })).status).toBe(403)
  })
})

describe('导入结果拆新增/更新（补传可见）', () => {
  it('已存在→更新、新病理号→新增', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [
        { 病理号: 'S26-02725', 送检医院: '上海和睦家医院', 蜡块数: 6 }, // 前面已导→更新
        { 病理号: 'NEW-9001', 送检医院: '上海和睦家医院', 蜡块数: 1 }, // 新→新增
      ] })
    expect(res.status).toBe(200)
    expect(res.body.data.updated).toBe(1)
    expect(res.body.data.inserted).toBe(1)
    expect(res.body.data.imported).toBe(2)
  })
})

describe('抗体清单导入（按病理号 join 定医院 + 认不出单列 + 幂等整例刷新）', () => {
  const MARKERS = [
    { caseNo: 'S26-02725', markerName: 'ER', adviceType: 'Y000001', waxNo: 'A1', sectionNo: '1' },
    { caseNo: 'S26-02725', markerName: 'PR', adviceType: 'Y000001', waxNo: 'A1', sectionNo: '2' },
    { caseNo: 'S26-02725', markerName: '白片X', adviceType: 'Y000007', waxNo: 'A1', sectionNo: '3' },
    { caseNo: 'NO-EXIST-1', markerName: 'HER2', adviceType: 'Y000001' }, // 病理号在工作量表查无 → 认不出
    { caseNo: '', markerName: 'CK' }, // 无病理号 → skip
  ]
  it('命中的落库、认不出的单列、无效跳过', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/import-markers').set('Authorization', `Bearer ${adminToken}`).send({ markers: MARKERS })
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(3) // S26-02725 的 3 行
    expect(res.body.data.casesAffected).toBe(1)
    expect(res.body.data.skipped).toBe(1) // 空病理号
    expect(res.body.data.unmatched).toBe(1) // NO-EXIST-1
    expect(res.body.data.unmatchedCases).toContain('NO-EXIST-1')
    const rows = db.prepare(`SELECT marker_name, advice_type, partner_id FROM lis_case_markers WHERE case_no='S26-02725' ORDER BY section_no`).all() as any[]
    expect(rows.map((r: any) => r.marker_name)).toEqual(['ER', 'PR', '白片X'])
    expect(rows.every((r: any) => r.partner_id)).toBe(true) // 都挂上了医院
  })
  it('幂等：补传该例抗体（少一个）→ 整例刷新，不残留旧行', async () => {
    const request = await req()
    await request(app).post('/api/v1/lis-cases/import-markers').set('Authorization', `Bearer ${adminToken}`)
      .send({ markers: [{ caseNo: 'S26-02725', markerName: 'ER', adviceType: 'Y000001', sectionNo: '1' }] })
    const rows = db.prepare(`SELECT marker_name FROM lis_case_markers WHERE case_no='S26-02725'`).all() as any[]
    expect(rows).toHaveLength(1) // 从 3 刷新成 1，旧 PR/白片 已删
    expect(rows[0].marker_name).toBe('ER')
  })
  it('RBAC：technician 导抗体 → 403（同工作量导入收窄）', async () => {
    const request = await req()
    expect((await request(app).post('/api/v1/lis-cases/import-markers').set('Authorization', `Bearer ${techToken}`).send({ markers: MARKERS })).status).toBe(403)
  })
})

describe('#163 阶段1：跨月同号导入硬拒（不覆盖早月事实行）', () => {
  const H = '跨月守卫测试医院' // 合成夹具：病理号/医院均非真实数据
  const imp = async (cases: Record<string, unknown>[]) => {
    const request = await req()
    return request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`).send({ cases })
  }

  it('五月首导 inserted；六月同号重导 → 拒收 + 计数 + 样例，库中仍是五月原始数据', async () => {
    const first = await imp([{ 病理号: 'CM26-1001', 送检医院: H, 登记时间: '2026-05-10', 蜡块数: 3, HE切片数: 2, 免疫组化数: 4 }])
    expect(first.status).toBe(200)
    expect(first.body.data.inserted).toBe(1)
    expect(first.body.data.rejectedCrossMonth).toBe(0)

    const second = await imp([{ 病理号: 'CM26-1001', 送检医院: H, 登记时间: '2026-06-08', 蜡块数: 9, HE切片数: 9 }])
    expect(second.status).toBe(200)
    expect(second.body.data.rejectedCrossMonth).toBe(1)
    expect(second.body.data.imported).toBe(0)
    expect(second.body.data.updated).toBe(0)
    expect(second.body.data.rejectedCrossMonthSamples).toEqual([
      { caseNo: 'CM26-1001', partnerName: H, existingMonth: '2026-05', incomingMonth: '2026-06' },
    ])
    expect(second.body.message).toContain('已拒收') // 前端小票落地前，message 是唯一人类可读的拒收提示通道，钉住模板

    const row = db.prepare(`SELECT operate_time, block_count, he_slide_count, ihc_count FROM lis_cases WHERE case_no='CM26-1001'`).get() as any
    expect(row.operate_time).toBe('2026-05-10') // 月锚未被改写
    expect(row.block_count).toBe(3) // 数量标量未被六月行覆盖
    expect(row.ihc_count).toBe(4)
  })

  it('同月重传（不同日 + 斜杠日期形）→ 原地 upsert 更新，可重传语义不变', async () => {
    const res = await imp([{ 病理号: 'CM26-1001', 送检医院: H, 登记时间: '2026/05/20', 蜡块数: 5, HE切片数: 2 }])
    expect(res.body.data.updated).toBe(1)
    expect(res.body.data.rejectedCrossMonth).toBe(0)
    const row = db.prepare(`SELECT operate_time, block_count FROM lis_cases WHERE case_no='CM26-1001'`).get() as any
    expect(row.block_count).toBe(5) // 同月重传照常覆盖
    expect(row.operate_time).toBe('2026/05/20')
  })

  it('Excel 序列号日期（raw:true 导出形态）跨月同样被拒：toDateish 归一后比较', async () => {
    // 46181 = 2026-06-08 的 Excel 序列号（(46181-25569)*86400000 → UTC 2026-06-08）
    const res = await imp([{ 病理号: 'CM26-1001', 送检医院: H, 登记时间: 46181, 蜡块数: 8 }])
    expect(res.body.data.rejectedCrossMonth).toBe(1)
    expect(res.body.data.rejectedCrossMonthSamples[0]).toMatchObject({ existingMonth: '2026-05', incomingMonth: '2026-06' })
    expect((db.prepare(`SELECT block_count FROM lis_cases WHERE case_no='CM26-1001'`).get() as any).block_count).toBe(5)
  })

  it('库行有月锚而导入行日期缺失/不可解析 → 拒收（放行会把 operate_time 覆盖成空 = 抹掉月锚）', async () => {
    const noDate = await imp([{ 病理号: 'CM26-1001', 送检医院: H, 蜡块数: 7 }])
    expect(noDate.body.data.rejectedCrossMonth).toBe(1)
    expect(noDate.body.data.rejectedCrossMonthSamples[0]).toMatchObject({ existingMonth: '2026-05', incomingMonth: '' })
    const garbled = await imp([{ 病理号: 'CM26-1001', 送检医院: H, 登记时间: '乱码日期', 蜡块数: 7 }])
    expect(garbled.body.data.rejectedCrossMonth).toBe(1)
    const row = db.prepare(`SELECT block_count, operate_time FROM lis_cases WHERE case_no='CM26-1001'`).get() as any
    expect(row.operate_time).toBe('2026/05/20')
    expect(row.block_count).toBe(5) // 数量标量同样未被乱码行覆盖
  })

  it('库行无月锚（旧无日期行）→ 任意月导入放行 = 补日期修复通道；月锚一旦建立即受保护', async () => {
    await imp([{ 病理号: 'CM26-2001', 送检医院: H, 蜡块数: 1 }]) // 无日期首导 → operate_time NULL
    const repair = await imp([{ 病理号: 'CM26-2001', 送检医院: H, 登记时间: '2026-06-01', 蜡块数: 2 }])
    expect(repair.body.data.updated).toBe(1)
    expect(repair.body.data.rejectedCrossMonth).toBe(0)
    expect((db.prepare(`SELECT operate_time FROM lis_cases WHERE case_no='CM26-2001'`).get() as any).operate_time).toBe('2026-06-01')
    const crossAfterRepair = await imp([{ 病理号: 'CM26-2001', 送检医院: H, 登记时间: '2026-07-01', 蜡块数: 9 }])
    expect(crossAfterRepair.body.data.rejectedCrossMonth).toBe(1)
    expect((db.prepare(`SELECT block_count FROM lis_cases WHERE case_no='CM26-2001'`).get() as any).block_count).toBe(2)
  })

  it('混合批：新增行照常入库、跨月行单独拒收，计数各归各、事务不整体回滚', async () => {
    const res = await imp([
      { 病理号: 'CM26-3001', 送检医院: H, 登记时间: '2026-05-05', 蜡块数: 2 }, // 新号 → 新增
      { 病理号: 'CM26-1001', 送检医院: H, 登记时间: '2026-08-01', 蜡块数: 9 }, // 跨月 → 拒
    ])
    expect(res.status).toBe(200)
    expect(res.body.data.inserted).toBe(1)
    expect(res.body.data.imported).toBe(1)
    expect(res.body.data.rejectedCrossMonth).toBe(1)
    expect(db.prepare(`SELECT 1 FROM lis_cases WHERE case_no='CM26-3001'`).get()).toBeTruthy()
  })

  it('同批内同号跨月：首行落库建立月锚后，后续跨月行即被拒（批内自洽）', async () => {
    const res = await imp([
      { 病理号: 'CM26-4001', 送检医院: H, 登记时间: '2026-05-03', 蜡块数: 1 },
      { 病理号: 'CM26-4001', 送检医院: H, 登记时间: '2026-06-03', 蜡块数: 8 },
    ])
    expect(res.body.data.inserted).toBe(1)
    expect(res.body.data.rejectedCrossMonth).toBe(1)
    expect((db.prepare(`SELECT block_count FROM lis_cases WHERE case_no='CM26-4001'`).get() as any).block_count).toBe(1)
  })

  it('跨院同号不同月 ≠ 跨月重号：守卫键含 partner_id，医院B 首导同号新月照常入库不误拒', async () => {
    const request = await req()
    const resB = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'CM26-1001', 送检医院: '跨月守卫测试医院B', 登记时间: '2026-06-15', 蜡块数: 4 }] })
    expect(resB.body.data.inserted).toBe(1)
    expect(resB.body.data.rejectedCrossMonth).toBe(0)
    const rows = db.prepare(`SELECT partner_id FROM lis_cases WHERE case_no='CM26-1001'`).all() as any[]
    expect(rows).toHaveLength(2) // A 院五月行与 B 院六月行并存，互不干涉
    expect(new Set(rows.map((r) => r.partner_id)).size).toBe(2)
  })

  it('口径 pin：库行日期为非补零形（legacy）＝按月口径不可见 → 视同无锚放行（与下游 substr 月过滤同盲；阶段2清洗存量后自动闭合）', async () => {
    // 正常导入线不会再产生此形态（toDateish 输出恒补零）；直改库模拟 legacy 行
    db.prepare(`UPDATE lis_cases SET operate_time='2026/5/9' WHERE case_no='CM26-2001'`).run()
    const res = await imp([{ 病理号: 'CM26-2001', 送检医院: H, 登记时间: '2026-08-01', 蜡块数: 3 }])
    expect(res.body.data.updated).toBe(1) // 有意 fail-open：existingMonth='' 视同无锚，钉成口径而非留成暗坑
    expect(res.body.data.rejectedCrossMonth).toBe(0)
  })
})

describe('最近导入批次接口', () => {
  it('GET /batches 返回最近批次（含例数/医院数）', async () => {
    const request = await req()
    const res = await request(app).get('/api/v1/lis-cases/batches?limit=3').set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data.length).toBeGreaterThan(0)
    expect(res.body.data.length).toBeLessThanOrEqual(3)
    expect(res.body.data[0].caseCount).toBeGreaterThan(0)
    expect(res.body.data[0]).toHaveProperty('importBatch')
  })
})
