/**
 * 逐抗体细粒度初判（③·返工/多病灶）—— 纯口径 TDD（设计基线 §1.4）。
 * 口径：同蜡块+同抗体≥2 片=疑似返工；同抗体跨多蜡块=多病灶（各收各钱）。
 *   **只对真抗体判**——剔除白片/重切/HE 等工序标签（0702免组 实测 806 行里 252 行是工序标签非抗体）。
 *   线索非定论·财务终判·不改差异计数/认定/补收 gate/golden。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import request from 'supertest'
import { isRealAntibodyMarker, classifyCaseHints, type MarkerRow } from '../src/utils/reconcile-account.js'
import { buildTestApp, getDb, loginAdmin } from './p0-harness.js'

describe('逐抗体初判 · 真抗体过滤（isRealAntibodyMarker）', () => {
  it('真抗体（adviceType Y000001/Y000003 或具名）→ true', () => {
    expect(isRealAntibodyMarker({ markerName: 'CK7', waxNo: 'A4', adviceType: 'Y000001' })).toBe(true)
    expect(isRealAntibodyMarker({ markerName: 'CD20', waxNo: 'A2', adviceType: 'Y000003' })).toBe(true)
    expect(isRealAntibodyMarker({ markerName: 'ALK', waxNo: 'A1' })).toBe(true) // 无 adviceType 但具名
  })
  it('工序标签（白片/重切/HE，adviceType Y000006/Y000007）→ false', () => {
    expect(isRealAntibodyMarker({ markerName: '免组白片', waxNo: 'A2', adviceType: 'Y000007' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: '重切', waxNo: 'A2', adviceType: 'Y000006' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: 'HE', waxNo: 'A2' })).toBe(false)
    expect(isRealAntibodyMarker({ markerName: '普通白片', waxNo: 'A2' })).toBe(false)
  })
  it('未文档化申请类型（Y000005）→ 保守非抗体（白名单口径，与详情页一致）', () => {
    expect(isRealAntibodyMarker({ markerName: '某标记', waxNo: 'A2', adviceType: 'Y000005' })).toBe(false)
  })
})

describe('逐抗体初判 · classifyCaseHints', () => {
  it('同蜡块+同抗体≥2 片 → 疑似返工（占位标签不参与）', () => {
    const markers: MarkerRow[] = [
      { markerName: 'CD20', waxNo: 'A2', adviceType: 'Y000001' },
      { markerName: 'CD20', waxNo: 'A2', adviceType: 'Y000001' }, // 同蜡块同抗体第 2 次
      { markerName: 'HE', waxNo: 'A2' }, // 工序标签，不算
    ]
    const hints = classifyCaseHints(markers)
    const rework = hints.find((h) => h.hintType === '疑似返工')
    expect(rework).toMatchObject({ markerName: 'CD20', waxNo: 'A2', occurrences: 2 })
    // 单蜡块，不构成多病灶
    expect(hints.find((h) => h.hintType === '多病灶')).toBeUndefined()
  })

  it('同抗体跨多蜡块 → 多病灶（各收各钱），非返工', () => {
    const markers: MarkerRow[] = [
      { markerName: 'CK7', waxNo: 'A2', adviceType: 'Y000001' },
      { markerName: 'CK7', waxNo: 'A4', adviceType: 'Y000001' }, // 不同蜡块
    ]
    const hints = classifyCaseHints(markers)
    const multi = hints.find((h) => h.hintType === '多病灶')
    expect(multi?.markerName).toBe('CK7')
    expect(multi?.occurrences).toBe(2) // 2 个蜡块
    expect(hints.find((h) => h.hintType === '疑似返工')).toBeUndefined()
  })

  it('无重复无跨块 → 无线索', () => {
    expect(classifyCaseHints([{ markerName: 'CK7', waxNo: 'A2', adviceType: 'Y000001' }])).toEqual([])
  })

  it('同蜡块同抗体但重复切片号（数据重复行）→ 不误报返工（按 distinct 切片号计）', () => {
    expect(
      classifyCaseHints([
        { markerName: 'CD20', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' },
        { markerName: 'CD20', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' }, // 同切片号重复行
      ]),
    ).toEqual([])
  })

  it('同蜡块同抗体不同切片号 → 返工 occurrences=distinct 切片数', () => {
    const h = classifyCaseHints([
      { markerName: 'CD20', waxNo: 'A2', sectionNo: 'A2-01', adviceType: 'Y000001' },
      { markerName: 'CD20', waxNo: 'A2', sectionNo: 'A2-02', adviceType: 'Y000001' },
    ]).find((x) => x.hintType === '疑似返工')
    expect(h?.occurrences).toBe(2)
  })

  it('工序标签重复不误报返工（白片做 3 次不是返工）', () => {
    const markers: MarkerRow[] = [
      { markerName: '免组白片', waxNo: 'A2', adviceType: 'Y000007' },
      { markerName: '免组白片', waxNo: 'A2', adviceType: 'Y000007' },
      { markerName: '免组白片', waxNo: 'A2', adviceType: 'Y000007' },
    ]
    expect(classifyCaseHints(markers)).toEqual([])
  })
})

describe('逐抗体初判 · 路由集成（compute → workbench 返回 caseHints）', () => {
  const P = 'PT-HINT-1'
  const M = '2026-10'
  let app: any
  let token = ''

  beforeAll(async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'HINT-1', '逐抗体初判测试院', 1)`).run(P)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('h-lc1', 'HC1', P, 3, 0, '2026-10-05')
    const mk = db.prepare(`INSERT INTO lis_case_markers (id, case_no, partner_id, marker_name, advice_type, wax_no, section_no) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    mk.run('h-m1', 'HC1', P, 'CD20', 'Y000001', 'A2', 'A2-01') // 同蜡块 CD20 第1片
    mk.run('h-m2', 'HC1', P, 'CD20', 'Y000001', 'A2', 'A2-02') // 同蜡块 CD20 第2片 → 返工
    mk.run('h-m3', 'HC1', P, 'CK7', 'Y000001', 'A2', 'A2-03') // CK7 蜡块 A2
    mk.run('h-m4', 'HC1', P, 'CK7', 'Y000001', 'A4', 'A4-01') // CK7 蜡块 A4 → 多病灶
    mk.run('h-m5', 'HC1', P, '免组白片', 'Y000007', 'A2', 'A2-99') // 工序标签，不参与
    db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('h-crl1', 'HC1', P, '免疫组化染色', 3, 100, M)

    const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
    const { authenticateToken } = await import('../src/middleware/auth.js')
    const { requirePermission } = await import('../src/middleware/permissions.js')
    app = await buildTestApp([
      { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
      { path: '/api/v1/account-reconcile', router: routes, middleware: [authenticateToken, requirePermission('account_reconcile', 'R')] },
    ])
    token = await loginAdmin(app)
  })
  const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)

  it('compute → workbench.caseHints 含 返工(CD20/A2/2) + 多病灶(CK7/2)，白片不误报', async () => {
    await auth(request(app).post('/api/v1/account-reconcile/compute').send({ partnerId: P, serviceMonth: M }))
    const wb = await auth(request(app).get(`/api/v1/account-reconcile/workbench?partnerId=${P}&serviceMonth=${M}`))
    expect(wb.status).toBe(200)
    const hints = wb.body.data.caseHints?.HC1 as any[]
    expect(Array.isArray(hints)).toBe(true)
    const rework = hints.find((h) => h.hintType === '疑似返工')
    expect(rework).toMatchObject({ markerName: 'CD20', waxNo: 'A2', occurrences: 2 })
    const multi = hints.find((h) => h.hintType === '多病灶')
    expect(multi).toMatchObject({ markerName: 'CK7', occurrences: 2 })
    // 白片不产生任何线索
    expect(hints.some((h) => h.markerName === '免组白片')).toBe(false)
  })
})
