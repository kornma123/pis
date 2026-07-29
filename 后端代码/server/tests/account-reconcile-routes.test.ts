/**
 * Phase 1 账实核对 —— 路由 + 状态机集成（设计基线 §1.4/§1.5/§4）。
 * 端到端：compute → 认定(6原因·补收gate) → 复核完成(前置=全认定) → 关账(定版) + 反向必填理由。
 */
import { describe, it, expect, beforeAll } from 'vitest'
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

    // 缺席默认当月：字段完全不出现 → 200 入账当月
    const defaulted = await auth(request(app)
      .post(`/api/v1/account-reconcile/supplements/${supplements[0].id}/collect`)
      .send({}))
    expect(defaulted.status).toBe(200)
    const defaultMonth = new Date().toISOString().slice(0, 7)
    expect(snapshot(supplements[0].id)).toMatchObject({ status: '已补收', collected_month: defaultMonth })
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
