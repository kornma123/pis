/**
 * W3 LIS 病例导入路由 —— 医院 upsert + 数量落库 + 自动样本判定 + 人工覆盖(manual 不被重传覆盖) + RBAC。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
let adminToken = ''
let whmToken = '' // warehouse_manager：reconciliation R 但无 W

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

describe('W3 RBAC', () => {
  it('warehouse_manager（reconciliation R 无 W）：列表可读，导入被拒 403', async () => {
    const request = await req()
    expect((await request(app).get('/api/v1/lis-cases').set('Authorization', `Bearer ${whmToken}`)).status).toBe(200)
    expect((await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${whmToken}`).send({ cases: CASES })).status).toBe(403)
  })
})
