/**
 * 权限影子断言矩阵 —— CI 门 + 埋雷自测（Phase 2 权限翻转的门 · 本轮只断言不接管）。
 *
 * 设计与两个断言（A 可见性 role×route / B 守卫 endpoint×method）见 src/shadow-matrix/matrix-core.ts 头注。
 *
 * 本文件两块：
 *   ① 活体门（live gate）：对当前 master 跑整张矩阵，断言「无放宽（BLOCK=0）· 无提级收窄 · UNGUARDED 全在
 *      public 白名单 · review 全在裁决清单 · 路由集相等」。任一破 → 红（ride 后端 vitest required 门）。
 *   ② 埋雷自测（SEC-2）：四维各植一个 diff（改可见性/降 W→R/删条件/换模块），断言矩阵逐个抓到且 verdict
 *      正确——机器证明「这张网不漏」。加解析器单测锁守卫抽取。
 *
 * 更新快照：`SHADOW_MATRIX_UPDATE=1 npm run test:node -- shadow-permission-matrix`
 *   （新增/改动端点守卫时，人复核 diff 后重新批准写入 expected-guards.snapshot.json）。
 *
 * golden 零回归：本文件纯断言/自省·不碰任何业务/成本/鉴权判定。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import app from '../src/app.js'
import { getDatabase } from '../src/database/DatabaseManager.js'
import { introspectEndpoints, type RuntimeEndpoint } from '../src/shadow-matrix/route-introspect.js'
import {
  loadSourceInputs, buildActualGuards, resolveActualForEndpoint, runMatrix, buildVisibilityWiring,
  activeWriteRoutesFromLogs, type SourceInputs,
  SNAPSHOT_FILE, loadExpectedGuards, loadPublicAllowlist, loadReviewDecisions,
} from '../src/shadow-matrix/index.js'
import {
  diffVisibility, diffGuard, buildVisibilityMatrix, buildGuardMatrix, classify, evaluateGate, visibleUnder,
  isSuperset, isUnguarded, type GuardId, type Caps,
  SPECIAL_ALL, SPECIAL_FINANCE_ADMIN,
} from '../src/shadow-matrix/matrix-core.js'
import { parseRouteFileGuards, parseAppMounts, parseRouteRegistry, parsePermissionsVisibility, lexerEndState, blankComments } from '../src/shadow-matrix/source-parsers.js'

const UPDATE = process.env.SHADOW_MATRIX_UPDATE === '1'

// ════════════════════════════════════════════════════════════════════════════
// ① 活体门（对当前 master）
// ════════════════════════════════════════════════════════════════════════════
describe('shadow permission matrix · 活体门（current master）', () => {
  let runtime: RuntimeEndpoint[]

  beforeAll(() => {
    runtime = introspectEndpoints(app)
    if (UPDATE) {
      // 重新批准：把当前 actual 守卫写进快照（人复核 git diff）。
      const src = loadSourceInputs()
      const build = buildActualGuards(src)
      const guards: Record<string, GuardId> = {}
      for (const e of runtime) guards[e.key] = resolveActualForEndpoint(build, e.key)
      const ordered = Object.fromEntries(Object.keys(guards).sort().map((k) => [k, guards[k]]))
      fs.writeFileSync(
        SNAPSHOT_FILE,
        JSON.stringify(
          {
            _doc: '权限影子断言矩阵·已批准守卫快照（ratified）。键=运行时端点「METHOD /path」，值=guardId{module,level,conditions}。' +
              '断言 B 拿它当 expected 比对当前 actual：模块变/降级 W→R/少条件=BLOCK。改端点守卫→人复核后 SHADOW_MATRIX_UPDATE=1 重批。',
            generated: '由 SHADOW_MATRIX_UPDATE=1 生成（日期见 git 提交）',
            count: Object.keys(ordered).length,
            guards: ordered,
          },
          null,
          2,
        ) + '\n',
      )
      // eslint-disable-next-line no-console
      console.log(`\n✎ 已写快照 ${Object.keys(ordered).length} 端点 → ${SNAPSHOT_FILE}`)
    }
  })

  it('运行时端点自省成功（B 的地面真相·终裁 3）', () => {
    expect(runtime.length).toBeGreaterThan(200)
    // 每端点键形如 "METHOD /api/..."
    for (const e of runtime.slice(0, 5)) expect(e.key).toMatch(/^[A-Z]+ \/api\//)
  })

  it('路由集相等前置（终裁 4）：legacy(permissions.ts) == registry(route-registry.ts)', () => {
    const src = loadSourceInputs()
    const vw = buildVisibilityWiring(src)
    expect(vw.routeSetDiff.onlyLegacy, `仅现行有的路由（registry 缺）: ${vw.routeSetDiff.onlyLegacy.join(', ')}`).toEqual([])
    expect(vw.routeSetDiff.onlyRegistry, `仅注册表有的路由（permissions 缺）: ${vw.routeSetDiff.onlyRegistry.join(', ')}`).toEqual([])
  })

  it('整张矩阵 clean：无放宽(BLOCK=0)·无提级·UNGUARDED 全白名单·review 全裁决', () => {
    // escalated 接真实数据源：从 app 的 operation_logs 派生活跃写路由（CI :memory: 库无写历史 → 空·诚实；
    //   非死代码，wiring 被真实执行。生产报告用生产库同理但有真实数据）。
    const src = loadSourceInputs()
    const activeWrite = activeWriteRoutesFromLogs(getDatabase(), src.activeRoutes)
    const a = runMatrix(runtime, { src, isActiveWriteRoute: (_role, route) => activeWrite.has(route) })
    const dump = (xs: any[]) => xs.map((d) => (d.endpoint ? `${d.endpoint} [${d.verdict}] ${d.reasons?.join('；')}` : `${d.role}|${d.route} [${d.verdict}] ${d.reason}`)).join('\n  ')
    expect(a.routeSetUnequal, '路由集不相等').toBe(false)
    expect(a.blockCount, `BLOCK（放宽·必须 0）:\n  ${dump(a.classification.block)}`).toBe(0)
    expect(a.escalatedCount, `escalated（收窄命中活跃写端点）:\n  ${dump(a.classification.escalated)}`).toBe(0)
    expect(a.unguardedNotAllowlisted.length, `UNGUARDED 未登记 public 白名单（SEC-1）:\n  ${dump(a.unguardedNotAllowlisted)}`).toBe(0)
    expect(a.reviewNotDecided.length, `review 未进裁决清单（不许静默过）:\n  ${dump(a.reviewNotDecided)}`).toBe(0)
    expect(a.clean).toBe(true)
  })

  it('B 覆盖健全：几乎每个运行时端点都被静态守卫解析到（未解析=UNGUARDED 只能是白名单公共端点）', () => {
    const src = loadSourceInputs()
    const build = buildActualGuards(src)
    const allow = loadPublicAllowlist()
    const unmatched = runtime.filter((e) => !(e.key in build.guards))
    // 唯一允许「运行时有、静态无守卫」的端点 = 直接挂载的公共端点（/api/health），且必在白名单。
    for (const e of unmatched) {
      expect(allow.has(e.key), `运行时端点 ${e.key} 无静态守卫且不在 public 白名单（解析缺口或真缺口·fail-closed）`).toBe(true)
    }
    // 静态解析出的守卫不应有「运行时不存在」的悬空键（防解析出比实际多的守卫）。
    const runtimeKeys = new Set(runtime.map((e) => e.key))
    const stale = Object.keys(build.guards).filter((k) => !runtimeKeys.has(k))
    expect(stale, `静态守卫悬空（运行时无此端点）: ${stale.join(', ')}`).toEqual([])
  })

  it('快照覆盖 = 运行时端点集（防端点从源码与快照同时丢·终裁 3）', () => {
    const expected = loadExpectedGuards()
    const runtimeKeys = new Set(runtime.map((e) => e.key))
    const snapKeys = new Set(Object.keys(expected))
    const missingFromSnap = [...runtimeKeys].filter((k) => !snapKeys.has(k)).sort()
    const staleInSnap = [...snapKeys].filter((k) => !runtimeKeys.has(k)).sort()
    expect(missingFromSnap, `运行时端点不在快照（新端点未批准）: ${missingFromSnap.join(', ')}`).toEqual([])
    expect(staleInSnap, `快照端点已从运行时消失（须更新快照）: ${staleInSnap.join(', ')}`).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ② 埋雷自测（SEC-2）：四维各植一个 diff → 断言矩阵逐个抓到且 verdict 正确
// ════════════════════════════════════════════════════════════════════════════
describe('shadow permission matrix · 埋雷自测（SEC-2·机器证明这张网不漏）', () => {
  const roles = ['admin', 'technician', 'finance']
  const capsByRole: Record<string, Caps> = {
    admin: {},
    technician: { inventory: 'R', bom: 'W' }, // 无 account_reconcile / cost_analysis
    finance: { account_reconcile: 'W', cost_analysis: 'W', inventory: 'R' },
  }
  const adminRoles = new Set(['admin'])

  it('雷① 可见性放宽（不可见→可见）→ BLOCK', () => {
    // registry 把 /account-reconcile 映到 technician **无**的模块之外的一个 technician **有**的模块，
    // 而 legacy 映到 technician **无**的 account_reconcile → technician 现行不可见、派生可见 = 放宽。
    const routes = ['/account-reconcile']
    const diffs = buildVisibilityMatrix({
      roles, routes, capsByRole, adminRoles,
      legacyModuleOf: () => 'account_reconcile', // technician 无
      registryModuleOf: () => 'inventory', // technician 有 → 可见
    })
    const tech = diffs.find((d) => d.role === 'technician' && d.route === '/account-reconcile')
    expect(tech?.verdict).toBe('BLOCK')
    expect(tech?.legacyVisible).toBe(false)
    expect(tech?.registryVisible).toBe(true)
  })

  it('雷①b 可见性收窄（可见→不可见）→ review；命中活跃写端点 → escalated', () => {
    const routes = ['/reconciliation']
    const base = { roles, routes, capsByRole, adminRoles, legacyModuleOf: () => 'inventory', registryModuleOf: () => 'account_reconcile' }
    // technician 有 inventory（现行可见）、无 account_reconcile（派生不可见）→ 收窄
    const review = buildVisibilityMatrix(base).find((d) => d.role === 'technician')
    expect(review?.verdict).toBe('review')
    // 同样收窄但该 **route** 命中活跃写端点 → 提级（按 route 语义·非 role·对抗复核 #2 修正）
    const esc = buildVisibilityMatrix({ ...base, isActiveWriteRoute: (_role, route) => route === '/reconciliation' }).find((d) => d.role === 'technician')
    expect(esc?.verdict).toBe('escalated')
  })

  it('雷② 守卫 level 降级 W→R → BLOCK', () => {
    const d = diffGuard('POST /x', { module: 'inventory', level: 'W', conditions: [] }, { module: 'inventory', level: 'R', conditions: [] })
    expect(d.verdict).toBe('BLOCK')
    expect(d.reasons.join()).toMatch(/降级 W→R/)
  })

  it('雷③ 守卫少一个条件（conditions 非超集）→ BLOCK', () => {
    const d = diffGuard(
      'POST /x',
      { module: 'account_reconcile', level: 'W', conditions: ['sod:self-review'] },
      { module: 'account_reconcile', level: 'W', conditions: [] },
    )
    expect(d.verdict).toBe('BLOCK')
    expect(d.reasons.join()).toMatch(/条件缺失/)
  })

  it('雷④ 守卫模块被换 → BLOCK', () => {
    const d = diffGuard('POST /x', { module: 'account_reconcile', level: 'W', conditions: [] }, { module: 'reconciliation', level: 'W', conditions: [] })
    expect(d.verdict).toBe('BLOCK')
    expect(d.reasons.join()).toMatch(/模块不同/)
  })

  // ── 反向/边界：证明「无变化=无 diff」「收紧=review 非 BLOCK」「无守卫单列」──
  it('无变化 → equal（无假阳性）', () => {
    const g: GuardId = { module: 'inventory', level: 'W', conditions: ['admin'] }
    expect(diffGuard('POST /x', { ...g }, { ...g }).verdict).toBe('equal')
    const vis = diffVisibility('technician', '/x', true, true)
    expect(vis.verdict).toBe('equal')
  })

  it('收紧（升级 R→W / 多条件）→ review，不误判 BLOCK', () => {
    expect(diffGuard('POST /x', { module: 'inventory', level: 'R', conditions: [] }, { module: 'inventory', level: 'W', conditions: [] }).verdict).toBe('review')
    expect(diffGuard('POST /x', { module: 'inventory', level: 'W', conditions: [] }, { module: 'inventory', level: 'W', conditions: ['admin'] }).verdict).toBe('review')
  })

  it('任一侧无守卫 → UNGUARDED（独立类别·SEC-1 不许当 equal 静默过）', () => {
    const bothNull = diffGuard('GET /pub', { module: null, level: null, conditions: [] }, { module: null, level: null, conditions: [] })
    expect(bothNull.verdict).toBe('UNGUARDED')
    // 守卫被拿掉（期望有→现在无）= 弱化 → BLOCK（不是 UNGUARDED 静默）
    const stripped = diffGuard('POST /x', { module: 'inventory', level: 'W', conditions: [] }, { module: null, level: null, conditions: [] })
    expect(stripped.verdict).toBe('BLOCK')
  })

  it('端点新增/移除不静默：新守卫端点→review·新公共端点→UNGUARDED·移除端点→review', () => {
    // 新端点（快照无）有守卫 → review（须批准）
    expect(diffGuard('POST /new', null, { module: 'inventory', level: 'W', conditions: [] }).verdict).toBe('review')
    // 新端点无守卫 → UNGUARDED
    expect(diffGuard('GET /new', null, { module: null, level: null, conditions: [] }).verdict).toBe('UNGUARDED')
    // 端点移除（运行时无、快照有）→ review（防两边同时丢）
    expect(diffGuard('GET /gone', { module: 'inventory', level: 'R', conditions: [] }, null).verdict).toBe('review')
  })

  it('buildGuardMatrix 端点集 = 运行时 ∪ 快照键（快照独有键一定产 diff·不静默）', () => {
    const diffs = buildGuardMatrix({
      runtimeEndpoints: ['GET /a'],
      actualGuards: { 'GET /a': { module: 'inventory', level: 'R', conditions: [] } },
      expectedGuards: {
        'GET /a': { module: 'inventory', level: 'R', conditions: [] }, // equal
        'GET /removed': { module: 'inventory', level: 'R', conditions: [] }, // 快照独有 → review
      },
    })
    expect(diffs.map((d) => d.endpoint)).toEqual(['GET /removed'])
    expect(diffs[0].verdict).toBe('review')
  })

  it('classify 分桶正确 + isSuperset/isUnguarded 边界', () => {
    expect(isSuperset(['a', 'b'], ['a'])).toBe(true)
    expect(isSuperset(['a'], ['a', 'b'])).toBe(false)
    expect(isUnguarded({ module: null, level: null, conditions: [] })).toBe(true)
    expect(isUnguarded({ module: null, level: null, conditions: ['anyRole:finance'] })).toBe(false)
    expect(isUnguarded({ module: 'inventory', level: 'R', conditions: [] })).toBe(false)
    const cls = classify(
      [diffVisibility('t', '/x', false, true)], // BLOCK
      [diffGuard('GET /p', { module: null, level: null, conditions: [] }, { module: null, level: null, conditions: [] })], // UNGUARDED
    )
    expect(cls.block.length).toBe(1)
    expect(cls.unguarded.length).toBe(1)
  })

  // ── 端到端埋雷（对抗复核 #3：穿过装配好的门·非纯函数·给门闸过滤 + runMatrix + parser→assembly 装牙）──
  it('门闸装配有牙：未登记白名单的 UNGUARDED / 未裁决的 review → clean=false；登记后放行；BLOCK 永不能靠登记洗白', () => {
    const unguarded = diffGuard('GET /secret', { module: null, level: null, conditions: [] }, { module: null, level: null, conditions: [] })
    const reviewD = diffGuard('POST /x', { module: 'inventory', level: 'R', conditions: [] }, { module: 'inventory', level: 'W', conditions: [] }) // 收紧=review
    const cls = classify([], [unguarded, reviewD])
    // 空白名单 + 空裁决 → 都未登记 → clean=false（防「把过滤改恒空静默少报」的突变）
    const g1 = evaluateGate({ classification: cls, publicAllowlist: new Set(), reviewDecisions: new Set(), routeSetUnequal: false })
    expect(g1.clean).toBe(false)
    expect(g1.unguardedNotAllowlisted.length).toBe(1)
    expect(g1.reviewNotDecided.length).toBe(1)
    // 登记后 → clean=true（证明过滤按登记放行·非恒真也非恒空）
    const g2 = evaluateGate({ classification: cls, publicAllowlist: new Set(['GET /secret']), reviewDecisions: new Set(['POST /x']), routeSetUnequal: false })
    expect(g2.clean).toBe(true)
    // BLOCK / escalated 永不能靠登记洗白（放宽=硬红）
    const blockCls = classify([diffVisibility('t', '/x', false, true)], [])
    expect(evaluateGate({ classification: blockCls, publicAllowlist: new Set(), reviewDecisions: new Set(['t|/x']), routeSetUnequal: false }).clean).toBe(false)
    const escCls = classify([diffVisibility('t', '/x', true, false, true)], [])
    expect(evaluateGate({ classification: escCls, publicAllowlist: new Set(), reviewDecisions: new Set(['t|/x']), routeSetUnequal: false }).clean).toBe(false)
    // 路由集不等 → 硬红
    expect(evaluateGate({ classification: classify([], []), publicAllowlist: new Set(), reviewDecisions: new Set(), routeSetUnequal: true }).clean).toBe(false)
  })

  it('escalated 经 runMatrix 端到端产出（收窄命中活跃写端点·非绕过纯函数·对抗复核 #2）', () => {
    // 合成 src：/x 现行映 inventory（technician 有→可见）、派生映 account_reconcile（technician 无→不可见）= 收窄。
    const src: SourceInputs = {
      root: '', routesDir: '/nonexistent', imports: {}, mounts: [],
      registry: [{ path: '/', permModule: null, status: 'active' }, { path: '/x', permModule: 'account_reconcile', status: 'active' }],
      activeRoutes: ['/', '/x'],
      permsVis: { navPathModule: { '/x': 'inventory' }, financeAdminPaths: [], alwaysPaths: ['/'] },
    }
    const opts = {
      src, expectedGuards: {}, publicAllowlist: new Set<string>(), reviewDecisions: new Set<string>(),
      capsByRole: { admin: {} as Caps, technician: { inventory: 'R' } as Caps }, roles: ['admin', 'technician'], adminRoles: new Set(['admin']),
    }
    // 不标活跃写 → review（可被裁决清单洗白）
    const noEsc = runMatrix([], { ...opts, isActiveWriteRoute: () => false })
    expect(noEsc.escalatedCount).toBe(0)
    expect(noEsc.classification.review.length).toBe(1)
    // 标该 route 为活跃写端点 → escalated（不可洗白）→ clean=false
    const withEsc = runMatrix([], { ...opts, isActiveWriteRoute: (_r, route) => route === '/x' })
    expect(withEsc.escalatedCount).toBe(1)
    expect(withEsc.clean).toBe(false)
  })

  it('parser→assembly 端到端：真守卫写坏（含 #1 选项抹平）经 buildActualGuards→diffGuard 被抓 BLOCK', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-mine-'))
    try {
      // 强守卫版：failClosedOnMissing:true + primaryRoleOnly:true
      fs.writeFileSync(path.join(tmp, 'x.ts'), `
        const guard = requireAdmin({ primaryRoleOnly: true })
        router.post('/approve', requirePermission('account_reconcile','W'), guard, (req,res)=>{
          if (!assertNotSelfReview(res, { submitterId: a, actorId: b, message: 'm', failClosedOnMissing: true })) return
        })
      `)
      const strong = buildActualGuards({ root: '', routesDir: tmp, imports: { r: 'x' }, mounts: [{ prefix: '/api/v1/ar', module: null, level: null, authed: true, routerVar: 'r' }], registry: [], activeRoutes: [], permsVis: { navPathModule: {}, financeAdminPaths: [], alwaysPaths: [] } })
      const strongGuard = strong.guards['POST /api/v1/ar/approve']
      expect(strongGuard.conditions.sort()).toEqual(['admin:primaryRole', 'sod:self-review:failClosed'])
      // 弱守卫版：删 primaryRoleOnly + 删 failClosedOnMissing（纯放宽·#1 的静默场景）
      fs.writeFileSync(path.join(tmp, 'x.ts'), `
        const guard = requireAdmin()
        router.post('/approve', requirePermission('account_reconcile','W'), guard, (req,res)=>{
          if (!assertNotSelfReview(res, { submitterId: a, actorId: b, message: 'm' })) return
        })
      `)
      const weak = buildActualGuards({ root: '', routesDir: tmp, imports: { r: 'x' }, mounts: [{ prefix: '/api/v1/ar', module: null, level: null, authed: true, routerVar: 'r' }], registry: [], activeRoutes: [], permsVis: { navPathModule: {}, financeAdminPaths: [], alwaysPaths: [] } })
      const weakGuard = weak.guards['POST /api/v1/ar/approve']
      expect(weakGuard.conditions.sort()).toEqual(['admin:rolesAware', 'sod:self-review'])
      // 期望=强·当前=弱 → 两条件都被削 → 非超集 → BLOCK（#1 修复前这里会 equal 静默过）
      const d = diffGuard('POST /api/v1/ar/approve', strongGuard, weakGuard)
      expect(d.verdict).toBe('BLOCK')
      expect(d.reasons.join()).toMatch(/条件缺失/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ③ 解析器单测（锁守卫抽取：别名/W-升级/SoD/口径/挂载）
// ════════════════════════════════════════════════════════════════════════════
describe('shadow permission matrix · 解析器（守卫抽取正确性）', () => {
  it('路由文件：requirePermission 直用 + W 升级 + 挂载继承', () => {
    const g = parseRouteFileGuards(`
      import { requirePermission } from '../middleware/permissions.js'
      router.get('/', (req,res)=>{})
      router.post('/', requirePermission('inbound','W'), (req,res)=>{})
    `)
    expect(g.find((x) => x.method === 'GET' && x.relPath === '/')).toMatchObject({ module: null, level: null, conditions: [] })
    expect(g.find((x) => x.method === 'POST')).toMatchObject({ module: 'inbound', level: 'W', conditions: [] })
  })

  it('路由文件：const 别名 requireAnyRole / requireCostRead 解析', () => {
    const g = parseRouteFileGuards(`
      const requireCostRead = requirePermission('cost_analysis','R')
      const requireImport = requireAnyRole('admin','finance')
      router.get('/health', authenticateToken, requireCostRead, (req,res)=>{})
      router.post('/import', authenticateToken, requireImport, (req,res)=>{})
    `)
    expect(g.find((x) => x.relPath === '/health')).toMatchObject({ module: 'cost_analysis', level: 'R', conditions: [] })
    expect(g.find((x) => x.relPath === '/import')).toMatchObject({ module: null, conditions: ['anyRole:admin+finance'] })
  })

  it('路由文件：仅识别拒绝分支后直接 tail-call 已知守卫的窄 wrapper，普通 wrapper 不得被推断为 W', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-wrapper-'))
    try {
      fs.writeFileSync(path.join(tmp, 'x.ts'), `
        const requireWrite = requirePermission('reconciliation', 'W')
        const requireCaseImportWrite: RequestHandler = (req, res, next) => {
          const items = (req.body as { items?: unknown } | undefined)?.items
          if (Array.isArray(items) && items.length > 1000) {
            error(res, 'too many rows', 'INVALID_PARAMETER', 400)
            return
          }
          requireWrite(req, res, next)
        }
        const ordinaryWrapper: RequestHandler = (_req, _res, next) => { next() }
        router.post('/cases/import', requireCaseImportWrite, (_req, _res) => {})
        router.post('/ordinary', ordinaryWrapper, (_req, _res) => {})
      `)
      const build = buildActualGuards({
        root: '', routesDir: tmp, imports: { reconciliationRoutes: 'x' },
        mounts: [{ prefix: '/api/v1/reconciliation', module: 'reconciliation', level: 'R', authed: true, routerVar: 'reconciliationRoutes' }],
        registry: [], activeRoutes: [],
        permsVis: { navPathModule: {}, financeAdminPaths: [], alwaysPaths: [] },
      })
      expect(build.guards['POST /api/v1/reconciliation/ordinary']).toEqual({
        module: 'reconciliation', level: 'R', conditions: [],
      })
      expect(build.guards['POST /api/v1/reconciliation/cases/import']).toEqual({
        module: 'reconciliation', level: 'W', conditions: [],
      })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('路由文件：handler 内 SoD / 口径门 抽成条件', () => {
    const g = parseRouteFileGuards(`
      router.post('/approve', requirePermission('account_reconcile','W'), (req,res)=>{
        if (!assertNotSelfReview(res, { submitterId: x, actorId: y, message: 'm', failClosedOnMissing: true })) return
      })
      router.put('/:id', requireConfig, (req,res)=>{
        if (!assertCaliberChangeAllowed(req,res, changed, 'm')) return
      })
      const requireConfig = requireAnyRole('finance')
    `)
    // failClosedOnMissing:true → 编码进 condition（对抗复核 #1·删掉它=放宽须能被抓）
    expect(g.find((x) => x.relPath === '/approve')).toMatchObject({ module: 'account_reconcile', level: 'W', conditions: ['sod:self-review:failClosed'] })
    expect(g.find((x) => x.relPath === '/:id')?.conditions.sort()).toEqual(['anyRole:finance', 'caliber-admin'])
  })

  it('app.ts 挂载：requirePermission 挂载守卫 + 无守卫挂载 + router 变量对应', () => {
    const mounts = parseAppMounts(`
      app.use('/api/v1/inventory', authenticateToken, requirePermission('inventory','R'), inventoryRoutes)
      app.use('/api/v1/hospital-pnl', authenticateToken, hospitalPnlRoutes)
    `)
    expect(mounts.find((m) => m.prefix === '/api/v1/inventory')).toMatchObject({ module: 'inventory', level: 'R', authed: true, routerVar: 'inventoryRoutes' })
    expect(mounts.find((m) => m.prefix === '/api/v1/hospital-pnl')).toMatchObject({ module: null, level: null, authed: true, routerVar: 'hospitalPnlRoutes' })
  })

  it('前端 registry / permissions 解析（active 路由·NAV_PATH_MODULE·财务特例）', () => {
    const reg = parseRouteRegistry(`
      export const ROUTE_REGISTRY = [
        { path: '/inventory', permModule: 'inventory', status: 'active' },
        { path: '/partner-config', permModule: null, status: 'active' },
        { path: '/abc/trend', permModule: 'slide_cost', status: 'headless', owner:'x', due:'2026-10-07', reason:'y' },
      ]
    `)
    expect(reg.find((e) => e.path === '/inventory')).toMatchObject({ permModule: 'inventory', status: 'active' })
    expect(reg.find((e) => e.path === '/partner-config')).toMatchObject({ permModule: null, status: 'active' })
    const pv = parsePermissionsVisibility(`
      export const NAV_PATH_MODULE = { '/inventory': 'inventory', '/abc/audit': 'abc_dashboard' }
      export function getAccessiblePaths() {
        const paths = ['/']
        if (roles.includes('admin') || roles.includes('finance')) { paths.push('/partner-config', '/import-console') }
        if (roles.includes('admin') || roles.includes('finance')) paths.push('/lis-cases')
        return paths
      }
    `)
    expect(pv.navPathModule['/inventory']).toBe('inventory')
    expect(pv.financeAdminPaths.sort()).toEqual(['/import-console', '/lis-cases', '/partner-config'])
  })

  it('visibleUnder 语义：SPECIAL_ALL 恒可见 · SPECIAL_FINANCE_ADMIN 仅财务/admin · 真实模块看能力', () => {
    expect(visibleUnder(SPECIAL_ALL, 'technician', {}, false)).toBe(true)
    expect(visibleUnder(SPECIAL_FINANCE_ADMIN, 'technician', {}, false)).toBe(false)
    expect(visibleUnder(SPECIAL_FINANCE_ADMIN, 'finance', {}, false)).toBe(true)
    expect(visibleUnder(SPECIAL_FINANCE_ADMIN, 'x', {}, true)).toBe(true) // admin 恒可见
    expect(visibleUnder('inventory', 'x', { inventory: 'R' }, false)).toBe(true)
    expect(visibleUnder('inventory', 'x', {}, false)).toBe(false)
  })

  it('blankComments 词法健全：每个被建模源文件涂白后 EOF 回到 state 0（对抗复核 #4·正则/字符串失步=响亮红非潜伏）', () => {
    const src = loadSourceInputs()
    const feLib = path.join(src.root, '前端代码', 'src', 'lib')
    const beSrc = path.join(src.root, '后端代码', 'server', 'src')
    const files = [
      path.join(feLib, 'route-registry.ts'), path.join(feLib, 'permissions.ts'),
      path.join(beSrc, 'app.ts'), path.join(beSrc, 'middleware', 'authz-combinators.ts'),
      ...fs.readdirSync(src.routesDir).filter((f) => f.endsWith('.ts')).map((f) => path.join(src.routesDir, f)),
    ]
    const desynced = files.filter((f) => lexerEndState(fs.readFileSync(f, 'utf8')) !== 0).map((f) => path.basename(f))
    expect(desynced, `涂白后词法失步(EOF state≠0)·正则/字符串未闭合: ${desynced.join(', ')}`).toEqual([])
    // 涂白幂等 + 不吞行（行数不变·行号可靠）
    const sample = fs.readFileSync(path.join(src.routesDir, 'account-reconcile-v1.1.ts'), 'utf8')
    expect(blankComments(sample).split('\n').length).toBe(sample.split('\n').length)
  })
})
