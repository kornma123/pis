/**
 * Phase 1 账实核对 —— 路由 + 状态机集成（设计基线 §1.4/§1.5/§4）。
 * 端到端：compute → 认定(6原因·补收gate) → 复核完成(前置=全认定) → 关账(定版) + 反向必填理由。
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import request from 'supertest'
import type { RequestHandler } from 'express'
import { buildTestApp, getDb, loginAdmin, loginAs, seedReviewer } from './p0-harness.js'

const PARTNER = 'PT-RECON-1'
const MONTH = '2026-06'
const STATEMENT_GENERATION = 'stmt-recon-routes-v1'
const RECONCILE_GENERATION = 'recon-routes-v1'
let app: any
let token = ''
const finishedActorSnapshots: Array<{
  method: string
  url: string
  before: string | null
  after: string | null
}> = []

function seedStatementGeneration(
  db: any,
  partnerId: string,
  settlementMonth: string,
  generationId: string,
  rows: Array<{ caseNo: string; item: string; amount: number }>,
) {
  const batchId = `batch-${generationId}`
  db.prepare(
    `INSERT INTO statement_import_batches
      (id, partner_id, source_hash, template_family, parser_revision, config_revision,
       settlement_month, generation_id, is_current, raw_row_count, normalized_line_count, status)
     VALUES (?, ?, ?, 'reconcile-test', 'r1', 'c1', ?, ?, 1, ?, ?, 'posted')`,
  ).run(batchId, partnerId, `hash-${generationId}`, settlementMonth, generationId, rows.length, rows.length)
  const raw = db.prepare(
    `INSERT INTO statement_raw_rows
      (id, batch_id, generation_id, source_sheet, source_row, row_json)
     VALUES (?, ?, ?, 'sheet', ?, ?)`,
  )
  const normalized = db.prepare(
    `INSERT INTO statement_normalized_lines
      (id, batch_id, generation_id, partner_id, settlement_month, ledger_settlement_month,
       case_no, item_name, source_sheet, source_row, source_column, source_label,
       template_family, row_kind, line_grain, business_line, amount_role, amount,
       classification_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sheet', ?, 'amount', ?, 'reconcile-test',
             'detail', 'case', 'IN', 'gross', ?, 'classified')`,
  )
  rows.forEach((row, index) => {
    const sourceRow = index + 1
    raw.run(`raw-${generationId}-${sourceRow}`, batchId, generationId, sourceRow, JSON.stringify(row))
    normalized.run(
      `line-${generationId}-${sourceRow}`,
      batchId,
      generationId,
      partnerId,
      settlementMonth,
      settlementMonth,
      row.caseNo,
      row.item,
      sourceRow,
      row.item,
      row.amount,
    )
  })
}

const exactBinding = (overrides: Record<string, unknown> = {}) => ({
  partnerId: PARTNER,
  settlementMonth: MONTH,
  statementGenerationId: STATEMENT_GENERATION,
  reconcileGenerationId: RECONCILE_GENERATION,
  ...overrides,
})

async function mountApp() {
  const routes = (await import('../src/routes/account-reconcile-v1.1.js')).default
  const { authenticateToken } = await import('../src/middleware/auth.js')
  const { requirePermission } = await import('../src/middleware/permissions.js')
  const { auditWrite } = await import('../src/middleware/audit-log.js')
  type ActorRequest = Parameters<RequestHandler>[0] & {
    user?: { userId?: string }
  }
  const captureActorUntilFinish: RequestHandler = (req, res, next) => {
    const actorRequest = req as ActorRequest
    const before = actorRequest.user?.userId ?? null
    res.on('finish', () => {
      finishedActorSnapshots.push({
        method: req.method,
        url: req.originalUrl,
        before,
        after: actorRequest.user?.userId ?? null,
      })
    })
    next()
  }
  return buildTestApp([
    { path: '/api/v1/auth', router: (await import('../src/routes/auth.js')).default },
    {
      path: '/api/v1/account-reconcile',
      router: routes,
      middleware: [
        auditWrite,
        authenticateToken,
        captureActorUntilFinish,
        requirePermission('account_reconcile', 'R'),
      ],
    },
  ])
}

function seed(db: any) {
  seedStatementGeneration(db, PARTNER, MONTH, STATEMENT_GENERATION, [
    { caseNo: 'CA', item: '免疫组化染色*5', amount: 500 },
    { caseNo: 'CB', item: '免疫组化染色*3', amount: 300 },
    { caseNo: 'CC', item: '免疫组化染色*6', amount: 600 },
    { caseNo: 'CC', item: '特殊染色*2', amount: 60 },
  ])
  db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-1', '测试医院', 1)`).run(PARTNER)
  const bill = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
  // A: 免疫组化 5，与 LIS 5 相等 → 无差异
  bill.run('l-a1', 'CA', PARTNER, '免疫组化染色', 5, 100, MONTH)
  // B: 免疫组化 3，LIS 5 → 实际>账单 → 漏收 -2
  bill.run('l-b1', 'CB', PARTNER, '免疫组化染色', 3, 100, MONTH)
  // C: 免疫组化 6，LIS 4 → 账单>实际 → 计费用错 +2；特染 2，LIS 1 → +1
  bill.run('l-c1', 'CC', PARTNER, '免疫组化染色', 6, 100, MONTH)
  bill.run('l-c2', 'CC', PARTNER, '特殊染色', 2, 30, MONTH)
  const lis = db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
  lis.run('lc-a', 'CA', PARTNER, 5, 0, '2026-06-10')
  lis.run('lc-b', 'CB', PARTNER, 5, 0, '2026-06-11')
  lis.run('lc-c', 'CC', PARTNER, 4, 1, '2026-06-12')
  // 收入侧：已确认实收锚
  db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
    .run('cr-1', 'CA', PARTNER, MONTH, 1000, 830, 830)
}

let reviewerToken = ''
beforeAll(async () => {
  const db = await getDb()
  seed(db)
  await seedReviewer(db)
  app = await mountApp()
  token = await loginAdmin(app)
  reviewerToken = await loginAs(app, 'reviewer2', 'CoreOne2026!')
})

const auth = (r: any) => r.set('Authorization', `Bearer ${token}`)

describe('账实核对路由 · compute + 总览 + 工作台', () => {
  it('generation 合同 RED：缺 statement/reconcile generation 必须 fail closed', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/compute').send({
      partnerId: PARTNER,
      settlementMonth: MONTH,
    }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })

  it.each(['2026-00', '2026-13', '2026-1', ' 2026-06 ', '2026-06x'])(
    'strict month 合同 RED：%s 必须稳定拒绝',
    async (settlementMonth) => {
      const res = await auth(request(app).post('/api/v1/account-reconcile/compute').send({
        partnerId: PARTNER,
        settlementMonth,
        statementGenerationId: 'stmt-red',
        reconcileGenerationId: 'recon-red',
      }))
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('INVALID_SETTLEMENT_MONTH')
    },
  )

  it('close is one independent month-level fact per request', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/close').send({
      items: [exactBinding(), exactBinding({ reconcileGenerationId: 'another-generation' })],
    }))
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('GENERATION_BINDING_REQUIRED')
  })

  it('POST /compute → 全对齐(正常) 出 3 条差异（B漏收/C计费用错/C特染）', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/compute').send(exactBinding()))
    expect(res.status).toBe(200)
    expect(res.body.data.result.matchStatus).toBe('正常')
    expect(res.body.data.result.diffs).toHaveLength(3)
  })

  it('GET /overview → 看板计入该院（待复核 1）', async () => {
    const res = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: MONTH }))
    expect(res.status).toBe(200)
    const items = res.body.data.items as any[]
    const item = items.find((i) => i.partnerId === PARTNER)
    expect(item).toBeTruthy()
    expect(item.reconcileGenerationId).toBe(exactBinding().reconcileGenerationId)
    expect(item.status).toBe('待复核')
    expect(res.body.data.board.待复核).toBeGreaterThanOrEqual(1)
  })

  it('GET /workbench → 3 条差异 + 系统初判正确', async () => {
    const res = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding()))
    expect(res.status).toBe(200)
    const diffs = res.body.data.diffs as any[]
    expect(diffs.length).toBe(3)
    const bIhc = diffs.find((d) => d.caseNo === 'CB' && d.lineType === '免疫组化')
    expect(bIhc.delta).toBe(-2)
    expect(bIhc.systemHint).toBe('疑似漏收，需补收')
    const cIhc = diffs.find((d) => d.caseNo === 'CC' && d.lineType === '免疫组化')
    expect(cIhc.systemHint).toBe('疑似计费项目用错')
    expect(res.body.data.snapshot.result.unmatched.length).toBe(0)
  })
})

describe('账实核对路由 · 认定 + 补收 gate + 复核完成前置 + 关账', () => {
  let diffs: any[] = []
  it('复核完成前置：有待认定 → 400 拒绝', async () => {
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding()))
    diffs = wb.body.data.diffs
    const hmId = wb.body.data.snapshot.hospitalMonthId
    const res = await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${hmId}/complete`).send(exactBinding()))
    expect(res.status).toBe(409)
  })

  it('production auditWrite rejects unknown verdict keys without leaking raw body sentinels', async () => {
    const target = diffs.find((diff) => diff.caseNo === 'CB')
    const database = await getDb()
    const businessBefore = Number(database.prepare(
      'SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?',
    ).get(target.id).n)
    const abcBefore = Number(database.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(target.id).n)

    const response = await auth(
      request(app).post(`/api/v1/account-reconcile/diffs/${target.id}/verdict`).send({
        ...exactBinding(),
        reason: '漏收，需补收',
        suppressSuccessAuditForRequest: true,
        patientName: 'LOC005_PATIENT_SENTINEL',
        rawReceipt: 'LOC005_RECEIPT_SENTINEL',
        nested: { diagnosis: 'LOC005_DIAGNOSIS_SENTINEL' },
      }),
    )
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('BAD_REQUEST')
    expect(Number(database.prepare(
      'SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?',
    ).get(target.id).n)).toBe(businessBefore)
    expect(Number(database.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(target.id).n)).toBe(abcBefore)

    const denied = database.prepare(`
      SELECT request_data FROM operation_logs
      WHERE operation = 'DENIED POST account-reconcile'
      ORDER BY rowid DESC LIMIT 1
    `).get() as { request_data: string }
    expect(denied.request_data).not.toContain('LOC005_PATIENT_SENTINEL')
    expect(denied.request_data).not.toContain('LOC005_RECEIPT_SENTINEL')
    expect(denied.request_data).not.toContain('LOC005_DIAGNOSIS_SENTINEL')
  })

  it('认定「漏收，需补收」→ 生成补收单；其它原因不驱动补收', async () => {
    const bIhc = diffs.find((d) => d.caseNo === 'CB')
    const cIhc = diffs.find((d) => d.caseNo === 'CC' && d.lineType === '免疫组化')
    const cSs = diffs.find((d) => d.caseNo === 'CC' && d.lineType === '特染')
    const unbound = await auth(
      request(app).post(`/api/v1/account-reconcile/diffs/${bIhc.id}/verdict`)
        .send({ reason: '漏收，需补收' }),
    )
    expect(unbound.status).toBe(400)
    expect(unbound.body.error.code).toBe('GENERATION_BINDING_REQUIRED')

    const operationBefore = Number((await getDb()).prepare(`
      SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
    `).get().n)
    let r = await auth(
      request(app)
        .post(`/api/v1/account-reconcile/diffs/${bIhc.id}/verdict`)
        .query({ suppressSuccessAuditForRequest: 'true' })
        .set('x-suppress-success-audit', 'true')
        .send({
          ...exactBinding(),
          reason: '漏收，需补收',
          note: 'LOC005_ALLOWED_NOTE_DIAGNOSIS_SENTINEL',
        }),
    )
    expect(r.status).toBe(200)
    expect(r.body.data.followUp).toBe('supplement')
    expect(r.body.data.duplicate).toBe(false)
    const operationAfterWrite = Number((await getDb()).prepare(`
      SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
    `).get().n)
    expect(operationAfterWrite).toBe(operationBefore + 1)
    const operation = (await getDb()).prepare(`
      SELECT request_data FROM operation_logs
      WHERE operation = 'POST account-reconcile'
      ORDER BY rowid DESC LIMIT 1
    `).get() as { request_data: string }
    expect(operation.request_data).not.toContain('LOC005_ALLOWED_NOTE_DIAGNOSIS_SENTINEL')
    expect(JSON.parse(operation.request_data)).toEqual({
      action: 'verdict',
      partnerId: PARTNER,
      settlementMonth: MONTH,
      statementGenerationId: STATEMENT_GENERATION,
      reconcileGenerationId: RECONCILE_GENERATION,
      diffId: bIhc.id,
      duplicate: false,
    })

    const auditBeforeReplay = Number((await getDb()).prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(bIhc.id).n)
    const [replay, unrelated] = await Promise.all([
      auth(request(app).post(`/api/v1/account-reconcile/diffs/${bIhc.id}/verdict`).send({
        ...exactBinding(),
        reason: '漏收，需补收',
        note: 'LOC005_ALLOWED_NOTE_DIAGNOSIS_SENTINEL',
      })),
      auth(request(app).post(`/api/v1/account-reconcile/diffs/${cIhc.id}/verdict`).send({
        ...exactBinding(),
        reason: '计费项目用错',
      })),
    ])
    expect(replay.status).toBe(200)
    expect(replay.body.data.duplicate).toBe(true)
    expect(unrelated.status).toBe(200)
    expect(unrelated.body.data.duplicate).toBe(false)
    expect(Number((await getDb()).prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(bIhc.id).n)).toBe(auditBeforeReplay)
    expect(Number((await getDb()).prepare(`
      SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
    `).get().n)).toBe(operationAfterWrite + 1)
    const replayActor = finishedActorSnapshots
      .filter(snapshot => snapshot.url.includes(`/diffs/${bIhc.id}/verdict`))
      .at(-1)
    expect(replayActor).toMatchObject({
      method: 'POST',
      before: 'USER-001',
      after: 'USER-001',
    })

    expect(unrelated.body.data.followUp).toBe('external_fix')
    r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${cSs.id}/verdict`).send({
      ...exactBinding(),
      reason: '核对无误',
    }))
    expect(r.body.data.pendingCount).toBe(0)

    const sup = await auth(request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${MONTH}`))
    expect(sup.body.data.list.length).toBe(1)
    expect(sup.body.data.list[0].caseNo).toBe('CB')
    expect(sup.body.data.list[0].status).toBe('待补收')
    expect(sup.body.data.list[0].amount).toBe(200) // |−2|×100
  })

  it('exact verdict replay remains a zero-write duplicate after supplement approve, collect, reopen, and give-up', async () => {
    const target = diffs.find((diff) => diff.caseNo === 'CB')
    const database = await getDb()
    const supplement = database.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(target.id) as { id: string }
    const replayBody = {
      ...exactBinding(),
      reason: '漏收，需补收',
      note: 'LOC005_ALLOWED_NOTE_DIAGNOSIS_SENTINEL',
    }
    const assertReplayIsZeroWrite = async () => {
      const before = {
        supplement: database.prepare(
          'SELECT * FROM supplement_orders WHERE id = ?',
        ).get(supplement.id),
        supplementCount: Number(database.prepare(
          'SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?',
        ).get(target.id).n),
        abc: Number(database.prepare(`
          SELECT COUNT(*) AS n FROM abc_audit_logs
          WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
        `).get(target.id).n),
        operation: Number(database.prepare(`
          SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
        `).get().n),
      }
      const replay = await auth(
        request(app).post(`/api/v1/account-reconcile/diffs/${target.id}/verdict`).send(replayBody),
      )
      expect(replay.status).toBe(200)
      expect(replay.body.data.duplicate).toBe(true)
      expect(database.prepare(
        'SELECT * FROM supplement_orders WHERE id = ?',
      ).get(supplement.id)).toEqual(before.supplement)
      expect(Number(database.prepare(
        'SELECT COUNT(*) AS n FROM supplement_orders WHERE source_diff_id = ?',
      ).get(target.id).n)).toBe(before.supplementCount)
      expect(Number(database.prepare(`
        SELECT COUNT(*) AS n FROM abc_audit_logs
        WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
      `).get(target.id).n)).toBe(before.abc)
      expect(Number(database.prepare(`
        SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
      `).get().n)).toBe(before.operation)
      expect(finishedActorSnapshots
        .filter(snapshot => snapshot.url.includes(`/diffs/${target.id}/verdict`))
        .at(-1)).toMatchObject({
        before: 'USER-001',
        after: 'USER-001',
      })
    }

    const approved = await request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplement.id}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({})
    expect(approved.status).toBe(200)
    await assertReplayIsZeroWrite()

    const collected = await auth(
      request(app)
        .post(`/api/v1/account-reconcile/supplements/${supplement.id}/collect`)
        .send({ collectedMonth: '2026-07' }),
    )
    expect(collected.status).toBe(200)
    await assertReplayIsZeroWrite()

    const reopened = await auth(
      request(app)
        .post(`/api/v1/account-reconcile/supplements/${supplement.id}/reopen`)
        .send({ reason: 'replay workflow mutation' }),
    )
    expect(reopened.status).toBe(200)
    const givenUp = await auth(
      request(app)
        .post(`/api/v1/account-reconcile/supplements/${supplement.id}/giveup`)
        .send({ reason: 'replay terminal workflow' }),
    )
    expect(givenUp.status).toBe(200)
    await assertReplayIsZeroWrite()
  })

  it('全认定后 复核完成 → confirmed_lab_revenue=830', async () => {
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding()))
    const hmId = wb.body.data.snapshot.hospitalMonthId
    const res = await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${hmId}/complete`).send(exactBinding()))
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('complete')
    expect(res.body.data.confirmedLabRevenue).toBe(830)
    const target = diffs.find((diff) => diff.caseNo === 'CB')
    const database = await getDb()
    const before = {
      supplement: database.prepare(
        'SELECT * FROM supplement_orders WHERE source_diff_id = ?',
      ).get(target.id),
      abc: Number(database.prepare(`
        SELECT COUNT(*) AS n FROM abc_audit_logs
        WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
      `).get(target.id).n),
      operation: Number(database.prepare(`
        SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
      `).get().n),
    }
    const replay = await auth(
      request(app).post(`/api/v1/account-reconcile/diffs/${target.id}/verdict`).send({
        ...exactBinding(),
        reason: '漏收，需补收',
        note: 'LOC005_ALLOWED_NOTE_DIAGNOSIS_SENTINEL',
      }),
    )
    expect(replay.status).toBe(200)
    expect(replay.body.data.duplicate).toBe(true)
    expect(database.prepare(
      'SELECT * FROM supplement_orders WHERE source_diff_id = ?',
    ).get(target.id)).toEqual(before.supplement)
    expect(Number(database.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(target.id).n)).toBe(before.abc)
    expect(Number(database.prepare(`
      SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
    `).get().n)).toBe(before.operation)
  })

  it('complete freezes verdict and supplement decision facts', async () => {
    const target = diffs.find((diff) => diff.caseNo === 'CB')
    const before = (await auth(
      request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding()),
    )).body.data
    const response = await auth(
      request(app)
        .post(`/api/v1/account-reconcile/diffs/${target.id}/verdict`)
        .send({
          ...exactBinding(),
          reason: '超期，免费做的',
          note: 'must not persist after complete',
        }),
    )

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('RECONCILIATION_FINAL')
    const after = (await auth(
      request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding()),
    )).body.data
    expect(after.diffs).toEqual(before.diffs)
    expect((await auth(
      request(app).get(`/api/v1/account-reconcile/supplements?serviceMonth=${MONTH}`),
    )).body.data.list).toHaveLength(1)
  })

  it('反向重新打开 → 必填理由（缺理由 400）', async () => {
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(exactBinding()))
    const hmId = wb.body.data.snapshot.hospitalMonthId
    const noReason = await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${hmId}/reopen`).send({}))
    expect(noReason.status).toBe(409)
    expect(noReason.body.error.code).toBe('RECONCILIATION_REOPEN_FORBIDDEN')
  })

  it('关账（复核完成→已关账 定版）；关账后认定被拒', async () => {
    const res = await auth(request(app).post('/api/v1/account-reconcile/close').send({ items: [exactBinding()] }))
    expect(res.status).toBe(200)
    expect(res.body.data.closed[0].partnerId).toBe(PARTNER)
    // 关账后 compute 被拒（定版不可改）
    const recompute = await auth(request(app).post('/api/v1/account-reconcile/compute').send(exactBinding()))
    expect(recompute.status).toBe(409)
    const target = diffs.find((diff) => diff.caseNo === 'CB')
    const database = await getDb()
    const before = {
      supplement: database.prepare(
        'SELECT * FROM supplement_orders WHERE source_diff_id = ?',
      ).get(target.id),
      abc: Number(database.prepare(`
        SELECT COUNT(*) AS n FROM abc_audit_logs
        WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
      `).get(target.id).n),
      operation: Number(database.prepare(`
        SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
      `).get().n),
    }
    const replay = await auth(
      request(app).post(`/api/v1/account-reconcile/diffs/${target.id}/verdict`).send({
        ...exactBinding(),
        reason: '漏收，需补收',
        note: 'LOC005_ALLOWED_NOTE_DIAGNOSIS_SENTINEL',
      }),
    )
    expect(replay.status).toBe(200)
    expect(replay.body.data.duplicate).toBe(true)
    expect(database.prepare(
      'SELECT * FROM supplement_orders WHERE source_diff_id = ?',
    ).get(target.id)).toEqual(before.supplement)
    expect(Number(database.prepare(`
      SELECT COUNT(*) AS n FROM abc_audit_logs
      WHERE module = 'account_reconcile' AND action = 'verdict' AND target_id = ?
    `).get(target.id).n)).toBe(before.abc)
    expect(Number(database.prepare(`
      SELECT COUNT(*) AS n FROM operation_logs WHERE operation = 'POST account-reconcile'
    `).get().n)).toBe(before.operation)
  })
})

describe('账实核对路由 · 账单片数 floor（回归：statement 无 qty 也不误报 billCount=0）', () => {
  const P2 = 'PT-RECON-2'
  const M2 = '2026-05'
  const S2 = 'stmt-recon-routes-v2'
  const R2 = 'recon-routes-v2'
  it('免疫组化两行无 qty（statement 落库风格，只有 gross）→ billCount=2 行数 floor、非 0', async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-2', '测试医院2', 1)`).run(P2)
    seedStatementGeneration(db, P2, M2, S2, [
      { caseNo: 'SC', item: '免疫组化染色', amount: 120 },
      { caseNo: 'SC', item: '免疫组化染色', amount: 120 },
    ])
    // 模拟 statement-import /commit：case_revenue_lines 只写 gross_amount，qty/unit_price 缺省 0
    const ins = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, gross_amount, service_month) VALUES (?, ?, ?, ?, ?, ?)`)
    ins.run('l2-1', 'SC', P2, '免疫组化染色', 120, M2)
    ins.run('l2-2', 'SC', P2, '免疫组化染色', 120, M2)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`).run('lc2', 'SC', P2, 3, 0, '2026-05-15')
    const binding = {
      partnerId: P2,
      settlementMonth: M2,
      statementGenerationId: S2,
      reconcileGenerationId: R2,
    }
    const comp = await auth(request(app).post('/api/v1/account-reconcile/compute').send(binding))
    expect(comp.status).toBe(200)
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(binding))
    const d = wb.body.data.diffs.find((x: any) => x.caseNo === 'SC' && x.lineType === '免疫组化')
    expect(d.billCount).toBe(2) // 行数 floor，若退回旧 bug 则为 0
    expect(d.lisCount).toBe(3)
    expect(d.delta).toBe(-1)
    expect(d.amountImpact).toBeCloseTo(120, 2) // |−1| × (240/2)
  })
})

describe('账实核对路由 · LOC-005 R2 respin（补收单生命周期 + 治理性重出 + board 发现端点）', () => {
  const FB_PARTNER = 'PT-RECON-FB'
  const FB_MONTH = '2026-09'
  const FB_STMT = 'stmt-recon-fb-v1'
  const FB_RECON = 'recon-fb-v1'
  const FC_PARTNER = 'PT-RECON-FC'
  const FC_STMT = 'stmt-recon-fc-v1'
  const FC_RECON = 'recon-fc-v1'
  const BOARD_ONLY_PARTNER = 'PT-RECON-BOARDONLY'
  const BOARD_ONLY_STMT = 'stmt-recon-boardonly-v1'

  const fbBinding = (overrides: Record<string, unknown> = {}) => ({
    partnerId: FB_PARTNER,
    settlementMonth: FB_MONTH,
    statementGenerationId: FB_STMT,
    reconcileGenerationId: FB_RECON,
    ...overrides,
  })
  const fcBinding = (reconcileGenerationId: string) => ({
    partnerId: FC_PARTNER,
    settlementMonth: FB_MONTH,
    statementGenerationId: FC_STMT,
    reconcileGenerationId,
  })

  beforeAll(async () => {
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-FB', '补收生命周期医院', 1)`).run(FB_PARTNER)
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-FC', '治理重出医院', 1)`).run(FC_PARTNER)
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-BO', '仅账单医院', 1)`).run(BOARD_ONLY_PARTNER)
    for (const [partner, stmt, tag] of [[FB_PARTNER, FB_STMT, 'fb'], [FC_PARTNER, FC_STMT, 'fc']] as const) {
      seedStatementGeneration(db, partner, FB_MONTH, stmt, [
        { caseNo: `D1-${tag}`, item: '免疫组化染色*3', amount: 300 },
        { caseNo: `D2-${tag}`, item: '免疫组化染色*3', amount: 300 },
      ])
      const bill = db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      bill.run(`l-${tag}-d1`, `D1-${tag}`, partner, '免疫组化染色', 3, 100, FB_MONTH)
      bill.run(`l-${tag}-d2`, `D2-${tag}`, partner, '免疫组化染色', 3, 100, FB_MONTH)
      const lis = db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      lis.run(`lc-${tag}-d1`, `D1-${tag}`, partner, 5, 0, `${FB_MONTH}-10`)
      lis.run(`lc-${tag}-d2`, `D2-${tag}`, partner, 5, 0, `${FB_MONTH}-11`)
      db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
        .run(`cr-${tag}-1`, `D1-${tag}`, partner, FB_MONTH, 1000, 830, 830)
    }
    seedStatementGeneration(db, BOARD_ONLY_PARTNER, FB_MONTH, BOARD_ONLY_STMT, [
      { caseNo: 'D1-bo', item: '免疫组化染色*1', amount: 100 },
    ])
  })

  it('complete/close 后补收单签发·收款·放弃·退回继续可用（含跨月收款）', async () => {
    const computed = await auth(request(app).post('/api/v1/account-reconcile/compute').send(fbBinding()))
    expect(computed.status).toBe(200)
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(fbBinding()))
    const fbDiffs = wb.body.data.diffs as Array<{ id: string; caseNo: string }>
    expect(fbDiffs.length).toBe(2)
    for (const diff of fbDiffs) {
      const r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`).send({
        ...fbBinding(),
        reason: '漏收，需补收',
      }))
      expect(r.status).toBe(200)
    }
    const db = await getDb()
    const supplements = db.prepare(`
      SELECT s.id, s.case_no FROM supplement_orders s
       JOIN reconcile_diffs d ON d.id = s.source_diff_id
      WHERE s.reconcile_generation_id = ? ORDER BY s.case_no
    `).all(FB_RECON) as Array<{ id: string; case_no: string }>
    expect(supplements.length).toBe(2)

    const hmId = wb.body.data.snapshot.hospitalMonthId
    const completed = await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${hmId}/complete`).send(fbBinding()))
    expect(completed.status).toBe(200)

    const approved = await request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[0].id}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({})
    expect(approved.status).toBe(200)
    const collected = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[0].id}/collect`)
      .send({ collectedMonth: '2026-10' }))
    expect(collected.status).toBe(200)
    const givenUp = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[1].id}/giveup`)
      .send({ reason: '医院确认不付' }))
    expect(givenUp.status).toBe(200)
    const reopened = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[1].id}/reopen`)
      .send({ reason: '医院改口同意补' }))
    expect(reopened.status).toBe(200)

    const closed = await auth(request(app).post('/api/v1/account-reconcile/close').send({ items: [fbBinding()] }))
    expect(closed.status).toBe(200)

    const approvedAfterClose = await request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[1].id}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({})
    expect(approvedAfterClose.status).toBe(200)
    const collectedAfterClose = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[1].id}/collect`)
      .send({ collectedMonth: '2026-11' }))
    expect(collectedAfterClose.status).toBe(200)
  })

  it('带待补收补收单的月份重出返回 409 明确错误码，终结后重出成功且旧单冻结留痕', async () => {
    const computed = await auth(request(app).post('/api/v1/account-reconcile/compute').send(fcBinding(FC_RECON)))
    expect(computed.status).toBe(200)
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(fcBinding(FC_RECON)))
    const fcDiffs = wb.body.data.diffs as Array<{ id: string; caseNo: string }>
    for (const diff of fcDiffs) {
      const r = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`).send({
        ...fcBinding(FC_RECON),
        reason: '漏收，需补收',
      }))
      expect(r.status).toBe(200)
    }
    const db = await getDb()
    const openSupplements = db.prepare(
      `SELECT id FROM supplement_orders WHERE reconcile_generation_id = ? AND status = '待补收'`,
    ).all(FC_RECON) as Array<{ id: string }>
    expect(openSupplements.length).toBe(2)

    const refused = await auth(request(app).post('/api/v1/account-reconcile/compute').send(fcBinding(`${FC_RECON}-NEXT`)))
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('RECONCILE_GENERATION_HAS_OPEN_SUPPLEMENTS')

    for (const supplement of openSupplements) {
      const givenUp = await auth(request(app)
        .post(`/api/v1/account-reconcile/supplements/${supplement.id}/giveup`)
        .send({ reason: '重出前确认不追' }))
      expect(givenUp.status).toBe(200)
    }

    const regenerated = await auth(request(app).post('/api/v1/account-reconcile/compute').send(fcBinding(`${FC_RECON}-NEXT`)))
    expect(regenerated.status).toBe(200)
    const wbNext = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(fcBinding(`${FC_RECON}-NEXT`)))
    const nextDiffIds = (wbNext.body.data.diffs as Array<{ id: string }>).map(diff => diff.id).sort()
    expect(nextDiffIds.length).toBe(2)
    expect(nextDiffIds).not.toContain(fcDiffs[0].id)
    expect(nextDiffIds).not.toContain(fcDiffs[1].id)

    const staleVerdict = await auth(request(app)
      .post(`/api/v1/account-reconcile/diffs/${fcDiffs[0].id}/verdict`)
      .send({ ...fcBinding(`${FC_RECON}-NEXT`), reason: '核对无误' }))
    expect(staleVerdict.status).toBe(409)
    expect(staleVerdict.body.error.code).toBe('STALE_RECONCILIATION_DIFF')

    const frozenSupplement = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${openSupplements[0].id}/reopen`)
      .send({ reason: '旧代应冻结' }))
    // R3-3：旧代彻底冻结的口径不变，但错误面必须是有稳定码的 409，不是被掩码的裸 500。
    expect(frozenSupplement.status).toBe(409)
    expect(frozenSupplement.body.error.code).toBe('SUPPLEMENT_GENERATION_BINDING_MISMATCH')
    expect(db.prepare(
      `SELECT status FROM supplement_orders WHERE id = ?`,
    ).get(openSupplements[0].id)).toMatchObject({ status: '已放弃' })
  })

  it('GET /overview 返回月份级各院代次绑定与看板汇总，非法月份 400', async () => {
    const invalid = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: '2026-13' }))
    expect(invalid.status).toBe(400)
    expect(invalid.body.error.code).toBe('INVALID_SETTLEMENT_MONTH')

    const res = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: FB_MONTH }))
    expect(res.status).toBe(200)
    const items = res.body.data.items as Array<Record<string, unknown>>
    const fb = items.find(item => item.partnerId === FB_PARTNER)
    expect(fb).toMatchObject({
      partnerId: FB_PARTNER,
      statementGenerationId: FB_STMT,
      reconcileGenerationId: FB_RECON,
      generationStatus: 'closed',
      status: '已关账',
    })
    const fc = items.find(item => item.partnerId === FC_PARTNER)
    expect(fc).toMatchObject({
      partnerId: FC_PARTNER,
      statementGenerationId: FC_STMT,
      reconcileGenerationId: `${FC_RECON}-NEXT`,
      generationStatus: 'pending',
      status: '待复核',
    })
    const boardOnly = items.find(item => item.partnerId === BOARD_ONLY_PARTNER)
    expect(boardOnly).toMatchObject({
      partnerId: BOARD_ONLY_PARTNER,
      statementGenerationId: BOARD_ONLY_STMT,
      reconcileGenerationId: null,
    })
    expect(res.body.data.board).toMatchObject({
      total: expect.any(Number),
      已关账: expect.any(Number),
      确认实收: expect.any(Number),
    })
  })

  it('GET /overview 不把无 binding 的终态月计入确认实收（derived quarantine；历史可见+状态计数保留；合法终态照常计入）', async () => {
    // 裁决 A 保守口径：无有效 binding 的终态 hospital-month（trigger 被摘窗口伪造的、
    // 或历史无绑定遗留）保留历史可见性与看板状态计数，但 confirmedLabRevenue 一律
    // 不计入确认实收，也不迁成正常完成态。夹具直插只能走「摘掉新 INSERT 闸 → 写入 →
    // 重装」窗口（修复前该 DROP 为 no-op、直插本就放行 → 本例 RED：确认实收被污染）。
    const db = await getDb()
    const manager = await import('../src/database/DatabaseManager.js')
    const Q_PARTNER = 'PT-RECON-QUAR'
    const Q_MONTH = '2027-02'
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-QUAR', '隔离终态院', 1)`).run(Q_PARTNER)
    db.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_pending_insert_shape')
    db.prepare(`
      INSERT INTO reconcile_hospital_months
        (id, partner_id, partner_name, service_month, status, confirmed_lab_revenue,
         completed_at, completed_by, closed_at, closed_by)
      VALUES ('HM-QUAR-1', ?, '隔离终态院', ?, '已关账', 999999,
              CURRENT_TIMESTAMP, 'attacker', CURRENT_TIMESTAMP, 'attacker')
    `).run(Q_PARTNER, Q_MONTH)
    manager.upgradeAccountReconciliationSchema(db)
    const res = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: Q_MONTH }))
    expect(res.status).toBe(200)
    const items = res.body.data.items as Array<Record<string, unknown>>
    const forged = items.find(item => item.partnerId === Q_PARTNER)
    // 历史可见性 + 状态计数保留（行在、状态在、看板已关账计数在）——不抹历史。
    expect(forged).toMatchObject({ status: '已关账', confirmedLabRevenue: 999999 })
    expect(res.body.data.board.已关账).toBeGreaterThanOrEqual(1)
    // 但钱不进确认实收：该月无其他终态、无补收实收，隔离口径下恰为 0（修复前=999999 必 RED）。
    expect(res.body.data.board.确认实收).toBe(0)
    // 正控（自包含，不依赖兄弟测试产生的 FB 状态）：有 binding + 同终态 current
    // generation + 有效 artifact 的合法已关账月确认实收照常计入，绝不误伤。
    const L_PARTNER = 'PT-RECON-LEGAL'
    const L_MONTH = '2027-03'
    const L_STMT = 'stmt-recon-legal-v1'
    const L_RECON = 'recon-legal-v1'
    const lBinding = {
      partnerId: L_PARTNER,
      settlementMonth: L_MONTH,
      statementGenerationId: L_STMT,
      reconcileGenerationId: L_RECON,
    }
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-LEGAL', '合法终态院', 1)`).run(L_PARTNER)
    seedStatementGeneration(db, L_PARTNER, L_MONTH, L_STMT, [
      { caseNo: 'D1-legal', item: '免疫组化染色*3', amount: 300 },
    ])
    db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('l-legal-d1', 'D1-legal', L_PARTNER, '免疫组化染色', 3, 100, L_MONTH)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('lc-legal-d1', 'D1-legal', L_PARTNER, 3, 0, `${L_MONTH}-10`)
    db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
      .run('cr-legal-1', 'D1-legal', L_PARTNER, L_MONTH, 1000, 830, 830)
    expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(lBinding))).status).toBe(200)
    const lWb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(lBinding))
    const lHmId = lWb.body.data.snapshot.hospitalMonthId
    expect((await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${lHmId}/complete`).send(lBinding))).status).toBe(200)
    expect((await auth(request(app).post('/api/v1/account-reconcile/close').send({ items: [lBinding] }))).status).toBe(200)
    const legal = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: L_MONTH }))
    expect(legal.status).toBe(200)
    expect(legal.body.data.board.确认实收).toBe(830)
  })

  it('GET /overview 不把字段残缺/矛盾的绑定终态月计入确认实收（strict shape 与启动扫描同一谓词；合法 complete/closed 正控照常计入）', async () => {
    // fresh-R2 P1-1：可信实收谓词从「binding + 状态文本↔generation 状态」升级为完整终态
    // 形状（与 ensureReconcileTerminalHospitalMonthIntegrity 同一 SQL 片段，零漂移）：
    // 复核完成须 completed_at canonical + completed_by trim 非空 + closed 字段全空；
    // 已关账须 completed/closed 两组 canonical + 两操作者 trim 非空。残缺行只能经
    // trigger 被摘窗口产生——读侧隔离：历史可见性/状态计数保留，钱不进确认实收；
    // 恢复合法形状后照常计入（零误伤正控）。修复前谓词不查字段 → 残缺行照计 830 → RED。
    const db = await getDb()
    const manager = await import('../src/database/DatabaseManager.js')
    const S_PARTNER = 'PT-RECON-STRICT'
    const S_MONTH = '2027-04'
    const S_STMT = 'stmt-recon-strict-v1'
    const S_RECON = 'recon-strict-v1'
    const sBinding = {
      partnerId: S_PARTNER,
      settlementMonth: S_MONTH,
      statementGenerationId: S_STMT,
      reconcileGenerationId: S_RECON,
    }
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-STRICT', '严格形状院', 1)`).run(S_PARTNER)
    seedStatementGeneration(db, S_PARTNER, S_MONTH, S_STMT, [
      { caseNo: 'D1-strict', item: '免疫组化染色*3', amount: 300 },
    ])
    db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('l-strict-d1', 'D1-strict', S_PARTNER, '免疫组化染色', 3, 100, S_MONTH)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('lc-strict-d1', 'D1-strict', S_PARTNER, 3, 0, `${S_MONTH}-10`)
    db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
      .run('cr-strict-1', 'D1-strict', S_PARTNER, S_MONTH, 1000, 830, 830)
    expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(sBinding))).status).toBe(200)
    const sWb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(sBinding))
    const sHmId = sWb.body.data.snapshot.hospitalMonthId as string
    expect((await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${sHmId}/complete`).send(sBinding))).status).toBe(200)
    const overviewOf = async () => {
      const res = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: S_MONTH }))
      expect(res.status).toBe(200)
      return res.body.data as { board: Record<string, number> }
    }
    const hmRow = () => db.prepare(`
      SELECT completed_at, closed_by FROM reconcile_hospital_months WHERE id = ?
    `).get(sHmId) as { completed_at: string | null; closed_by: string | null }
    // 正控①：合法复核完成照计 830。
    expect((await overviewOf()).board.确认实收).toBe(830)
    // 负测①（complete 清 completed_at）：只能摘 complete_finality 落入——不计入；
    // 恢复合法形状 + 重装权威 trigger（upgrade 顺带跑启动扫描验证已恢复）→ 再计入。
    const completeRow = hmRow()
    try {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_complete_finality')
      db.prepare('UPDATE reconcile_hospital_months SET completed_at = NULL WHERE id = ?').run(sHmId)
      const malformed = await overviewOf()
      expect(malformed.board.确认实收).toBe(0)
      expect(malformed.board.复核完成).toBeGreaterThanOrEqual(1) // 历史可见性/状态计数保留
    } finally {
      db.prepare('UPDATE reconcile_hospital_months SET completed_at = ? WHERE id = ?')
        .run(completeRow.completed_at, sHmId)
      manager.upgradeAccountReconciliationSchema(db)
    }
    expect((await overviewOf()).board.确认实收).toBe(830)
    // 正控②：合法关账照计 830。
    expect((await auth(request(app).post('/api/v1/account-reconcile/close').send({ items: [sBinding] }))).status).toBe(200)
    expect((await overviewOf()).board.确认实收).toBe(830)
    // 负测②（closed 空白 closed_by）：摘 closed_immutable 伪写 → 不计入；恢复 + 重装。
    const closedRow = hmRow()
    try {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_closed_immutable')
      db.prepare(`UPDATE reconcile_hospital_months SET closed_by = '  ' WHERE id = ?`).run(sHmId)
      const malformed = await overviewOf()
      expect(malformed.board.确认实收).toBe(0)
      expect(malformed.board.已关账).toBeGreaterThanOrEqual(1)
    } finally {
      db.prepare('UPDATE reconcile_hospital_months SET closed_by = ? WHERE id = ?')
        .run(closedRow.closed_by, sHmId)
      manager.upgradeAccountReconciliationSchema(db)
    }
    expect((await overviewOf()).board.确认实收).toBe(830)
  })

  it('GET /overview 不把日历不可能终态时间的绑定终态月计入确认实收（2026-02-31/2025-02-29/2026-04-31 负控；2024-02-29 闰日正控照计）', async () => {
    // fresh-R2 P1-3（2026-07-29 review finding）：可信实收谓词的 canonical 时间与启动扫描同一 SQL
    // 片段，从「形状 + 段范围」收紧到 Gregorian 真实日历日（含闰年）——CURRENT_TIMESTAMP
    // 永不产出 2026-02-31（SQLite 会归一化为 2026-03-03），该形状只能经 trigger 被摘
    // 窗口落入 → derived quarantine：看板可见性/计数保留，钱不计入确认实收；合法闰日
    // 2024-02-29 与恢复合法形状后照常计入（零误伤正控）。
    const db = await getDb()
    const manager = await import('../src/database/DatabaseManager.js')
    const C_PARTNER = 'PT-RECON-CAL'
    const C_MONTH = '2027-05'
    const C_STMT = 'stmt-recon-cal-v1'
    const C_RECON = 'recon-cal-v1'
    const cBinding = {
      partnerId: C_PARTNER,
      settlementMonth: C_MONTH,
      statementGenerationId: C_STMT,
      reconcileGenerationId: C_RECON,
    }
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-CAL', '日历闸测试院', 1)`).run(C_PARTNER)
    seedStatementGeneration(db, C_PARTNER, C_MONTH, C_STMT, [
      { caseNo: 'D1-cal', item: '免疫组化染色*3', amount: 300 },
    ])
    db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('l-cal-d1', 'D1-cal', C_PARTNER, '免疫组化染色', 3, 100, C_MONTH)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('lc-cal-d1', 'D1-cal', C_PARTNER, 3, 0, `${C_MONTH}-10`)
    db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
      .run('cr-cal-1', 'D1-cal', C_PARTNER, C_MONTH, 1000, 830, 830)
    expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(cBinding))).status).toBe(200)
    const cWb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(cBinding))
    const cHmId = cWb.body.data.snapshot.hospitalMonthId as string
    expect((await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${cHmId}/complete`).send(cBinding))).status).toBe(200)
    const overviewOf = async () => {
      const res = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: C_MONTH }))
      expect(res.status).toBe(200)
      return res.body.data as { board: Record<string, number> }
    }
    const hmRow = () => db.prepare(`
      SELECT completed_at, closed_at FROM reconcile_hospital_months WHERE id = ?
    `).get(cHmId) as { completed_at: string | null; closed_at: string | null }
    // 正控①：合法复核完成照计 830。
    expect((await overviewOf()).board.确认实收).toBe(830)
    const completeRow = hmRow()
    try {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_complete_finality')
      // 正控②：completed_at 改为合法闰日 2024-02-29 —— 严格 ≠ 误拒真实日期，照计 830。
      db.prepare('UPDATE reconcile_hospital_months SET completed_at = ? WHERE id = ?')
        .run('2024-02-29 09:00:00', cHmId)
      expect((await overviewOf()).board.确认实收).toBe(830)
      // 负测：三枚日历不可能日（平年 2/29、4/31、2/31）—— quarantine 不计入。
      for (const bad of ['2025-02-29 09:00:00', '2026-04-31 09:00:00', '2026-02-31 09:00:00']) {
        db.prepare('UPDATE reconcile_hospital_months SET completed_at = ? WHERE id = ?').run(bad, cHmId)
        const malformed = await overviewOf()
        expect(malformed.board.确认实收).toBe(0)
        expect(malformed.board.复核完成).toBeGreaterThanOrEqual(1) // 历史可见性/状态计数保留
      }
    } finally {
      db.prepare('UPDATE reconcile_hospital_months SET completed_at = ? WHERE id = ?')
        .run(completeRow.completed_at, cHmId)
      manager.upgradeAccountReconciliationSchema(db)
    }
    expect((await overviewOf()).board.确认实收).toBe(830)
    // closed 侧：合法关账照计 830；closed_at 伪写 2026-02-31 → quarantine；恢复后复计。
    expect((await auth(request(app).post('/api/v1/account-reconcile/close').send({ items: [cBinding] }))).status).toBe(200)
    expect((await overviewOf()).board.确认实收).toBe(830)
    const closedRow = hmRow()
    try {
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_closed_immutable')
      db.prepare('UPDATE reconcile_hospital_months SET closed_at = ? WHERE id = ?')
        .run('2026-02-31 09:00:00', cHmId)
      const malformed = await overviewOf()
      expect(malformed.board.确认实收).toBe(0)
      expect(malformed.board.已关账).toBeGreaterThanOrEqual(1)
    } finally {
      db.prepare('UPDATE reconcile_hospital_months SET closed_at = ? WHERE id = ?')
        .run(closedRow.closed_at, cHmId)
      manager.upgradeAccountReconciliationSchema(db)
    }
    expect((await overviewOf()).board.确认实收).toBe(830)
  })

  it('GET /overview 不把 generation 终态字段伪造/actor 漂移的绑定终态月计入确认实收（fresh-R3 P1-A/B：2026-02-31 completed_at/closed_at、NBSP-only/NUL-junk actor quarantine；合法正控照计）', async () => {
    // fresh-R3 P1-A/P1-B（fixed-SHA 复核 2026-07-29）：可信实收谓词的 generation 侧
    // 此前只钉状态/身份——generation.completed_at/closed_at 日历无效、completed_by
    // NBSP-only（SQLite trim 只剥空格）照计 830 → RED。修复后与启动扫描同一谓词
    // （片段 + coreone_canonical_actor UDF + BLOB instr(x'00') 原始字节闸）：
    // quarantine 不计入、看板计数保留，恢复合法形状照常计入。hm 侧 NBSP actor 同钉
    //（片段 actor UDF 消费证明）。fresh blocker 补钉：'USER-001\0junk' 经 node:sqlite
    // 截断在 UDF 单侧冒充合法——gen/hm 两侧 actor NUL-junk 负测只能归因 BLOB 字节闸。
    const db = await getDb()
    const manager = await import('../src/database/DatabaseManager.js')
    const G_PARTNER = 'PT-RECON-GTERM'
    const G_MONTH = '2027-06'
    const G_STMT = 'stmt-recon-gterm-v1'
    const G_RECON = 'recon-gterm-v1'
    const gBinding = {
      partnerId: G_PARTNER,
      settlementMonth: G_MONTH,
      statementGenerationId: G_STMT,
      reconcileGenerationId: G_RECON,
    }
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-GTERM', '代次终态闸测试院', 1)`).run(G_PARTNER)
    seedStatementGeneration(db, G_PARTNER, G_MONTH, G_STMT, [
      { caseNo: 'D1-gterm', item: '免疫组化染色*3', amount: 300 },
    ])
    db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('l-gterm-d1', 'D1-gterm', G_PARTNER, '免疫组化染色', 3, 100, G_MONTH)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('lc-gterm-d1', 'D1-gterm', G_PARTNER, 3, 0, `${G_MONTH}-10`)
    db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
      .run('cr-gterm-1', 'D1-gterm', G_PARTNER, G_MONTH, 1000, 830, 830)
    expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(gBinding))).status).toBe(200)
    const gWb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(gBinding))
    const gHmId = gWb.body.data.snapshot.hospitalMonthId as string
    expect((await auth(request(app).post(`/api/v1/account-reconcile/hospital-months/${gHmId}/complete`).send(gBinding))).status).toBe(200)
    const overviewOf = async () => {
      const res = await auth(request(app).get('/api/v1/account-reconcile/overview').query({ settlementMonth: G_MONTH }))
      expect(res.status).toBe(200)
      return res.body.data as { board: Record<string, number> }
    }
    const genRow = () => db.prepare(`
      SELECT completed_at, completed_by, closed_at FROM account_reconcile_generations
       WHERE reconcile_generation_id = ?
    `).get(G_RECON) as { completed_at: string | null; completed_by: string | null; closed_at: string | null }
    const hmRow = () => db.prepare(`
      SELECT completed_by FROM reconcile_hospital_months WHERE id = ?
    `).get(gHmId) as { completed_by: string | null }
    // 正控①：合法复核完成照计 830。
    expect((await overviewOf()).board.确认实收).toBe(830)
    const genBefore = genRow()
    const hmBefore = hmRow()
    try {
      db.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_complete_finality')
      db.exec('DROP TRIGGER IF EXISTS trg_reconcile_hospital_month_complete_finality')
      // 负测①：generation.completed_at = 2026-02-31（日历不存在日）。
      db.prepare('UPDATE account_reconcile_generations SET completed_at = ? WHERE reconcile_generation_id = ?')
        .run('2026-02-31 09:00:00', G_RECON)
      expect((await overviewOf()).board.确认实收).toBe(0)
      // 负测②：恢复 completed_at 后单变量伪造 generation.completed_by = NBSP-only
      //（SQL trim 冒充非空）——拒绝只能归因 actor 谓词。
      db.prepare('UPDATE account_reconcile_generations SET completed_at = ?, completed_by = ? WHERE reconcile_generation_id = ?')
        .run(genBefore.completed_at, String.fromCodePoint(0x00a0), G_RECON)
      expect((await overviewOf()).board.确认实收).toBe(0)
      // 负测③：恢复 generation 后单变量伪造 hm.completed_by = NBSP-only（片段 actor
      // UDF 消费钉）。
      db.prepare('UPDATE account_reconcile_generations SET completed_by = ? WHERE reconcile_generation_id = ?')
        .run(genBefore.completed_by, G_RECON)
      db.prepare('UPDATE reconcile_hospital_months SET completed_by = ? WHERE id = ?')
        .run(String.fromCodePoint(0x00a0), gHmId)
      const malformed = await overviewOf()
      expect(malformed.board.确认实收).toBe(0)
      expect(malformed.board.复核完成).toBeGreaterThanOrEqual(1) // 历史可见性/状态计数保留
      // 负测④：恢复 hm 后单变量伪造 generation.completed_by = 'USER-001\0junk'
      //（fresh blocker：node:sqlite 截断使 UDF 只见 'USER-001'——拒绝只能归因
      // 片段内 BLOB instr(x'00') 原始字节闸）。
      db.prepare('UPDATE reconcile_hospital_months SET completed_by = ? WHERE id = ?')
        .run(hmBefore.completed_by, gHmId)
      db.prepare('UPDATE account_reconcile_generations SET completed_by = ? WHERE reconcile_generation_id = ?')
        .run('USER-001\0junk', G_RECON)
      expect((await overviewOf()).board.确认实收).toBe(0)
      // 负测⑤：恢复 generation 后单变量伪造 hm.completed_by = 'USER-001\0junk'
      //（hm 侧同一字节闸消费钉）。
      db.prepare('UPDATE account_reconcile_generations SET completed_by = ? WHERE reconcile_generation_id = ?')
        .run(genBefore.completed_by, G_RECON)
      db.prepare('UPDATE reconcile_hospital_months SET completed_by = ? WHERE id = ?')
        .run('USER-001\0junk', gHmId)
      const malformedNulHm = await overviewOf()
      expect(malformedNulHm.board.确认实收).toBe(0)
      expect(malformedNulHm.board.复核完成).toBeGreaterThanOrEqual(1)
    } finally {
      db.prepare('UPDATE account_reconcile_generations SET completed_at = ?, completed_by = ? WHERE reconcile_generation_id = ?')
        .run(genBefore.completed_at, genBefore.completed_by, G_RECON)
      db.prepare('UPDATE reconcile_hospital_months SET completed_by = ? WHERE id = ?')
        .run(hmBefore.completed_by, gHmId)
      manager.upgradeAccountReconciliationSchema(db)
    }
    expect((await overviewOf()).board.确认实收).toBe(830)
    // closed 侧：合法关账照计 830；generation.closed_at = 2026-02-31 → quarantine；恢复后复计。
    expect((await auth(request(app).post('/api/v1/account-reconcile/close').send({ items: [gBinding] }))).status).toBe(200)
    expect((await overviewOf()).board.确认实收).toBe(830)
    const genClosedBefore = genRow()
    try {
      db.exec('DROP TRIGGER IF EXISTS trg_account_reconcile_closed_immutable')
      db.prepare('UPDATE account_reconcile_generations SET closed_at = ? WHERE reconcile_generation_id = ?')
        .run('2026-02-31 09:00:00', G_RECON)
      const malformed = await overviewOf()
      expect(malformed.board.确认实收).toBe(0)
      expect(malformed.board.已关账).toBeGreaterThanOrEqual(1)
    } finally {
      db.prepare('UPDATE account_reconcile_generations SET closed_at = ? WHERE reconcile_generation_id = ?')
        .run(genClosedBefore.closed_at, G_RECON)
      manager.upgradeAccountReconciliationSchema(db)
    }
    expect((await overviewOf()).board.确认实收).toBe(830)
  })

  it('collect 非法 collectedMonth 稳定 400：零业务写、零 supplement_collect 成功审计；4xx 拒绝审计仍按 operation_logs 逐条合同完整计入（R7 严格月校验），合法值照旧入账', async () => {
    // R7 P1-2：collectedMonth 复用严格 YYYY-(01..12) 校验。准确口径——零业务写、
    // 零 supplement_collect 成功审计；4xx 拒绝审计仍按 operation_logs 的逐条/聚合合同
    // 完整计入，且不落原始请求体。本例 4 次拒绝远低于聚合阈值、全部逐条：
    // operation='DENIED POST account-reconcile'、outcome='denied'、request_data 精确
    // {status:400, code:'INVALID_COLLECTED_MONTH'}，四种原始值均不得出现在
    // request_data/description/response_data。
    const { __resetDenialTrackerForTest, DENIAL_AGG_THRESHOLD } = await import('../src/middleware/audit-log.js')
    __resetDenialTrackerForTest() // 只隔离进程内拒绝窗；不清数据库历史
    const CM_PARTNER = 'PT-RECON-CM'
    const CM_STMT = 'stmt-recon-cm-v1'
    const CM_RECON = 'recon-cm-v1'
    const cmBinding = {
      partnerId: CM_PARTNER,
      settlementMonth: FB_MONTH,
      statementGenerationId: CM_STMT,
      reconcileGenerationId: CM_RECON,
    }
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-CM', '严格月校验医院', 1)`).run(CM_PARTNER)
    seedStatementGeneration(db, CM_PARTNER, FB_MONTH, CM_STMT, [
      { caseNo: 'D1-cm', item: '免疫组化染色*3', amount: 300 },
    ])
    db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('l-cm-d1', 'D1-cm', CM_PARTNER, '免疫组化染色', 3, 100, FB_MONTH)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('lc-cm-d1', 'D1-cm', CM_PARTNER, 5, 0, `${FB_MONTH}-10`)

    const computed = await auth(request(app).post('/api/v1/account-reconcile/compute').send(cmBinding))
    expect(computed.status).toBe(200)
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(cmBinding))
    const cmDiff = (wb.body.data.diffs as Array<{ id: string }>)[0]
    const verdict = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${cmDiff.id}/verdict`).send({
      ...cmBinding,
      reason: '漏收，需补收',
    }))
    expect(verdict.status).toBe(200)
    const supplement = db.prepare(
      'SELECT id FROM supplement_orders WHERE source_diff_id = ?',
    ).get(cmDiff.id) as { id: string }
    const approved = await request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplement.id}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({})
    expect(approved.status).toBe(200)

    const snapshot = () => db.prepare(
      `SELECT status, collected_at, collected_month, collected_revenue FROM supplement_orders WHERE id = ?`,
    ).get(supplement.id)
    const auditCount = () => (db.prepare(
      `SELECT COUNT(*) AS n FROM abc_audit_logs WHERE action = 'supplement_collect' AND target_id = ?`,
    ).get(supplement.id) as { n: number }).n
    const before = snapshot()
    const auditBefore = auditCount()
    const denialRowidBefore = (db.prepare(
      'SELECT COALESCE(MAX(rowid), 0) AS m FROM operation_logs',
    ).get() as { m: number }).m
    expect(before).toMatchObject({ status: '待补收', collected_month: null })

    const badMonths = ['2026-13', '2026-00', '2026-1', 'LOC005-R7-CM-SENTINEL']
    expect(badMonths.length).toBeLessThanOrEqual(DENIAL_AGG_THRESHOLD) // 逐条窗内，无聚合
    for (const collectedMonth of badMonths) {
      const refused = await auth(request(app)
        .post(`/api/v1/account-reconcile/supplements/${supplement.id}/collect`)
        .send({ collectedMonth }))
      expect(refused.status).toBe(400)
      expect(refused.body.error.code).toBe('INVALID_COLLECTED_MONTH')
      expect(snapshot()).toEqual(before)
      expect(auditCount()).toBe(auditBefore)
    }

    // 4xx 拒绝审计：4 次拒绝 = 4 条 individual denial，零聚合；每条仅 {status,code} 元数据，
    // response_data 恒 null，四种原始值均不落 request_data/description/response_data。
    const newAuditRows = db.prepare(`
      SELECT operation, outcome, description, request_data, response_data
        FROM operation_logs
       WHERE rowid > ?
       ORDER BY rowid
    `).all(denialRowidBefore) as Array<{
      operation: string
      outcome: string | null
      description: string
      request_data: string | null
      response_data: string | null
    }>
    const collectDenied = newAuditRows.filter(row => row.operation === 'DENIED POST account-reconcile')
    expect(collectDenied).toHaveLength(badMonths.length)
    expect(newAuditRows.filter(row => row.operation.startsWith('DENIED_AGG'))).toHaveLength(0)
    for (const row of collectDenied) {
      expect(row.outcome).toBe('denied')
      expect(row.description).toContain(`/supplements/${supplement.id}/collect`)
      expect(JSON.parse(String(row.request_data))).toEqual({ status: 400, code: 'INVALID_COLLECTED_MONTH' })
      expect(row.response_data).toBeNull()
      for (const raw of badMonths) {
        expect(String(row.request_data)).not.toContain(raw)
        expect(row.description).not.toContain(raw)
      }
    }

    const collected = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplement.id}/collect`)
      .send({ collectedMonth: '2026-12' }))
    expect(collected.status).toBe(200)
    expect(snapshot()).toMatchObject({ status: '已补收', collected_month: '2026-12' })
  })

  it('collect 字段存在即严格校验原始值且先于资源状态（R8 真 strict），缺席才默认当月', async () => {
    // R8 P1-3 路由侧：collectedMonth 仅在字段完全缺席时默认当月；字段存在时不做
    // String()/trim() 救赎，原始值直接过 strict validator，且置于一切 DB/资源状态
    // 查询之前——whitespace/array/object/null/'' 在 approved/已补收/未签发/不存在
    // 四种资源状态下均稳定 400 INVALID_COLLECTED_MONTH。准确口径——零业务写、
    // 零 supplement_collect 成功审计；4xx 拒绝审计仍按 operation_logs 的逐条/聚合
    // 合同完整计入（32 次拒绝非「行数 +32」），且不落原始请求体。
    // 0000-01 与 9999-12 按既有合同保留合法。
    const { __resetDenialTrackerForTest, DENIAL_AGG_THRESHOLD } = await import('../src/middleware/audit-log.js')
    __resetDenialTrackerForTest() // 只隔离进程内拒绝窗；不清数据库历史
    const CM8_PARTNER = 'PT-RECON-CM8'
    const CM8_STMT = 'stmt-recon-cm8-v1'
    const CM8_RECON = 'recon-cm8-v1'
    const cm8Binding = {
      partnerId: CM8_PARTNER,
      settlementMonth: FB_MONTH,
      statementGenerationId: CM8_STMT,
      reconcileGenerationId: CM8_RECON,
    }
    const db = await getDb()
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-CM8', 'R8严格月医院', 1)`).run(CM8_PARTNER)
    const cm8Cases = ['D1-cm8', 'D2-cm8', 'D3-cm8', 'D4-cm8', 'D5-cm8']
    seedStatementGeneration(db, CM8_PARTNER, FB_MONTH, CM8_STMT,
      cm8Cases.map(caseNo => ({ caseNo, item: '免疫组化染色*1', amount: 100 })))
    cm8Cases.forEach((caseNo, index) => {
      db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(`l-cm8-d${index + 1}`, caseNo, CM8_PARTNER, '免疫组化染色', 1, 100, FB_MONTH)
      db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`lc-cm8-d${index + 1}`, caseNo, CM8_PARTNER, 5, 0, `${FB_MONTH}-10`)
    })

    const computed = await auth(request(app).post('/api/v1/account-reconcile/compute').send(cm8Binding))
    expect(computed.status).toBe(200)
    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(cm8Binding))
    const cm8Diffs = wb.body.data.diffs as Array<{ id: string }>
    expect(cm8Diffs.length).toBe(5)
    for (const diff of cm8Diffs) {
      const verdict = await auth(request(app).post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`).send({
        ...cm8Binding,
        reason: '漏收，需补收',
      }))
      expect(verdict.status).toBe(200)
    }
    const supplements = db.prepare(
      `SELECT id FROM supplement_orders WHERE reconcile_generation_id = ? ORDER BY id`,
    ).all(CM8_RECON) as Array<{ id: string }>
    expect(supplements.length).toBe(5)
    // 资源状态矩阵：[0] approved 待补收；[1] approved+已补收；[2] pending_review 未签发；
    // 'so-r8-nonexistent' 不存在；[3]/[4] 留给边界合法值入账。
    const approve = (id: string) => request(app)
      .post(`/api/v1/account-reconcile/supplements/${id}/approve`)
      .set('Authorization', `Bearer ${reviewerToken}`)
      .send({})
    expect((await approve(supplements[0].id)).status).toBe(200)
    expect((await approve(supplements[1].id)).status).toBe(200)
    expect((await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[1].id}/collect`)
      .send({ collectedMonth: '2026-12' }))).status).toBe(200)

    const snapshot = (id: string) => db.prepare(
      `SELECT status, collected_at, collected_month, collected_revenue FROM supplement_orders WHERE id = ?`,
    ).get(id)
    const auditCount = () => (db.prepare(
      `SELECT COUNT(*) AS n FROM abc_audit_logs WHERE action = 'supplement_collect'`,
    ).get() as { n: number }).n
    const beforeRows = supplements.map(entry => snapshot(entry.id))
    const auditBefore = auditCount()
    const denialRowidBefore = (db.prepare(
      'SELECT COALESCE(MAX(rowid), 0) AS m FROM operation_logs',
    ).get() as { m: number }).m

    const badValues: unknown[] = [
      ' 2026-07', '2026-07 ', '', null, ['2026-07'], { month: '2026-07' }, 202607, '2026-13',
    ]
    const targets = [supplements[0].id, supplements[1].id, supplements[2].id, 'so-r8-nonexistent']
    for (const collectedMonth of badValues) {
      for (const target of targets) {
        const res = await auth(request(app)
          .post(`/api/v1/account-reconcile/supplements/${target}/collect`)
          .send({ collectedMonth }))
        expect(res.status).toBe(400)
        expect(res.body.error.code).toBe('INVALID_COLLECTED_MONTH')
      }
    }
    // 全形状零业务写：四行快照逐字段相等 + supplement_collect 成功审计零增量
    supplements.forEach((entry, index) => {
      expect(snapshot(entry.id)).toEqual(beforeRows[index])
    })
    expect(auditCount()).toBe(auditBefore)

    // 4xx 拒绝审计按 operation_logs 逐条/聚合合同完整计入（非「行数 +32」）：
    // 阈值内逐条 = DENIAL_AGG_THRESHOLD 条 individual（仅 {status,code} 元数据、
    // outcome='denied'、response_data 恒 null）；恰一条 denied_agg（total=32、
    // suppressed=32-threshold）；individual + agg.suppressed = 32 证明每次拒绝都被
    // 逻辑计入。所有新增行均不含任一原始 body 值（agg 侧 windowStart 为数值型
    // 窗口戳，不可能承载 body，泄漏检查用剔除该字段的视图）。
    const newAuditRows = db.prepare(`
      SELECT operation, outcome, description, request_data, response_data
        FROM operation_logs
       WHERE rowid > ?
       ORDER BY rowid
    `).all(denialRowidBefore) as Array<{
      operation: string
      outcome: string | null
      description: string
      request_data: string | null
      response_data: string | null
    }>
    const individual = newAuditRows.filter(row => row.operation === 'DENIED POST account-reconcile')
    const aggregated = newAuditRows.filter(row => row.operation === 'DENIED_AGG account-reconcile')
    expect(individual).toHaveLength(DENIAL_AGG_THRESHOLD)
    expect(aggregated).toHaveLength(1)
    for (const row of individual) {
      expect(row.outcome).toBe('denied')
      expect(JSON.parse(String(row.request_data))).toEqual({ status: 400, code: 'INVALID_COLLECTED_MONTH' })
      expect(row.response_data).toBeNull()
    }
    expect(aggregated[0].outcome).toBe('denied_agg')
    const aggPayload = JSON.parse(String(aggregated[0].request_data)) as Record<string, unknown>
    expect(Object.keys(aggPayload).sort()).toEqual(
      ['aggregated', 'statusClass', 'suppressed', 'total', 'windowStart'],
    )
    expect(aggPayload).toMatchObject({
      aggregated: true,
      statusClass: 'other',
      total: badValues.length * targets.length,
      suppressed: badValues.length * targets.length - DENIAL_AGG_THRESHOLD,
    })
    expect(typeof aggPayload.windowStart).toBe('number')
    expect(individual.length + Number(aggPayload.suppressed)).toBe(badValues.length * targets.length)
    const aggLeakView = { ...aggPayload }
    delete aggLeakView.windowStart
    const leakHaystacks = [
      ...individual.map(row => `${row.description}\n${String(row.request_data)}`),
      `${aggregated[0].description}\n${JSON.stringify(aggLeakView)}`,
    ]
    for (const value of badValues) {
      if (value === '') continue
      const rendered = typeof value === 'string' ? value : JSON.stringify(value)
      if (!rendered) continue
      for (const haystack of leakHaystacks) {
        expect(haystack).not.toContain(rendered)
      }
    }

    // 缺席默认上海业务月：冻结在上海 9 月 1 日 00:30（UTC 仍为 8 月），
    // 响应、业务事实和成功审计必须使用同一个 2026-09。
    vi.setSystemTime(new Date('2026-08-31T16:30:00.000Z'))
    let defaulted: any
    try {
      const fixedToken = await loginAdmin(app)
      defaulted = await request(app)
        .post(`/api/v1/account-reconcile/supplements/${supplements[0].id}/collect`)
        .set('Authorization', `Bearer ${fixedToken}`)
        .send({})
    } finally {
      vi.useRealTimers()
    }
    expect(defaulted.status).toBe(200)
    expect(defaulted.body.data.collectedMonth).toBe('2026-09')
    expect(snapshot(supplements[0].id)).toMatchObject({ status: '已补收', collected_month: '2026-09' })
    const defaultAudit = db.prepare(`
      SELECT detail
        FROM abc_audit_logs
       WHERE action = 'supplement_collect' AND target_id = ?
       ORDER BY rowid DESC
       LIMIT 1
    `).get(supplements[0].id) as { detail: string }
    expect(JSON.parse(defaultAudit.detail).collectedMonth).toBe('2026-09')
    // 年界同样走缺省路径；先恢复真实时钟完成独立签发，再冻结收款时钟。
    expect((await approve(supplements[2].id)).status).toBe(200)
    vi.setSystemTime(new Date('2026-12-31T16:30:00.000Z'))
    let yearBoundary: any
    try {
      const fixedToken = await loginAdmin(app)
      yearBoundary = await request(app)
        .post(`/api/v1/account-reconcile/supplements/${supplements[2].id}/collect`)
        .set('Authorization', `Bearer ${fixedToken}`)
        .send({})
    } finally {
      vi.useRealTimers()
    }
    expect(yearBoundary.status).toBe(200)
    expect(yearBoundary.body.data.collectedMonth).toBe('2027-01')
    expect(snapshot(supplements[2].id)).toMatchObject({ status: '已补收', collected_month: '2027-01' })
    const yearBoundaryAudit = db.prepare(`
      SELECT detail
        FROM abc_audit_logs
       WHERE action = 'supplement_collect' AND target_id = ?
       ORDER BY rowid DESC
       LIMIT 1
    `).get(supplements[2].id) as { detail: string }
    expect(JSON.parse(yearBoundaryAudit.detail).collectedMonth).toBe('2027-01')
    // 边界合法值按既有合同保留：0000-01 / 9999-12
    expect((await approve(supplements[3].id)).status).toBe(200)
    const edgeLow = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[3].id}/collect`)
      .send({ collectedMonth: '0000-01' }))
    expect(edgeLow.status).toBe(200)
    expect(snapshot(supplements[3].id)).toMatchObject({ collected_month: '0000-01' })
    expect((await approve(supplements[4].id)).status).toBe(200)
    const edgeHigh = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[4].id}/collect`)
      .send({ collectedMonth: '9999-12' }))
    expect(edgeHigh.status).toBe(200)
    expect(snapshot(supplements[4].id)).toMatchObject({ collected_month: '9999-12' })
  })
})

describe('账实核对路由 · workbench verdictBy DTO（P2：认定者回填 + 代次隔离）', () => {
  // GET /workbench diffs DTO 漏 verdictBy——认定前必须为 null、认定后必须返回真实
  // operator id（登录 admin 用户的 username；operatorOf=req.user.username，与全站
  // 审计 operator=用户名 口径一致），且跨代次不串值（他代同形 diff 保持 null）。
  const VB_MONTH = '2026-10'

  it('workbench diffs expose verdictBy: null 认定前、真实 operator id 认定后、跨代不串值', async () => {
    const db = await getDb()
    const seedVerdictPartner = (partner: string, stmt: string, tag: string) => {
      db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, ?, ?, 1)`)
        .run(partner, `RC-${tag}`, `verdictBy医院${tag}`)
      seedStatementGeneration(db, partner, VB_MONTH, stmt, [
        { caseNo: `D1-${tag}`, item: '免疫组化染色*3', amount: 300 },
      ])
      db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(`l-${tag}-d1`, `D1-${tag}`, partner, '免疫组化染色', 3, 100, VB_MONTH)
      db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(`lc-${tag}-d1`, `D1-${tag}`, partner, 5, 0, `${VB_MONTH}-10`)
    }
    seedVerdictPartner('PT-RECON-VBA', 'stmt-recon-vba-v1', 'vba')
    seedVerdictPartner('PT-RECON-VBB', 'stmt-recon-vbb-v1', 'vbb')
    const bindingA = {
      partnerId: 'PT-RECON-VBA',
      settlementMonth: VB_MONTH,
      statementGenerationId: 'stmt-recon-vba-v1',
      reconcileGenerationId: 'recon-vba-v1',
    }
    const bindingB = {
      partnerId: 'PT-RECON-VBB',
      settlementMonth: VB_MONTH,
      statementGenerationId: 'stmt-recon-vbb-v1',
      reconcileGenerationId: 'recon-vbb-v1',
    }
    expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(bindingA))).status).toBe(200)
    expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(bindingB))).status).toBe(200)

    const workbenchDiffs = async (binding: Record<string, unknown>) => {
      const res = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(binding))
      expect(res.status).toBe(200)
      return res.body.data.diffs as Array<{
        id: string
        verdict: string | null
        verdictBy?: string | null
      }>
    }
    // 认定前：A/B 两代 verdictBy 均为 null（键在且值为 null，不是 undefined 缺键）
    const diffsA0 = await workbenchDiffs(bindingA)
    expect(diffsA0.length).toBeGreaterThan(0)
    for (const diff of diffsA0) {
      expect(diff.verdict).toBeNull()
      expect(diff.verdictBy).toBeNull()
    }
    const diffsB0 = await workbenchDiffs(bindingB)
    expect(diffsB0.length).toBeGreaterThan(0)
    for (const diff of diffsB0) {
      expect(diff.verdictBy).toBeNull()
    }

    // 认定 A 代首条 diff（真实路由、真实 operator）
    const verdict = await auth(request(app)
      .post(`/api/v1/account-reconcile/diffs/${diffsA0[0].id}/verdict`)
      .send({ ...bindingA, reason: '核对无误' }))
    expect(verdict.status).toBe(200)

    // 认定后：A 代该 diff verdictBy=真实 operator id（admin 用户名）；A 代其余 diff 仍 null（行级隔离）
    const diffsA1 = await workbenchDiffs(bindingA)
    const verdicted = diffsA1.find(diff => diff.id === diffsA0[0].id)
    expect(verdicted?.verdict).toBe('核对无误')
    expect(verdicted?.verdictBy).toBe('admin')
    for (const diff of diffsA1.filter(diff => diff.id !== diffsA0[0].id)) {
      expect(diff.verdictBy).toBeNull()
    }
    // 代次隔离：B 代不受 A 代认定影响
    const diffsB1 = await workbenchDiffs(bindingB)
    expect(diffsB1.length).toBe(diffsB0.length)
    for (const diff of diffsB1) {
      expect(diff.verdict).toBeNull()
      expect(diff.verdictBy).toBeNull()
    }
  })
})

describe('Issue #105 · complete/close 与 verdict 的操作者身份同口径（username）', () => {
  // 验收：同一对账生命周期内 verdict_by / completed_by / closed_by 与对应
  // abc_audit_logs.operator 全部等于登录用户 username（admin），而非 userId（USER-001）。
  const A105_MONTH = '2026-11'
  const A105_PARTNER = 'PT-RECON-105'
  const A105_STMT = 'stmt-recon-105-v1'
  const A105_RECON = 'recon-105-v1'
  const A105_BINDING = {
    partnerId: A105_PARTNER,
    settlementMonth: A105_MONTH,
    statementGenerationId: A105_STMT,
    reconcileGenerationId: A105_RECON,
  }

  const seedIssue105 = (db: any) => {
    db.prepare(`INSERT OR IGNORE INTO partners (id, code, name, status) VALUES (?, 'RC-105', 'Issue105医院', 1)`)
      .run(A105_PARTNER)
    seedStatementGeneration(db, A105_PARTNER, A105_MONTH, A105_STMT, [
      { caseNo: 'A105', item: '免疫组化染色*3', amount: 300 },
    ])
    db.prepare(`INSERT INTO case_revenue_lines (id, case_no, partner_id, charge_item, qty, unit_price, service_month) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('l-105-a', 'A105', A105_PARTNER, '免疫组化染色', 3, 100, A105_MONTH)
    db.prepare(`INSERT OR IGNORE INTO lis_cases (id, case_no, partner_id, ihc_count, special_stain_count, operate_time) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('lc-105-a', 'A105', A105_PARTNER, 5, 0, `${A105_MONTH}-10`)
    db.prepare(`INSERT OR IGNORE INTO case_revenue (id, case_no, partner_id, service_month, gross_amount, net_amount, lab_revenue, revenue_source) VALUES (?, ?, ?, ?, ?, ?, ?, 'statement')`)
      .run('cr-105', 'A105', A105_PARTNER, A105_MONTH, 1000, 830, 830)
  }

  it('complete/close 落库身份与 verdict_by 及对应审计 operator 同为登录用户名', async () => {
    const db = await getDb()
    seedIssue105(db)
    expect((await auth(request(app).post('/api/v1/account-reconcile/compute').send(A105_BINDING))).status).toBe(200)

    const wb = await auth(request(app).get('/api/v1/account-reconcile/workbench').query(A105_BINDING))
    expect(wb.status).toBe(200)
    const hmId = wb.body.data.snapshot.hospitalMonthId as string
    const diffs = wb.body.data.diffs as Array<{ id: string }>
    expect(diffs.length).toBe(1)
    for (const diff of diffs) {
      const v = await auth(request(app)
        .post(`/api/v1/account-reconcile/diffs/${diff.id}/verdict`)
        .send({ ...A105_BINDING, reason: '核对无误' }))
      expect(v.status).toBe(200)
    }

    const completed = await auth(request(app)
      .post(`/api/v1/account-reconcile/hospital-months/${hmId}/complete`)
      .send(A105_BINDING))
    expect(completed.status).toBe(200)
    expect(completed.body.data.confirmedLabRevenue).toBe(830)

    const closed = await auth(request(app)
      .post('/api/v1/account-reconcile/close')
      .send({ items: [A105_BINDING] }))
    expect(closed.status).toBe(200)

    const generation = db.prepare(
      'SELECT completed_by, closed_by, status FROM account_reconcile_generations WHERE reconcile_generation_id = ?',
    ).get(A105_RECON) as { completed_by: string | null; closed_by: string | null; status: string }
    const hospitalMonth = db.prepare(
      'SELECT completed_by, closed_by, status, confirmed_lab_revenue FROM reconcile_hospital_months WHERE id = ?',
    ).get(hmId) as { completed_by: string | null; closed_by: string | null; status: string; confirmed_lab_revenue: number }
    const verdictDiff = db.prepare('SELECT verdict_by FROM reconcile_diffs WHERE id = ?').get(diffs[0].id) as { verdict_by: string | null }

    expect(generation.status).toBe('closed')
    expect(generation.completed_by).toBe('admin')
    expect(generation.closed_by).toBe('admin')
    expect(hospitalMonth.status).toBe('已关账')
    expect(hospitalMonth.completed_by).toBe('admin')
    expect(hospitalMonth.closed_by).toBe('admin')
    expect(hospitalMonth.confirmed_lab_revenue).toBe(830)
    expect(verdictDiff.verdict_by).toBe('admin')

    const auditRows = db.prepare(`
      SELECT action, target_id, operator FROM abc_audit_logs
       WHERE module = 'account_reconcile'
         AND action IN ('verdict', 'complete_generation', 'close_generation')
         AND (target_id = ? OR target_id = ?)
       ORDER BY rowid
    `).all(diffs[0].id, A105_RECON) as Array<{ action: string; target_id: string; operator: string }>
    expect(auditRows).toHaveLength(3)
    expect(auditRows.map((r) => `${r.action}:${r.target_id}:${r.operator}`)).toEqual([
      `verdict:${diffs[0].id}:admin`,
      `complete_generation:${A105_RECON}:admin`,
      `close_generation:${A105_RECON}:admin`,
    ])
  })
})
