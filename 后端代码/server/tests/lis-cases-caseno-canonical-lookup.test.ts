/**
 * lis-cases 读侧按 case_no 精确查库归一 —— dash PR 配套（对抗面板 wf_8e8997d5 matcher-sweep 逮到）。
 *
 * 缺陷：PUT /:caseNo/specimen-type（req.params.caseNo）与 GET /markers（req.query.caseNo）用**原始**病理号
 *   `WHERE case_no = ?` 精确查库，未先 canonicalCaseNo。而 lis_cases/lis_case_markers.case_no 落库是 canonical
 *   （#84 起 NFKC；本 dash PR 起含 dash 折叠）。→ 客户端传 raw 全角/异体横线号 'Z26–777'(en-dash) 而库存
 *   折叠后的 'Z26-777' → 精确匹配落空 → PUT 误 404（改不到样本类型·影响成本归类）、GET markers 返回空列表。
 *   （此为 #84 起就有的全角失配·dash PR 使其扩到横线变体；根治=读侧输入同经 canonicalCaseNo。）
 *
 * 本测试证两端点用 en-dash 号也命中已归一库行。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
let adminToken = ''
let partnerId = ''
const CANON = 'Z26-777' //   ASCII 落库形态（canonicalCaseNo 对其恒等）
const ENDASH = 'Z26–777' //  同一病理号的 en-dash(U+2013) 写法（客户端可能传入）

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function req() {
  return (await import('supertest')).default
}

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const lisRoutes = (await import('../src/routes/lis-cases-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/lis-cases', router: lisRoutes },
  ])
  adminToken = await login('admin', 'admin123')
  const request = await req()
  // 导入一例（ASCII 号·落库 canonical）+ 一条抗体
  await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
    .send({ cases: [{ 病理号: CANON, 送检医院: '横线读侧测试医院', 送检部位: '宫颈', 蜡块数: 1, HE切片数: 1, 免疫组化数: 1 }] })
  await request(app).post('/api/v1/lis-cases/import-markers').set('Authorization', `Bearer ${adminToken}`)
    .send({ markers: [{ 病理号: CANON, 抗体名: 'Ki-67', 申请类型: 'Y000001' }] })
  partnerId = (db.prepare('SELECT partner_id FROM lis_cases WHERE case_no = ?').get(CANON) as any)?.partner_id
})

describe('读侧 case_no 归一：raw en-dash 号也命中已归一库行', () => {
  it('sanity：库里存的是 ASCII canonical、partner + 抗体已落库', () => {
    expect(partnerId).toBeTruthy()
    expect((db.prepare('SELECT case_no FROM lis_cases WHERE case_no = ?').get(CANON) as any)?.case_no).toBe(CANON)
    expect((db.prepare('SELECT COUNT(*) n FROM lis_case_markers WHERE case_no = ?').get(CANON) as any).n).toBeGreaterThanOrEqual(1)
    expect(ENDASH).not.toBe(CANON) // 确是不同码点
  })

  it('PUT /:caseNo/specimen-type：URL 传 en-dash 号 → 归一命中 → 200 改到样本类型（非误 404）', async () => {
    const request = await req()
    const res = await request(app)
      .put(`/api/v1/lis-cases/${encodeURIComponent(ENDASH)}/specimen-type`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ specimenType: 'cytology', partnerId })
    expect(res.status).toBe(200)
    // 改动落到 canonical 行
    const row = db.prepare('SELECT specimen_type, specimen_type_source FROM lis_cases WHERE case_no = ? AND partner_id = ?').get(CANON, partnerId) as any
    expect(row.specimen_type).toBe('cytology')
    expect(row.specimen_type_source).toBe('manual')
  })

  it('GET /markers?caseNo=<en-dash>：归一命中 → 返回该例抗体（非空）', async () => {
    const request = await req()
    const res = await request(app)
      .get('/api/v1/lis-cases/markers')
      .query({ caseNo: ENDASH, partnerId })
      .set('Authorization', `Bearer ${adminToken}`)
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
    expect(res.body.data.some((m: any) => m.markerName === 'Ki-67')).toBe(true)
  })
})
