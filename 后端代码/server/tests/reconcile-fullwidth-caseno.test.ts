/**
 * 回归：全角/兼容字符病理号「写入侧归一不对称」根治验证。
 *
 * 病灶（修前）：normalizeLisRow 落 lis_cases.case_no 用 String().trim()（无 NFKC），而消费侧
 *   case_revenue(_lines) 落库前经 canonicalCaseNo（NFKC+trim）。含全角号的 case → 账单侧半角、LIS 侧全角
 *   → buildReconcileInputs 两侧键永不相等 → 账实核对漏算（假阴性）。
 * 根治：入库侧统一走 canonicalCaseNo（见 lis-import.ts）。本用例证明修后两侧同键、matchRate=1（修前必为 0）。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'
import { buildReconcileInputs } from '../src/utils/reconcile-compute.js'
import { computeReconcile } from '../src/utils/reconcile-account.js'

let app: any
let db: any
let adminToken = ''

const MONTH = '2026-06'
const CANON = 'S26-02725' // 半角 canonical（账单侧 statement-import 落库形态）
const FULLWIDTH = 'Ｓ２６-０２７２５' // 全角输入（真实 LIS 导出偶含全角/兼容字符）

beforeAll(async () => {
  db = await getDb()
  const authRoutes = (await import('../src/routes/auth.js')).default
  const lisRoutes = (await import('../src/routes/lis-cases-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/lis-cases', router: lisRoutes },
  ])
  adminToken = await loginAdmin(app)
})

describe('全角病理号入库归一 → 账实核对命中（根治写入侧不对称）', () => {
  let partnerId = ''

  it('LIS 导入全角号 → lis_cases.case_no 落库为半角 canonical（不再留全角原样）', async () => {
    const request = (await import('supertest')).default
    const res = await request(app)
      .post('/api/v1/lis-cases/import')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: FULLWIDTH, 送检医院: '全角归一测试医院', 免疫组化数: 3, 登记时间: '2026-06-15' }] })
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)

    // 半角查得到 = 已归一；全角原样查不到 = 不再留双形态（否则重传/匹配双计）
    const row = db.prepare('SELECT case_no, partner_id FROM lis_cases WHERE case_no = ?').get(CANON) as any
    expect(row).toBeTruthy()
    expect(row.case_no).toBe(CANON)
    expect(db.prepare('SELECT 1 FROM lis_cases WHERE case_no = ?').get(FULLWIDTH)).toBeUndefined()
    partnerId = row.partner_id
  })

  it('账单侧半角 + LIS 侧原始全角 → 归一后同键、matchRate=1（修前两侧异形键必为 0）', () => {
    // 模拟 statement-import：case_revenue_lines 落库前已 canonicalCaseNo（半角）
    db.prepare(
      `INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, gross_amount, service_month)
       VALUES (?, ?, ?, '免疫组化', 3, 100, 300, ?)`,
    ).run('CRL-fw-1', CANON, partnerId, MONTH)

    const inputs = buildReconcileInputs(db, partnerId, MONTH)
    // 账单侧、LIS 侧都以同一半角键出现 → 才可能被 computeReconcile 配对
    expect(inputs.bills.map((b) => b.caseNo)).toContain(CANON)
    expect(inputs.lis.map((l) => l.caseNo)).toContain(CANON)

    const result = computeReconcile(inputs.bills, inputs.lis)
    expect(result.matchRate).toBe(1) // 账单 3 片 ↔ LIS 3 片同 case，完全命中（修前 union=2/matched=0 → 0）
  })
})
