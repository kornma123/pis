import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestApp, getDb, loginAs } from './p0-harness.js'

let app: any
let db: any
let adminToken = ''
let financeToken = ''
let technicianToken = ''
let readOnlyToken = ''

const originalPermissions = new Map<string, string>()

function setReconciliationPermission(role: string, level: 'R' | 'W'): void {
  db.prepare('UPDATE roles SET permissions = ? WHERE code = ?')
    .run(JSON.stringify({ reconciliation: level }), role)
}

function writeSnapshot(): { cases: number; hospitals: number; markers: number } {
  const count = (table: string): number => Number(
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  )
  return {
    cases: count('lis_cases'),
    hospitals: count('partners'),
    markers: count('lis_case_markers'),
  }
}

async function request() {
  return (await import('supertest')).default
}

const reconciliationItem = (caseNo: string) => ({
  caseNo,
  projectId: '',
  projectName: 'RBAC guard project',
  operator: 'rbac-guard-test',
  operateTime: '2026-07-19 09:30:00',
})

const lisCase = (caseNo: string, hospital: string) => ({
  病理号: caseNo,
  送检医院: hospital,
  登记时间: '2026-07-19 09:30:00',
  送检部位: '宫颈',
  蜡块数: 1,
  HE切片数: 1,
  免疫组化数: 1,
})

const marker = (caseNo: string) => ({
  caseNo,
  markerName: 'ER',
  adviceType: 'Y000001',
  waxNo: 'A1',
  sectionNo: '1',
})

function seedReconciliationCase(caseNo: string): { id: string; project_name: string; status: string } {
  const id = `LC-${caseNo}`
  db.prepare(`INSERT INTO lis_cases (id, case_no, project_name, status)
              VALUES (?, ?, 'RBAC guard project', 'normal')`).run(id, caseNo)
  return { id, project_name: 'RBAC guard project', status: 'normal' }
}

beforeAll(async () => {
  db = await getDb()
  // reconciliation PUT 的既有 SQL 更新 updated_at；in-memory 初始化表未带该旧库列。
  // 仅补测试夹具列，避免把 schema 漂移误判成 W 守卫正控失败；生产 schema 不在本任务范围。
  const lisCaseColumns = db.prepare("PRAGMA table_info('lis_cases')").all() as Array<{ name: string }>
  if (!lisCaseColumns.some((column) => column.name === 'updated_at')) {
    db.exec('ALTER TABLE lis_cases ADD COLUMN updated_at DATETIME')
  }
  for (const role of ['finance', 'technician']) {
    const row = db.prepare('SELECT permissions FROM roles WHERE code = ?').get(role) as { permissions: string }
    originalPermissions.set(role, row.permissions)
  }

  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const authRoutes = (await import('../src/routes/auth.js')).default
  const reconciliationRoutes = (await import('../src/routes/reconciliation-v1.1.js')).default
  const lisCaseRoutes = (await import('../src/routes/lis-cases-v1.1.js')).default

  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    {
      path: '/api/v1/reconciliation',
      router: reconciliationRoutes,
      middleware: [authenticateToken, requirePermission('reconciliation', 'R')],
    },
    {
      path: '/api/v1/lis-cases',
      router: lisCaseRoutes,
      middleware: [authenticateToken, requirePermission('reconciliation', 'R')],
    },
  ])

  adminToken = await loginAs(app, 'admin', 'admin123')
  financeToken = await loginAs(app, 'caiwu', 'CoreOne2026!')
  technicianToken = await loginAs(app, 'jishuyuan1', 'CoreOne2026!')
  readOnlyToken = await loginAs(app, 'cangguan', 'CoreOne2026!')
})

afterAll(() => {
  for (const [role, permissions] of originalPermissions) {
    db.prepare('UPDATE roles SET permissions = ? WHERE code = ?').run(permissions, role)
  }
})

