/**
 * BV Phase 2：BOM 编辑落版本快照
 *
 * POST /boms → bom_versions 落初始版本（change_log='初始版本'，snapshot.materials 含用量）
 * PUT  /boms 改用量 → 第 2 行版本（version 升 v1.1，diff 含 changedMaterials，effective_scope=future_only）
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let app: any
let token: string
let db: any
const BOM_CODE = 'BV-P2-BOM'

beforeAll(async () => {
  db = await getDb()
  const bomRoutes = (await import('../src/routes/bom-v1.1.js')).default
  const authRoutes = (await import('../src/routes/auth.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/boms', router: bomRoutes },
  ])
  token = await loginAdmin(app)

  db.prepare(
    `INSERT INTO materials (id, code, name, spec, unit, category_id, price, status, is_deleted)
     VALUES ('MAT-BV-P2', 'C-BV-P2', '一抗A', '1ml', 'µL', 'CAT-A', 100, 1, 0)`,
  ).run()
})

async function req() {
  return (await import('supertest')).default
}

describe('BV-P2：BOM 编辑落版本快照', () => {
  let bomId: string

  it('POST /boms 落初始版本（change_log=初始版本）', async () => {
    const request = await req()
    const res = await request(app)
      .post('/api/v1/boms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        code: BOM_CODE,
        name: 'P2版本化BOM',
        type: 'ihc',
        materials: [{ materialId: 'MAT-BV-P2', usagePerSample: 2, unit: 'µL' }],
      })
    expect(res.status).toBe(201)
    bomId = res.body.data.id

    const versions = db.prepare('SELECT * FROM bom_versions WHERE bom_id = ?').all(bomId) as any[]
    expect(versions.length).toBe(1)
    expect(versions[0].change_log).toBe('初始版本')
    expect(versions[0].effective_scope).toBe('future_only')
    const snap = JSON.parse(versions[0].snapshot)
    expect(snap.materials).toHaveLength(1)
    expect(Number(snap.materials[0].usagePerSample)).toBe(2)
  })

  it('PUT /boms 改用量 → 第 2 版本 + diff 含 changedMaterials', async () => {
    const request = await req()
    const res = await request(app)
      .put(`/api/v1/boms/${bomId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'P2版本化BOM',
        materials: [{ materialId: 'MAT-BV-P2', usagePerSample: 5, unit: 'µL' }],
      })
    expect(res.status).toBe(200)
    expect(res.body.data.version).toBe('v1.1')

    const versions = db
      .prepare('SELECT * FROM bom_versions WHERE bom_id = ? ORDER BY version DESC')
      .all(bomId) as any[]
    expect(versions.length).toBe(2)
    const latest = versions.find((v) => v.version === 'v1.1')
    expect(latest).toBeTruthy()
    expect(latest.effective_scope).toBe('future_only')
    const diff = JSON.parse(latest.diff_summary)
    expect(diff.changedMaterials).toHaveLength(1)
    expect(Number(diff.changedMaterials[0].before.usagePerSample)).toBe(2)
    expect(Number(diff.changedMaterials[0].after.usagePerSample)).toBe(5)
  })
})
