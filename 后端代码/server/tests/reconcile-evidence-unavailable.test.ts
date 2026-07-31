/**
 * LOC-015 reconcile-compute 主线消费者：折扣率/对账金额与 LIS 计数证据 fail-closed。
 *
 * base 666ce6d 上 `partnerMonthDiscountRate` / `partnerMonthLabRate` /
 * `buildReconcileInputs` 用 `Number(x) || 0` 把 text/Infinity/NULL/blank 折成 0：
 *   折扣率会被算成 0/g 或 n/0，补收实收会被污染；对账计数会被静默少算。
 * 修复后：不可信事实 -> 抛出具名 `EvidenceUnavailableError`（code/status/issues），
 * 任何写路径在 BEGIN 之前 fail-closed，零落库。
 *
 * 说明（owner 边界）：account-reconcile-v1.1.ts 的错误映射 helper 由开放 PR #107
 * （Issue #106）持有，本测试不修改该路由；这里锁定 service 级具名错误与 API 级
 * fail-closed（非 2xx + 零写）。命名 422 透传需在 #107 串行合并后由该文件 owner 接入。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  EvidenceUnavailableError,
  type EvidenceIssue,
} from '../src/utils/evidence-fact.js'
import {
  buildReconcileInputs,
  partnerMonthDiscountRate,
  partnerMonthLabRate,
  runReconcile,
} from '../src/utils/reconcile-compute.js'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

let db: any
let app: any
let adminToken: string

const MONTH = '2099-01'
const PID = 'EV-RC-1'

function seedLine(id: string, caseNo: string, chargeItem: string, qty: unknown, unitPrice: unknown, gross: unknown, net: unknown, month = MONTH) {
  db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, gross_amount, net_amount, service_month)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, caseNo, PID, chargeItem, qty, unitPrice, gross, net, month)
}

function seedLis(id: string, caseNo: string, ihc: unknown, ss: unknown, month = MONTH) {
  db.prepare(`INSERT INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, specimen_type, operate_time)
    VALUES (?, ?, ?, ?, ?, 'tissue', ?)`).run(id, caseNo, PID, ihc, ss, `${month}-01`)
}

beforeAll(async () => {
  db = await getDb()
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, service_scope, status) VALUES (?, 'EV-RC01', '对账证据院', 'technical_only', 1)`).run(PID)

  // 折扣率 / 补收折实收矩阵（partnerMonthLabRate 只取免疫组化/特殊染色行）
  seedLine('EV-RL-OK', 'RC-OK', '免疫组化*2', 2, 50, 100, 80)
  seedLine('EV-RL-TEXT', 'RC-TEXT', '免疫组化*1', 1, 50, 'oops', 40, '2099-02')
  seedLine('EV-RL-INF', 'RC-INF', '特染*1', 1, 50, 60, Infinity, '2099-03')
  seedLine('EV-RL-BLANK', 'RC-BLANK', '免疫组化*1', 1, 50, '', 40, '2099-04')
  seedLine('EV-RL-NULL', 'RC-NULL', '免疫组化*1', 1, 50, 60, null, '2099-05')

  // partnerMonthDiscountRate 读取 case_revenue（全票扣率回退）
  db.prepare(`INSERT INTO case_revenue (id, case_no, partner_id, gross_amount, net_amount, discount_rate, revenue_source, service_month, line_count)
    VALUES ('EV-RC-CR-INF', 'RC-INF', ?, 60, ?, 1, 'statement', '2099-03', 1)`).run(PID, Infinity)

  // buildReconcileInputs 矩阵（独立 case 避免聚合互相污染）
  seedLine('EV-RI-OK', 'RI-OK', '免疫组化*2', 2, 50, 100, 80, '2099-06')
  seedLine('EV-RI-TEXTUNIT', 'RI-TEXTUNIT', '免疫组化*1', 1, 'x', 60, 50, '2099-07')
  seedLine('EV-RI-OK2', 'RI-OK2', '免疫组化*1', 1, 50, 60, 50, '2099-08')
  seedLine('EV-RI-OK3', 'RI-OK3', '免疫组化*1', 1, 50, 60, 50, '2099-09')
  seedLis('EV-RIL-OK', 'RI-OK', 2, 1, '2099-06')
  seedLis('EV-RIL-NULL', 'RI-OK2', 'x', 1, '2099-08')
  seedLis('EV-RIL-INF', 'RI-OK3', 1, Infinity, '2099-09')

  const authRoutes = (await import('../src/routes/auth.js')).default
  const reconcileRoutes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  app = await buildTestApp([
    { path: '/api/v1/auth', router: authRoutes },
    { path: '/api/v1/account-reconcile', router: reconcileRoutes },
  ])
  adminToken = await loginAdmin(app)
})

function expectUnavailable(fn: () => unknown, field: string, reason: string): void {
  try {
    fn()
    expect.unreachable(`expected EvidenceUnavailableError for ${field}`)
  } catch (err) {
    expect(err).toBeInstanceOf(EvidenceUnavailableError)
    const e = err as EvidenceUnavailableError
    expect(e.code).toBe('EVIDENCE_UNAVAILABLE')
    expect(e.status).toBe(422)
    expect(e.issues.some((i: EvidenceIssue) => i.field === field && i.reason === reason)).toBe(true)
  }
}

describe('partnerMonthLabRate / partnerMonthDiscountRate：金额证据 fail-closed', () => {
  it('合法金额照常出率：免疫组化行 80/100 -> 0.8', () => {
    expect(partnerMonthLabRate(db, PID, MONTH)).toBe(0.8)
  })

  it('gross_amount=text -> EvidenceUnavailableError(malformed)', () => {
    expectUnavailable(() => partnerMonthLabRate(db, PID, '2099-02'), 'gross_amount', 'malformed')
  })

  it('net_amount=Infinity -> EvidenceUnavailableError(non_finite)', () => {
    expectUnavailable(() => partnerMonthLabRate(db, PID, '2099-03'), 'net_amount', 'non_finite')
  })

  it('gross_amount=blank -> EvidenceUnavailableError(blank)', () => {
    expectUnavailable(() => partnerMonthLabRate(db, PID, '2099-04'), 'gross_amount', 'blank')
  })

  it('net_amount=NULL -> EvidenceUnavailableError(missing)', () => {
    expectUnavailable(() => partnerMonthLabRate(db, PID, '2099-05'), 'net_amount', 'missing')
  })

  it('partnerMonthDiscountRate：Infinity 实收 -> EvidenceUnavailableError(non_finite)，绝不按 0 出率', () => {
    expectUnavailable(() => partnerMonthDiscountRate(db, PID, '2099-03'), 'n', 'non_finite')
  })
})

describe('buildReconcileInputs：金额与 LIS 计数 fail-closed', () => {
  it('合法输入：bill 2 片/100 元，LIS ihc=2/ss=1', () => {
    const input = buildReconcileInputs(db, PID, '2099-06')
    expect(input.bills).toHaveLength(1)
    expect(input.bills[0].ihc).toBe(2)
    expect(input.lis[0].ihc).toBe(2)
    expect(input.lis[0].ss).toBe(1)
  })

  it('unit_price=text -> EvidenceUnavailableError(malformed)', () => {
    expectUnavailable(() => buildReconcileInputs(db, PID, '2099-07'), 'unit_price', 'malformed')
  })

  it('LIS ihc_count=text -> EvidenceUnavailableError(malformed)，不折 0 少算', () => {
    expectUnavailable(() => buildReconcileInputs(db, PID, '2099-08'), 'ihc_count', 'malformed')
  })

  it('LIS special_stain_count=Infinity -> EvidenceUnavailableError(non_finite)', () => {
    expectUnavailable(() => buildReconcileInputs(db, PID, '2099-09'), 'special_stain_count', 'non_finite')
  })
})

describe('runReconcile 与 supplements collect：API 级 fail-closed + 零写', () => {
  it('runReconcile：污染 unit_price -> 具名错误，reconcile_hospital_months/diffs 零落库', () => {
    expectUnavailable(() => runReconcile(db, PID, '2099-07', 'tester'), 'unit_price', 'malformed')
    const hm = (db.prepare('SELECT COUNT(*) AS n FROM reconcile_hospital_months WHERE partner_id = ? AND service_month = ?').get(PID, '2099-07') as any).n
    const diffs = (db.prepare('SELECT COUNT(*) AS n FROM reconcile_diffs WHERE partner_id = ? AND service_month = ?').get(PID, '2099-07') as any).n
    expect(hm).toBe(0)
    expect(diffs).toBe(0)
  })

  it('supplements collect：污染折扣率 -> 非 2xx + 补收单零变更（named-code 路由透传为 #107 边界）', async () => {
    db.prepare(`INSERT INTO supplement_orders (id, partner_id, service_month, amount, status, review_status)
      VALUES ('EV-SO-1', ?, '2099-02', 100, '待补收', 'approved')`).run(PID)
    const request = (await import('supertest')).default
    const res = await request(app)
      .post('/api/v1/account-reconcile/supplements/EV-SO-1/collect')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
    expect(res.status).toBeGreaterThanOrEqual(400)
    const row = db.prepare('SELECT status, collected_revenue, collected_month FROM supplement_orders WHERE id = ?').get('EV-SO-1') as any
    expect(row.status).toBe('待补收')
    expect(row.collected_revenue).toBeNull()
    expect(row.collected_month).toBeNull()
    // 路由错误映射 helper 属 #107 持有文件；当前响应不会把 0/成功金额写进补收单
  })
})
