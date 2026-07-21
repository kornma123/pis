/**
 * K3-LOC-020：LIS 纠错闭环（#178 导入拒收可见 + #179 登记月带留痕更正）。
 * 真实 Express app + node:sqlite :memory:（p0-harness），不用 source-regex / helper clone 替代。
 *
 * #178：/import 回执必须携带 typed、canonical、有界的 rejection items（rejections/rejectedTotal/
 *   rejectionsTruncated），至少区分 CROSS_MONTH_CONFLICT / INVALID_OPERATE_TIME / ROW_SHAPE_INVALID，
 *   每项只含安全识别字段；既有计数字段（rejectedCrossMonth 等）保持原样。
 * #179：POST /correction —— partnerId+caseNo+expectedOperateTime(CAS)+newOperateTime+reason+confirm
 *   精确契约；trusted actor 只取 req.user；BEGIN IMMEDIATE 锁内重读 + CAS 更新 + reconciliation_logs
 *   留痕同一事务；stale/missing/invalid/same/empty/unauthorized/audit/update/commit fault 全零 partial。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { buildTestApp, getDb } from './p0-harness.js'

let app: any
let db: any
let adminToken = ''
let financeToken = ''
let techToken = '' // technician：持 reconciliation W 但非管理员/财务 → /correction 应 403

async function login(u: string, p: string): Promise<string> {
  const request = (await import('supertest')).default
  return (await request(app).post('/api/v1/auth/login').send({ username: u, password: p })).body?.data?.token || ''
}
async function req() { return (await import('supertest')).default }

function partnerIdOf(name: string): string {
  return (db.prepare('SELECT id FROM partners WHERE name = ?').get(name) as any)?.id || ''
}
function operateTimeOf(partnerId: string, caseNo: string): string | null {
  return (db.prepare('SELECT operate_time FROM lis_cases WHERE partner_id = ? AND case_no = ?').get(partnerId, caseNo) as any)?.operate_time ?? null
}
function correctionAudits(caseNo: string): any[] {
  return db.prepare("SELECT * FROM reconciliation_logs WHERE type = 'lis_operate_time_correction' AND target_name = ?").all(caseNo) as any[]
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
  financeToken = await login('caiwu', 'CoreOne2026!')
  techToken = await login('jishuyuan1', 'CoreOne2026!')
})

describe('#178 导入拒收可见：typed canonical rejection items', () => {
  it('跨月同号冲突 → CROSS_MONTH_CONFLICT item（caseNo/partnerName/existing/incoming month），既有计数保持', async () => {
    const request = await req()
    await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'RJ-001', 送检医院: '拒收医院甲', 登记时间: '2026-05-10', 蜡块数: 1 }] })
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'RJ-001', 送检医院: '拒收医院甲', 登记时间: '2026-06-02', 蜡块数: 2 }] })
    expect(res.status).toBe(200)
    expect(res.body.data.rejectedCrossMonth).toBe(1)
    expect(res.body.data.rejectedTotal).toBe(1)
    expect(res.body.data.rejectionsTruncated).toBe(false)
    expect(Array.isArray(res.body.data.rejections)).toBe(true)
    expect(res.body.data.rejections).toHaveLength(1)
    expect(res.body.data.rejections[0]).toEqual({
      code: 'CROSS_MONTH_CONFLICT',
      caseNo: 'RJ-001',
      partnerName: '拒收医院甲',
      existingMonth: '2026-05',
      incomingMonth: '2026-06',
    })
    // 合法行零拒收与「有拒收」可区分：本次 imported=0、rejections 恰 1 条
    expect(res.body.data.imported).toBe(0)
  })

  it('非法登记时间 → INVALID_OPERATE_TIME item（非法值只带截断安全摘要）', async () => {
    const request = await req()
    const longGarbage = `2026-02-31-${'X'.repeat(200)}`
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'RJ-002', 送检医院: '拒收医院乙', 登记时间: longGarbage, 蜡块数: 1 }] })
    expect(res.status).toBe(200)
    expect(res.body.data.rejectedInvalidDate).toBe(1)
    expect(res.body.data.rejectedTotal).toBe(1)
    expect(res.body.data.rejections).toHaveLength(1)
    const item = res.body.data.rejections[0]
    expect(item.code).toBe('INVALID_OPERATE_TIME')
    expect(item.caseNo).toBe('RJ-002')
    expect(item.partnerName).toBe('拒收医院乙')
    expect(typeof item.value).toBe('string')
    expect(item.value.length).toBeLessThanOrEqual(40) // 安全摘要：截断，不整段回显
  })

  it('shape-invalid 行（缺病理号/医院）→ ROW_SHAPE_INVALID item', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: '', 送检医院: '缺号医院', 登记时间: '2026-05-10', 蜡块数: 1 }] })
    expect(res.status).toBe(200)
    expect(res.body.data.skipped).toBe(1)
    expect(res.body.data.rejectedTotal).toBe(1)
    expect(res.body.data.rejections).toHaveLength(1)
    expect(res.body.data.rejections[0].code).toBe('ROW_SHAPE_INVALID')
    expect(res.body.data.rejections[0].partnerName).toBe('缺号医院')
  })

  it('rejection items 只含安全识别字段，不回显整行输入或患者信息', async () => {
    const request = await req()
    await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'RJ-003', 送检医院: '拒收医院丙', 登记时间: '2026-05-10', 蜡块数: 1 }] })
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'RJ-003', 送检医院: '拒收医院丙', 登记时间: '2026-07-01', 蜡块数: 9, 患者姓名: '不应回显', 送检部位: '宫颈3点' }] })
    expect(res.status).toBe(200)
    const item = res.body.data.rejections[0]
    expect(Object.keys(item).sort()).toEqual(['caseNo', 'code', 'existingMonth', 'incomingMonth', 'partnerName'])
    expect(JSON.stringify(item)).not.toContain('不应回显')
    expect(JSON.stringify(item)).not.toContain('宫颈')
  })

  it('items 有界：>100 条拒收时 rejections 截断、rejectedTotal 精确、rejectionsTruncated=true', async () => {
    const request = await req()
    const rows = Array.from({ length: 120 }, (_, i) => ({ 病理号: `RJ-BOUND-${i}`, 送检医院: '拒收医院丁', 登记时间: '2026-02-31', 蜡块数: 1 }))
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`).send({ cases: rows })
    expect(res.status).toBe(200)
    expect(res.body.data.rejectedInvalidDate).toBe(120)
    expect(res.body.data.rejectedTotal).toBe(120)
    expect(res.body.data.rejections.length).toBeLessThanOrEqual(100)
    expect(res.body.data.rejectionsTruncated).toBe(true)
  })

  it('合法零：全部落库时 rejections=[]、rejectedTotal=0、rejectionsTruncated=false（与 unknown 分离）', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'RJ-004', 送检医院: '拒收医院戊', 登记时间: '2026-05-11', 蜡块数: 1 }] })
    expect(res.status).toBe(200)
    expect(res.body.data.imported).toBe(1)
    expect(res.body.data.rejectedTotal).toBe(0)
    expect(res.body.data.rejections).toEqual([])
    expect(res.body.data.rejectionsTruncated).toBe(false)
  })
})

describe('#179 登记月带留痕更正（POST /correction）', () => {
  const HOSPITAL = '更正医院'
  let pid = ''

  beforeAll(async () => {
    const request = await req()
    await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'CR-001', 送检医院: HOSPITAL, 登记时间: '2026-05-10', 蜡块数: 3 }] })
    pid = partnerIdOf(HOSPITAL)
    expect(pid).not.toBe('')
  })

  it('happy path：CAS 匹配 → 200，返回 canonical old/new truth，reconciliation_logs 留痕（trusted actor=req.user）', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-05-10', newOperateTime: '2026-06-15', reason: '登记月录错，财务确认应为 6 月', confirm: true })
    expect(res.status).toBe(200)
    expect(res.body.data.caseNo).toBe('CR-001')
    expect(res.body.data.partnerId).toBe(pid)
    expect(res.body.data.oldOperateTime).toBe('2026-05-10')
    expect(res.body.data.newOperateTime).toBe('2026-06-15')
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-15')
    const audits = correctionAudits('CR-001')
    expect(audits).toHaveLength(1)
    expect(audits[0].field).toBe('operate_time')
    expect(audits[0].old_value).toBe('2026-05-10')
    expect(audits[0].new_value).toBe('2026-06-15')
    expect(audits[0].reason).toBe('登记月录错，财务确认应为 6 月')
    const adminId = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as any).id
    expect(audits[0].operator).toBe(adminId) // trusted actor 只来自 req.user
  })

  it('stale expected（CAS 不匹配）→ 409 STALE_EXPECTED，值不变、无审计行（零 partial）', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-05-10', newOperateTime: '2026-07-01', reason: '用过期的当前值重试', confirm: true })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('STALE_EXPECTED')
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-15')
    expect(correctionAudits('CR-001')).toHaveLength(1) // 仍只有 happy path 那一条
  })

  it('stale 后重试：带最新 expected → 200', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-15', newOperateTime: '2026-06-20', reason: '重试：按最新登记时间更正日', confirm: true })
    expect(res.status).toBe(200)
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-20')
    expect(correctionAudits('CR-001')).toHaveLength(2)
  })

  it('missing target → 404 NOT_FOUND，无审计行', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-NO-SUCH', expectedOperateTime: '2026-05-10', newOperateTime: '2026-06-15', reason: '不存在的病例', confirm: true })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
    expect(correctionAudits('CR-NO-SUCH')).toHaveLength(0)
  })

  it('invalid newOperateTime（日历不存在日）→ 400 INVALID_TIME，值不变', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-02-31', reason: '非法时间应被拒', confirm: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('INVALID_TIME')
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-20')
  })

  it('same-value（新月与当前 canonical 相同）→ 409 SAME_VALUE，无审计行', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026/6/20', reason: '同一值不同写法', confirm: true })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('SAME_VALUE')
    expect(correctionAudits('CR-001')).toHaveLength(2)
  })

  it('empty reason → 400 EMPTY_REASON；缺 reason 同拒', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', reason: '   ', confirm: true })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('EMPTY_REASON')
    const res2 = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', confirm: true })
    expect(res2.status).toBe(400)
    expect(res2.body.error.code).toBe('EMPTY_REASON')
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-20')
  })

  it('缺显式 confirm / confirm=false → 400 CONFIRM_REQUIRED', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', reason: '未确认不应生效' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('CONFIRM_REQUIRED')
    const res2 = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', reason: '未确认不应生效', confirm: false })
    expect(res2.status).toBe(400)
    expect(res2.body.error.code).toBe('CONFIRM_REQUIRED')
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-20')
  })

  it('body 夹带 actor/operator/role 伪造审计字段 → 400 FORGED_AUDIT_FIELD，无审计行', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', reason: '伪造操作者', confirm: true, operator: 'someone-else' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('FORGED_AUDIT_FIELD')
    const res2 = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', reason: '伪造角色', confirm: true, actor: 'admin', role: 'admin' })
    expect(res2.status).toBe(400)
    expect(res2.body.error.code).toBe('FORGED_AUDIT_FIELD')
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-20')
    expect(correctionAudits('CR-001')).toHaveLength(2)
  })

  it('unauthorized：无 token 401；technician（W 但非管理员/财务）403；值不变', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction')
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', reason: '无令牌', confirm: true })
    expect(res.status).toBe(401)
    const res2 = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${techToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-07-01', reason: '技术员不应能走纠错通道', confirm: true })
    expect(res2.status).toBe(403)
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-20')
    expect(correctionAudits('CR-001')).toHaveLength(2)
  })

  it('finance（LIS 导入口径 owner）可走纠错通道', async () => {
    const request = await req()
    const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${financeToken}`)
      .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-20', newOperateTime: '2026-06-25', reason: '财务更正登记日', confirm: true })
    expect(res.status).toBe(200)
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-25')
    const caiwuId = (db.prepare("SELECT id FROM users WHERE username = 'caiwu'").get() as any).id
    const audits = correctionAudits('CR-001')
    expect(audits).toHaveLength(3)
    expect(audits[2].operator).toBe(caiwuId)
  })

  it('audit fault（reconciliation_logs 不可用）→ 500，operate_time 回滚到原值（零 partial）', async () => {
    const request = await req()
    db.exec('ALTER TABLE reconciliation_logs RENAME TO reconciliation_logs__hidden')
    try {
      const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
        .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-25', newOperateTime: '2026-07-01', reason: '审计故障应整体回滚', confirm: true })
      expect(res.status).toBe(500)
    } finally {
      db.exec('ALTER TABLE reconciliation_logs__hidden RENAME TO reconciliation_logs')
    }
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-25')
    expect(correctionAudits('CR-001')).toHaveLength(3)
  })

  it('update fault（UPDATE 触发失败）→ 500，值不变、无审计行', async () => {
    const request = await req()
    db.exec("CREATE TRIGGER fail_lis_update BEFORE UPDATE ON lis_cases BEGIN SELECT RAISE(ABORT, 'forced update fault'); END")
    try {
      const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
        .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-25', newOperateTime: '2026-07-01', reason: '更新故障应整体回滚', confirm: true })
      expect(res.status).toBe(500)
    } finally {
      db.exec('DROP TRIGGER fail_lis_update')
    }
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-25')
    expect(correctionAudits('CR-001')).toHaveLength(3)
  })

  it('commit fault（延迟外键在 COMMIT 爆雷）→ 500，值不变、无审计行', async () => {
    const request = await req()
    db.exec(`
      CREATE TABLE commit_fault_parent (id TEXT PRIMARY KEY);
      CREATE TABLE commit_fault_child (id TEXT PRIMARY KEY, pid TEXT REFERENCES commit_fault_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER force_commit_fault AFTER UPDATE ON lis_cases BEGIN INSERT INTO commit_fault_child VALUES ('cf-x', 'cf-missing'); END;
    `)
    try {
      const res = await request(app).post('/api/v1/lis-cases/correction').set('Authorization', `Bearer ${adminToken}`)
        .send({ partnerId: pid, caseNo: 'CR-001', expectedOperateTime: '2026-06-25', newOperateTime: '2026-07-01', reason: '提交故障应整体回滚', confirm: true })
      expect(res.status).toBe(500)
    } finally {
      db.exec('DROP TRIGGER force_commit_fault; DROP TABLE commit_fault_child; DROP TABLE commit_fault_parent;')
    }
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-25')
    expect(correctionAudits('CR-001')).toHaveLength(3)
  })

  it('闭环：更正到 6 月后，同月重传放行、跨月硬拒（普通 /import 跨月拒绝保持原样）', async () => {
    const request = await req()
    // 当前 CR-001 在 2026-06-25：同月重传（不同日）→ 放行更新
    const same = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'CR-001', 送检医院: HOSPITAL, 登记时间: '2026-06-26', 蜡块数: 4 }] })
    expect(same.status).toBe(200)
    expect(same.body.data.imported).toBe(1)
    expect(same.body.data.rejectedCrossMonth).toBe(0)
    // 跨到 7 月 → 仍硬拒（#168 回归）
    const cross = await request(app).post('/api/v1/lis-cases/import').set('Authorization', `Bearer ${adminToken}`)
      .send({ cases: [{ 病理号: 'CR-001', 送检医院: HOSPITAL, 登记时间: '2026-07-02', 蜡块数: 5 }] })
    expect(cross.status).toBe(200)
    expect(cross.body.data.rejectedCrossMonth).toBe(1)
    expect(cross.body.data.rejections[0].code).toBe('CROSS_MONTH_CONFLICT')
    expect(operateTimeOf(pid, 'CR-001')).toBe('2026-06-26')
  })
})
