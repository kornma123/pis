/**
 * PRD-0 T1.2 + T1.3 — 跨院同号 LIS 导入幂等 + 人工覆盖带 partner。
 *
 * TC2：A、B 两院各导入同一 case_no → 两行并存，A 的 partner_id/数量不被 B 覆盖（ON CONFLICT(partner_id, case_no)）。
 * T1.3：人工覆盖样本类型需带 partner（跨院同号歧义时必须指定，否则 400）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any, db: any, adminToken = ''

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function imp(cases: any[]) {
  const request = (await import('supertest')).default
  return request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`).send({ cases })
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
})

describe('TC2 跨院同号导入不互相覆盖', () => {
  it('A院导 S26-DUP，B院导 S26-DUP → 两行并存，A 的数量不被 B 覆盖', async () => {
    const a = await imp([{ 病理号: 'S26-DUP', 送检医院: '跨院A医院', HE切片数: 1, 蜡块数: 1 }])
    expect(a.status).toBe(200)
    expect(a.body.data.imported).toBe(1)
    const b = await imp([{ 病理号: 'S26-DUP', 送检医院: '跨院B医院', HE切片数: 9, 蜡块数: 9 }])
    expect(b.status).toBe(200)
    expect(b.body.data.imported).toBe(1)

    const rows = db.prepare(
      `SELECT lc.he_slide_count AS he, p.name AS pname FROM lis_cases lc JOIN partners p ON p.id=lc.partner_id WHERE lc.case_no='S26-DUP' ORDER BY p.name`,
    ).all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.pname === '跨院A医院').he).toBe(1) // A 未被 B 覆盖
    expect(rows.find((r) => r.pname === '跨院B医院').he).toBe(9)
  })

  it('同院重导 S26-DUP → 该院行覆盖更新，不新增行、不波及他院', async () => {
    await imp([{ 病理号: 'S26-DUP', 送检医院: '跨院A医院', HE切片数: 5, 蜡块数: 5 }])
    const rows = db.prepare(
      `SELECT lc.he_slide_count AS he, p.name AS pname FROM lis_cases lc JOIN partners p ON p.id=lc.partner_id WHERE lc.case_no='S26-DUP' ORDER BY p.name`,
    ).all() as any[]
    expect(rows).toHaveLength(2) // 仍 2 行
    expect(rows.find((r) => r.pname === '跨院A医院').he).toBe(5) // A 覆盖更新
    expect(rows.find((r) => r.pname === '跨院B医院').he).toBe(9) // B 不变
  })
})

describe('T1.3 人工覆盖样本类型带 partner', () => {
  it('跨院同号 → 带 partnerId 覆盖只改该院行，不串到他院', async () => {
    const request = (await import('supertest')).default
    const aPid = (db.prepare(`SELECT id FROM partners WHERE name='跨院A医院'`).get() as any).id
    const bPid = (db.prepare(`SELECT id FROM partners WHERE name='跨院B医院'`).get() as any).id
    const res = await request(app).put('/api/v1/lis-cases/S26-DUP/specimen-type')
      .set('Authorization', `Bearer ${adminToken}`).send({ specimenType: 'cytology', partnerId: aPid })
    expect(res.status).toBe(200)
    const aRow = db.prepare(`SELECT specimen_type, specimen_type_source FROM lis_cases WHERE case_no='S26-DUP' AND partner_id=?`).get(aPid) as any
    const bRow = db.prepare(`SELECT specimen_type FROM lis_cases WHERE case_no='S26-DUP' AND partner_id=?`).get(bPid) as any
    expect(aRow.specimen_type).toBe('cytology')
    expect(aRow.specimen_type_source).toBe('manual')
    expect(bRow.specimen_type).not.toBe('cytology') // B 未被串改
  })

  it('跨院同号且未指定 partnerId → 400（歧义不得随机选院）', async () => {
    const request = (await import('supertest')).default
    const res = await request(app).put('/api/v1/lis-cases/S26-DUP/specimen-type')
      .set('Authorization', `Bearer ${adminToken}`).send({ specimenType: 'tissue' })
    expect(res.status).toBe(400)
  })
})