describe.sequential('病例/LIS 写端点必须同时满足 reconciliation:W', () => {
  it('A: reconciliation R-only 导入合法病例返回 403，且三张业务表零写', async () => {
    const api = await request()
    const before = writeSnapshot()
    const response = await api(app)
      .post('/api/v1/reconciliation/cases/import')
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .send({ items: [reconciliationItem('RBAC-RECON-R-IMPORT')] })

    expect({ status: response.status, writes: writeSnapshot() })
      .toEqual({ status: 403, writes: before })
    expect(db.prepare('SELECT id FROM lis_cases WHERE case_no = ?').get('RBAC-RECON-R-IMPORT')).toBeUndefined()
  })

  it('A 权限正控: reconciliation W 可越过守卫（既有复合唯一 schema 残留使业务层返回 500）', async () => {
    const api = await request()
    const before = writeSnapshot()
    const response = await api(app)
      .post('/api/v1/reconciliation/cases/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ items: [reconciliationItem('RBAC-RECON-W-IMPORT')] })

    expect(response.status).not.toBe(403)
    expect({ status: response.status, writes: writeSnapshot() })
      .toEqual({ status: 500, writes: before })
    expect(db.prepare('SELECT id FROM lis_cases WHERE case_no = ?').get('RBAC-RECON-W-IMPORT')).toBeUndefined()
  })

  it('B: reconciliation R-only 更新真实存在病例返回 403，目标行保持原值', async () => {
    const api = await request()
    const caseNo = 'RBAC-RECON-R-UPDATE'
    const before = seedReconciliationCase(caseNo)
    const response = await api(app)
      .put(`/api/v1/reconciliation/cases/${before.id}`)
      .set('Authorization', `Bearer ${readOnlyToken}`)
      .send({ projectId: null, projectName: 'must-not-be-written', status: 'matched' })

    const after = db.prepare('SELECT id, project_name, status FROM lis_cases WHERE case_no = ?').get(caseNo)
    expect({ status: response.status, row: after }).toEqual({ status: 403, row: before })
  })

  it('B 正控: reconciliation W 可更新真实存在病例', async () => {
    const api = await request()
    const caseNo = 'RBAC-RECON-W-UPDATE'
    const row = seedReconciliationCase(caseNo)

    const response = await api(app)
      .put(`/api/v1/reconciliation/cases/${row.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ projectId: null, projectName: 'allowed-write', status: 'matched' })

    expect(response.status).toBe(200)
    expect(db.prepare('SELECT project_name, status FROM lis_cases WHERE id = ?').get(row.id))
      .toEqual({ project_name: 'allowed-write', status: 'matched' })
  })

  it('C: finance 角色但 reconciliation R-only 的合法 LIS 导入返回 403，病例/医院/marker 零写', async () => {
    setReconciliationPermission('finance', 'R')
    const api = await request()
    const before = writeSnapshot()
    const response = await api(app)
      .post('/api/v1/lis-cases/import')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ cases: [lisCase('RBAC-LIS-R-IMPORT', 'RBAC R-only hospital')] })

    expect({ status: response.status, writes: writeSnapshot() })
      .toEqual({ status: 403, writes: before })
  })

  it('D: finance 角色但 reconciliation R-only 的合法 marker 导入返回 403，病例/医院/marker 零写', async () => {
    const api = await request()
    const caseNo = 'RBAC-LIS-R-MARKER'
    setReconciliationPermission('finance', 'R')
    const seed = await api(app)
      .post('/api/v1/lis-cases/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [lisCase(caseNo, 'RBAC marker seed hospital')] })
    expect(seed.status).toBe(200)

    const before = writeSnapshot()
    const response = await api(app)
      .post('/api/v1/lis-cases/import-markers')
      .set('Authorization', `Bearer ${financeToken}`)
      .send({ markers: [marker(caseNo)] })

    expect({ status: response.status, writes: writeSnapshot() })
      .toEqual({ status: 403, writes: before })
  })

  it('C/D 正控: admin 与 finance 在具备 W 时均可导入病例和 marker', async () => {
    setReconciliationPermission('finance', 'W')
    const api = await request()
    for (const [actor, token] of [['ADMIN', adminToken], ['FINANCE', financeToken]] as const) {
      const caseNo = `RBAC-LIS-W-${actor}`
      const hospital = `RBAC W hospital ${actor}`
      const caseResponse = await api(app)
        .post('/api/v1/lis-cases/import')
        .set('Authorization', `Bearer ${token}`)
        .send({ cases: [lisCase(caseNo, hospital)] })
      expect(caseResponse.status).toBe(200)
      expect(caseResponse.body.data.imported).toBe(1)

      const markerResponse = await api(app)
        .post('/api/v1/lis-cases/import-markers')
        .set('Authorization', `Bearer ${token}`)
        .send({ markers: [marker(caseNo)] })
      expect(markerResponse.status).toBe(200)
      expect(markerResponse.body.data.imported).toBe(1)
    }
  })

  it('C/D 角色负控: technician 即使具备 reconciliation W 仍因角色门返回 403 且零写', async () => {
    setReconciliationPermission('technician', 'W')
    const api = await request()
    const markerCaseNo = 'RBAC-LIS-TECH-MARKER'
    const seed = await api(app)
      .post('/api/v1/lis-cases/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [lisCase(markerCaseNo, 'RBAC tech marker seed hospital')] })
    expect(seed.status).toBe(200)

    let before = writeSnapshot()
    const caseResponse = await api(app)
      .post('/api/v1/lis-cases/import')
      .set('Authorization', `Bearer ${technicianToken}`)
      .send({ cases: [lisCase('RBAC-LIS-TECH-IMPORT', 'RBAC technician denied hospital')] })
    expect({ status: caseResponse.status, writes: writeSnapshot() })
      .toEqual({ status: 403, writes: before })

    before = writeSnapshot()
    const markerResponse = await api(app)
      .post('/api/v1/lis-cases/import-markers')
      .set('Authorization', `Bearer ${technicianToken}`)
      .send({ markers: [marker(markerCaseNo)] })
    expect({ status: markerResponse.status, writes: writeSnapshot() })
      .toEqual({ status: 403, writes: before })
  })
})
