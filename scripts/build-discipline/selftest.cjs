#!/usr/bin/env node
/**
 * 构建纪律闸 — 自测（守护工具自身不被静默改坏）。
 *
 * 断言一批「已人工核实为真」的已知发现与解析不变量。任何一条断言失败 → exit 1，
 * 让 CI 立刻暴露「解析器坏了/口径漂了」，避免闸变哑（假绿）。
 *
 * 这些期望值随存量处置会变（例如某个幽灵 404 被修掉），届时同步更新本文件——
 * 它是「闸行为」的可执行规格，不是一次性快照。
 */

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const R = require('./lib/registry.cjs')
const c1 = require('./check-frontend-to-backend.cjs')
const c2 = require('./check-backend-consumers.cjs')
const c3 = require('./check-config-engine.cjs')
const c5authz = require('./check-authz-combinators.cjs')
const BG = require('./lib/baseline-governance.cjs')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}\n       ${e.message}`)
  }
}

console.log('构建纪律闸 · 自测')

// ---- 路径归一不变量（防误报的核心）----
check('normalizePath: 模板段 ${id} 归一为 param 段', () => {
  const { segs } = R.normalizePath('/boms/${id}/cost-preview')
  assert.deepStrictEqual(segs, ['boms', ':', 'cost-preview'])
})
check('normalizePath: literal 前缀+动态查询后缀 只取前缀', () => {
  const { segs } = R.normalizePath('/abc/cost-drivers${params.toString() ? "?"+params : ""}')
  assert.deepStrictEqual(segs, ['abc', 'cost-drivers'])
})
check('normalizePath: 去查询串', () => {
  const { segs } = R.normalizePath('/inventory?page=1')
  assert.deepStrictEqual(segs, ['inventory'])
})
check('segsMatch: :param 通配任意单段、段数须相等', () => {
  assert.ok(R.segsMatch(['inbound', ':'], ['inbound', ':']))
  assert.ok(R.segsMatch(['inbound', ':'], ['inbound', 'abc123']))
  assert.ok(!R.segsMatch(['inbound'], ['inbound', ':']))
  assert.ok(!R.segsMatch(['a', 'b'], ['a', 'c']))
})
check('matchCallToEndpoint: method=ANY（动态方法 fetch）匹配任意方法、不错配假幽灵', () => {
  const eps = [{ method: 'PUT', segs: ['abc', 'x', ':'] }, { method: 'GET', segs: ['abc', 'x'] }]
  assert.ok(R.matchCallToEndpoint({ resolvable: true, method: 'ANY', segs: ['abc', 'x', ':'] }, eps))
  assert.ok(!R.matchCallToEndpoint({ resolvable: true, method: 'GET', segs: ['abc', 'x', ':'] }, eps)) // GET 精确：无 GET /abc/x/:id
})

// ---- 解析器覆盖（Finding 1/2/3 加固）----
const { calls } = R.parseFrontendCalls()
check('axios.METHOD(`${BASE_URL}/...`) 被识别（/auth/refresh POST）', () => {
  assert.ok(calls.some((c) => c.kind === 'axios' && c.method === 'POST' && c.relPath === '/auth/refresh'),
    'axios /auth/refresh 未被解析')
})
check('fetch(变量) 回溯赋值解析（const url = `/api/v1/abc/cost-drivers`）', () => {
  assert.ok(calls.some((c) => c.fromVar && c.resolvable && c.relPath === '/abc/cost-drivers'),
    'fetch(url) 未回溯解析出 /abc/cost-drivers')
})
check('无法回溯的 fetch(变量) 不静默：进 C1 unverifiable 供人工过目', () => {
  const r = c1.run()
  assert.ok(r.unverifiable.length >= 1, '应有 unverifiable 动态调用被列出（防藏幽灵）')
})

// ---- C1 前端→后端 ----
const r1 = c1.run()
const ghostPaths = new Set(r1.violations.map((v) => v.method + ' ' + v.path))
// 6 个 reports 幽灵报表端点已由「清理幽灵报表端点」PR 删除（前端 reports.ts 死调用移除）——
// 此处反向守卫：断言它们不再是 C1 幽灵。若哪条复现=有人又加了调无后端路由的报表 api，回归即红。
check('C1: 6 个 reports 幽灵已清理·不再命中（防再引入）', () => {
  for (const p of [
    'GET /reports/cost-by-project-group',
    'GET /reports/full-cost-by-project',
    'GET /reports/cost-structure',
    'GET /reports/cost-variance',
    'GET /reports/cost-monthly-comparison',
    'GET /reports/personnel-efficiency',
  ]) assert.ok(!ghostPaths.has(p), `${p} 应已删除、不再是幽灵（复现=前端又调了无后端路由的报表）`)
})
check('C1: boms/cost-preview / logs/export / users/reset-password 三个真幽灵命中', () => {
  assert.ok(ghostPaths.has('GET /boms/:/cost-preview'), '缺 boms cost-preview')
  assert.ok(ghostPaths.has('GET /logs/export'), '缺 logs/export')
  assert.ok(ghostPaths.has('POST /users/:/reset-password'), '缺 users reset-password')
})
check('C1: 恰好 3 个幽灵（6 个 reports 幽灵已清理·剩 3 存量·无新误报）', () => {
  assert.strictEqual(r1.violations.length, 3, `实际 ${r1.violations.length}`)
})
check('C1: 合法调用不误报（/inventory GET 必须命中，不在违规里）', () => {
  assert.ok(!ghostPaths.has('GET /inventory'))
})

// ---- C2 后端→消费者 ----
const r2 = c2.run({ today: '2026-07-06' })
const viol2 = new Set(r2.violations.map((v) => v.method + ' ' + v.path))
const exempt2 = new Set(r2.exempt.map((v) => v.method + ' ' + v.path))
check('C2: partners 写端点(POST /partners)判为无消费者', () => {
  assert.ok(viol2.has('POST /partners'), '应报 POST /partners 无消费者')
})
check('C2: ngs 整文件被白名单豁免（孵化中，未过期）', () => {
  assert.ok([...exempt2].some((k) => k.includes('/ngs/')), 'ngs 应在白名单豁免里')
})
check('C2: /auth/refresh 不被误报（axios 精确识别 + 文本兜底）', () => {
  assert.ok(!viol2.has('POST /auth/refresh'), '/auth/refresh 不应进违规')
})
check('C2: 文本兜底只用「发请求的文件」（Finding 3：死路由不因页面路由同名被误判消费）', () => {
  // /abc/cost-drivers 仍被消费（其组件确实 fetch），故不在违规里
  assert.ok(!viol2.has('GET /abc/cost-drivers'), '/abc/cost-drivers 有真实 fetch 消费者')
})
check('C2: 精确形状兜底——死的兄弟子路由不因共享前缀被误判消费（HIGH 修复）', () => {
  // endpointCallRegex：param 段要求调用处是 ${...} 插值，且各字面段须齐
  const rx = R.endpointCallRegex('/alerts/:id/handle')
  assert.ok(rx.test('request.post(`/alerts/${id}/handle`)'), '真实动态调用应匹配')
  assert.ok(!rx.test("request.get('/alerts')"), '仅前缀 /alerts 不应匹配子路由 handle')
  assert.ok(!rx.test('request.post(`/alerts/${id}/totally-dead-xyz`)'), '不同尾段不应匹配')
})
check('C2: supplements/:id/approve 现有前端「签发」按钮 → 判为已消费（不再无消费者）', () => {
  // PR #94 补了前端 accountReconcileApi.approve(`/account-reconcile/supplements/${id}/approve`)，
  // maker-checker 审批门从「有后端无前端」解锁为有消费者；精确命中把它从违规里移出
  // （对照 collect/giveup/reopen 同款模板字面量均被识别）。原断言（判无消费者）已随该消费者落地翻转。
  assert.ok(!viol2.has('POST /account-reconcile/supplements/:id/approve'), 'approve 门现有前端消费者，不应再判无消费者')
})
check('C2: 过期 deadline 会翻成违规（注入未来 today）', () => {
  const future = c2.run({ today: '2099-01-01' })
  const fv = new Set(future.violations.map((v) => v.method + ' ' + v.path))
  assert.ok([...fv].some((k) => k.includes('/ngs/')), '2099 年时 ngs 白名单应过期→违规')
})

// ---- C3 配置→引擎 ----
const r3 = c3.run()
const high3 = new Set(r3.violations.map((v) => v.table + '.' + v.column))
check('C3: allocation_base 判为高置信空转（canonical·两种命名都无引擎读）', () => {
  assert.ok(high3.has('indirect_cost_centers.allocation_base'), '缺 allocation_base')
})
check('C3: 纯展示字段(equipment.model)不进高置信', () => {
  assert.ok(!high3.has('equipment.model'), 'equipment.model 不应是高置信')
})
check('C3: camelCase 加固——discount_rate（引擎有 discountRate 同名概念）不再误判高置信', () => {
  assert.ok(!high3.has('case_revenue.discount_rate'), 'discount_rate 有引擎 camelCase 概念，不应高置信')
})

// ---- C5 授权组合子（野生授权逻辑 lint）——变异证「有牙」 + no-false-positive ----
// 授权条件必须只经 middleware/authz-combinators.ts 的具名组合子表达；路由 handler 里的「野生授权」
// （裸读请求用户 .role/.roles、裸写 SoD 判决 SELF_REVIEW_FORBIDDEN）→ 红。这里锁「有牙」（每种野生写法必被捕）
// 与「不误伤」（attribution/注释/DB 行 user.role 不红）。真实 routes/ 零违规由此下方与 E1(exit 0) 双重守。
check('C5: 真实 routes/ 零野生授权（6 处内联已提升进组合子·干净）', () => {
  const r = c5authz.run()
  assert.strictEqual(r.violations.length, 0, `实际 ${r.violations.length}: ${JSON.stringify(r.violations.slice(0, 3))}`)
})
check('C5 变异·规则①：植 if(req.user.role) → role-access 红', () => {
  assert.ok(c5authz.scanSource('router.put("/x",(req,res)=>{ if(req.user.role==="admin"){} })').some((x) => x.rule === 'role-access'),
    'req.user.role 未被捕')
})
check('C5 变异·规则①：(req as any).user.roles / 别名 / 解构 / 可选链 / 方括号 均红（无漏网写法）', () => {
  assert.ok(c5authz.scanSource('if((req as any).user.roles.includes("admin")){}').some((x) => x.rule === 'role-access'), '(req as any).user.roles 漏网')
  assert.ok(c5authz.scanSource('const user=(req as any).user;\nif(user.role!=="admin"){}').some((x) => x.rule === 'role-access'), '别名 user.role 漏网')
  assert.ok(c5authz.scanSource('const {role}=req.user;\nif(role==="admin"){}').some((x) => x.rule === 'role-access'), '解构 {role}=req.user 漏网')
  assert.ok(c5authz.scanSource('const ok=req.user?.roles?.includes("admin");').some((x) => x.rule === 'role-access'), '可选链 req.user?.roles 漏网')
  assert.ok(c5authz.scanSource('if(req.user["role"]==="admin"){}').some((x) => x.rule === 'role-access'), '方括号 req.user["role"] 漏网')
})
check('C5 变异·规则③：内联身份比对（req.user.userId/username === 行字段）→ identity-compare 红（堵 FORBIDDEN-码 SoD 规避）', () => {
  assert.ok(c5authz.scanSource('if(row.submitted_by===req.user.userId){error(res,"x","FORBIDDEN",403)}').some((x) => x.rule === 'identity-compare'), '正向 req.user.userId=== 漏网')
  assert.ok(c5authz.scanSource('if(req.user.username!==row.op){}').some((x) => x.rule === 'identity-compare'), '反向 req.user.username!== 漏网')
  assert.ok(c5authz.scanSource('const u=req.user;\nif(u.userId===row.x){}').some((x) => x.rule === 'identity-compare'), '别名身份比对漏网')
})
check('C5 变异·规则②：植 error(res,x,SELF_REVIEW_FORBIDDEN,403) → self-review-literal 红', () => {
  assert.ok(c5authz.scanSource('error(res,"x","SELF_REVIEW_FORBIDDEN",403)').some((x) => x.rule === 'self-review-literal'),
    'SELF_REVIEW_FORBIDDEN 字面量未被捕')
})
// no-false-positive：镜像真实 routes/ 语料里合法的非-actor .role/.roles/身份读，证「不误伤」（fail-closed 检查最怕误报）。
check('C5 no-false-positive：attribution / 注释 / 尾注 / DB 行 / req.body 数据对象 均不红', () => {
  assert.strictEqual(c5authz.scanSource('const operator=req.user?.username??req.user?.userId??"unknown";').length, 0, 'attribution username(??) 误报')
  assert.strictEqual(c5authz.scanSource('const userId=(req as any).user?.userId').length, 0, 'attribution userId(赋值) 误报')
  assert.strictEqual(c5authz.scanSource('// old: if(req.user.role==="admin")\nconst x=1').length, 0, '整行注释里的 req.user.role 误报')
  assert.strictEqual(c5authz.scanSource('doThing(); // 见 req.user.role 与 SELF_REVIEW_FORBIDDEN 迁移说明').length, 0, '尾注里的 token 误报（trailing //）')
  assert.strictEqual(c5authz.scanSource('/* 块注释 req.user.role SELF_REVIEW_FORBIDDEN */\nconst z=1').length, 0, '块注释里的 token 误报')
  assert.strictEqual(c5authz.scanSource('const user=db.prepare("...").get(id);\nconst r=user.role;').length, 0, 'auth.ts 式 DB 行 user.role 误报（非 req.user 别名）')
  assert.strictEqual(c5authz.scanSource('const data=req.body;\nif(Array.isArray(data.roles)){ data.role }').length, 0, 'users.ts 式 req.body data.role/data.roles 误报')
})

// ================= Fail-closed 治理层（P-5/P-6）—— 变异断言证「有牙」 =================
// 核心：闸的旁路口（白名单/baseline 赦免簿）自己不能 fail-open。每条断言临时构造一个坏输入，
// 断言校验器把它判红；同时锁「现有真实条目不被新规误伤」（no-false-positive）。

// ⚠️ TODAY 故意钉死值（非真实 today）：这些是**确定性 no-false-positive 控制断言**——证「规则不误伤
//    合法结构」，不是证「债到期该红」（后者是真 gate 用 new Date() 真实 today 做的、且是 intended，见下方
//    exit-code 端到端 E-* 用例才用真实 today）。别把 TODAY 参数化成真实 today，否则会随日期变成定时炸弹。
const TODAY = '2026-07-06' // 与 C2 注入 today 同口径

// ---- A. 白名单 fail-closed（validateWhitelist）----
check('A1 变异·缺 deadline → 判红（缺省方向反转：忘填=已过期）', () => {
  const errs = c2.validateWhitelist([{ path: '/x/*', method: '*', owner: 'o' }], TODAY)
  assert.ok(errs.some((e) => e.type === 'missing-deadline'), '无 deadline 条目应报 missing-deadline')
})
check('A2 变异·deadline 超上限（2099）→ 判红', () => {
  const errs = c2.validateWhitelist([{ path: '/x/*', method: '*', owner: 'o', deadline: '2099-01-01' }], TODAY)
  assert.ok(errs.some((e) => e.type === 'deadline-too-far'), '2099 deadline 应报 deadline-too-far')
})
check('A3 变异·deadline 格式坏 → 判红', () => {
  const errs = c2.validateWhitelist([{ path: '/x/*', method: '*', owner: 'o', deadline: 'soon' }], TODAY)
  assert.ok(errs.some((e) => e.type === 'bad-deadline-format'), '坏格式 deadline 应报 bad-deadline-format')
})
check('A4 变异·条数超上限 → 判红', () => {
  const many = Array.from({ length: c2.MAX_WHITELIST_ENTRIES + 1 }, (_, i) => ({ path: `/x${i}/*`, method: '*', owner: 'o', deadline: '2026-08-01' }))
  const errs = c2.validateWhitelist(many, TODAY)
  assert.ok(errs.some((e) => e.type === 'too-many-entries'), `${many.length} 条应报 too-many-entries`)
})
check('A5 no-false-positive·现有真实白名单（都带合法 deadline）不被新规误伤', () => {
  const errs = c2.validateWhitelist(c2.loadWhitelist(), TODAY)
  assert.strictEqual(errs.length, 0, `现有白名单应零结构错误，实际：${JSON.stringify(errs)}`)
})
check('A6 no-false-positive·现有真实白名单条数 ≤ 上限', () => {
  assert.ok(c2.loadWhitelist().length <= c2.MAX_WHITELIST_ENTRIES, '现有白名单条数应在上限内')
})
check('A7 端点级变异·合法 deadline 条目豁免其端点（对照组）', () => {
  const r = c2.run({ today: TODAY, whitelist: [{ path: '/partners', method: 'POST', owner: 'x', deadline: '2026-09-01' }] })
  const viol = new Set(r.violations.map((v) => v.method + ' ' + v.path))
  assert.ok(!viol.has('POST /partners'), '合法白名单应把 POST /partners 移出违规（豁免）')
  assert.strictEqual(r.hardFail, false, '合法白名单 hardFail 应为 false')
})
check('A8 端点级变异·缺 deadline 条目不豁免其端点 + hardFail（fail-closed 核心）', () => {
  const r = c2.run({ today: TODAY, whitelist: [{ path: '/partners', method: 'POST', owner: 'x' /* 无 deadline */ }] })
  const viol = new Set(r.violations.map((v) => v.method + ' ' + v.path))
  assert.ok(viol.has('POST /partners'), '无 deadline 白名单不得豁免 POST /partners（旁路口必须堵上）')
  assert.strictEqual(r.hardFail, true, '结构错误应触发 hardFail=true')
})
check('A9 real run 不 hardFail·现有真实白名单结构健康', () => {
  const r = c2.run({ today: TODAY })
  assert.strictEqual(r.hardFail, false, '现有白名单不应触发 hardFail')
})

// ---- B. baseline 治理 fail-closed（baseline-governance）----
check('B1.1 变异·baseline meta 死线过期 → 判红', () => {
  const doc = { keys: ['C1|GET|/x'], meta: { 'C1|GET|/x': { owner: 'o', deadline: '2020-01-01' } } }
  const errs = BG.validateBaselineMeta(doc, TODAY)
  assert.ok(errs.some((e) => e.type === 'expired' && e.key === 'C1|GET|/x'), '过期 meta 死线应报 expired')
})
check('B1.2 对照·baseline meta 死线未过 → 不红', () => {
  const doc = { keys: ['C1|GET|/x'], meta: { 'C1|GET|/x': { owner: 'o', deadline: '2026-09-01' } } }
  assert.strictEqual(BG.validateBaselineMeta(doc, TODAY).length, 0, '未过期 meta 不应报错')
})
check('B1.3 变异·baseline meta 缺 deadline → 判红', () => {
  const doc = { keys: ['C1|GET|/x'], meta: { 'C1|GET|/x': { owner: 'o' } } }
  assert.ok(BG.validateBaselineMeta(doc, TODAY).some((e) => e.type === 'missing-deadline'), '缺 deadline 应报 missing-deadline')
})
check('B1.4 变异·悬空 meta（键不在 keys 里）→ 判红', () => {
  const doc = { keys: ['C1|GET|/x'], meta: { 'C1|GET|/gone': { owner: 'o', deadline: '2026-09-01' } } }
  assert.ok(BG.validateBaselineMeta(doc, TODAY).some((e) => e.type === 'orphan-meta'), '悬空 meta 应报 orphan-meta')
})
check('B1.5 变异·净条数越天花板 → 判红', () => {
  assert.ok(BG.checkBaselineCap({ keys: ['a', 'b', 'c'], targetMaxCount: 2 }), '3 条 > 天花板 2 应报 over-cap')
})
check('B1.6 对照·净条数不越天花板 → 不红', () => {
  assert.strictEqual(BG.checkBaselineCap({ keys: ['a', 'b'], targetMaxCount: 2 }), null, '2 条 = 天花板 2 不应报错')
})
check('B1.7 变异·非空 baseline 缺 targetMaxCount → 判红（fail-closed：堵「删字段=取消封顶」旁路口）', () => {
  const err = BG.checkBaselineCap({ keys: ['a', 'b'] })
  assert.ok(err && err.type === 'missing-cap', '有存量却无天花板应报 missing-cap')
})
check('B1.8 对照·空 baseline 无 targetMaxCount → 不红（零存量无需天花板）', () => {
  assert.strictEqual(BG.checkBaselineCap({ keys: [] }), null, '零存量不应报 missing-cap')
})
check('B8 常量单一事实源·两模块 MAX_DEADLINE_HORIZON_DAYS 恒等（防两处漂移）', () => {
  assert.strictEqual(c2.MAX_DEADLINE_HORIZON_DAYS, BG.MAX_DEADLINE_HORIZON_DAYS, '白名单与 baseline 死线上限须同值（收口 lib/constants.cjs）')
})
check('B2.1 变异·被消费端点赖在 C2 死物名单 → 判红', () => {
  const doc = { keys: ['C2|GET|/foo'] }
  const bad = BG.consumedInDeadAmnesty(doc, new Set(['GET|/foo']))
  assert.ok(bad.some((e) => e.key === 'C2|GET|/foo'), '被消费的 C2 键应报 consumed-in-dead-amnesty')
})
check('B2.2 对照·未被消费的 C2 键不误报', () => {
  const doc = { keys: ['C2|GET|/foo'] }
  assert.strictEqual(BG.consumedInDeadAmnesty(doc, new Set([])).length, 0, '未消费端点不应报 B.2')
})

// ---- 真实 baseline.json：既守死线有牙，又不误伤（no-false-positive）----
const realBaseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'baseline.json'), 'utf8'))
const realConsumed = new Set((c2.run({ today: TODAY }).consumedKeys) || [])
check('B-real·当前真实 baseline 今日健康（死线未过 + 不越天花板 + 无被依赖者赖名单）', () => {
  const errs = BG.validateBaseline(realBaseline, TODAY, realConsumed)
  assert.strictEqual(errs.length, 0, `真实 baseline 今日应零治理错误，实际：${JSON.stringify(errs)}`)
})
// 原「live-404 死线到期会红」测试改为清理后的快照守卫：那 2 条 live-404（personnel-efficiency /
// cost-monthly-comparison）已由「清理幽灵报表端点」PR 处置（前端死调用删除 + --update-baseline 清出
// keys/meta）→ 真实 baseline 现无这批 reports 幽灵键、也无对应 per-entry 死线 meta。此处守其不回归。
// 死线机制本身的牙仍由下方 fixture 用例 E2「baseline 死线过期 → exit 1」守住，无需在真实 baseline 上重证。
check('B-real·6 个 reports 幽灵键 + 2 条 live-404 死线 meta 已从真实 baseline 清出（防回归）', () => {
  const reportKeys = realBaseline.keys.filter((k) => k.startsWith('C1|GET|/reports/'))
  assert.strictEqual(reportKeys.length, 0, `reports 幽灵键应已清出，实际残留：${JSON.stringify(reportKeys)}`)
  const meta = realBaseline.meta || {}
  assert.ok(!meta['C1|GET|/reports/personnel-efficiency'], 'personnel-efficiency 死线 meta 应已剪除')
  assert.ok(!meta['C1|GET|/reports/cost-monthly-comparison'], 'cost-monthly-comparison 死线 meta 应已剪除')
})
check('B-real·targetMaxCount 与实际条数对齐（防基线悄悄膨胀）', () => {
  assert.ok(realBaseline.keys.length <= realBaseline.targetMaxCount, `keys ${realBaseline.keys.length} 应 ≤ targetMaxCount ${realBaseline.targetMaxCount}`)
})

// ================= run-all.cjs exit-code 端到端（「最后一公里」接线·独立复核逮到的覆盖缺口）=================
// 上面的断言只测纯校验器；下面用 spawnSync 真跑 run-all.cjs 断 exit code，锁「govErrors→exit1 / refuse→exit2 /
// 健康→exit0」这段接线不被静默改回。fixture 走 BD_BASELINE_PATH / BD_WHITELIST_PATH 注入临时目录，
// 不污染仓库文件；用**真实 today**（run-all 用 new Date()），故 fixture 死线用 addDays(真today, N) 保持日期健壮。
const RUN_ALL = path.join(__dirname, 'run-all.cjs')
const REAL_TODAY = new Date().toISOString().slice(0, 10)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-selftest-'))
function fixture(name, obj) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
  return p
}
function runGate(argv, env) {
  const r = cp.spawnSync(process.execPath, [RUN_ALL, ...argv], { env: { ...process.env, ...env }, encoding: 'utf8' })
  if (r.error) throw r.error
  return r.status
}
const healthyBaseline = { keys: ['C1|GET|/x'], targetMaxCount: 1, meta: { 'C1|GET|/x': { owner: 't', deadline: BG.addDays(REAL_TODAY, 30) } } }

try {
  check('E1 exit-code·健康 baseline + warn 模式 → exit 0', () => {
    const bp = fixture('healthy.json', healthyBaseline)
    assert.strictEqual(runGate([], { BD_BASELINE_PATH: bp }), 0)
  })
  check('E2 exit-code·baseline 死线过期 → 无条件 exit 1（warn 模式也红）', () => {
    const bp = fixture('expired.json', { keys: ['C1|GET|/x'], targetMaxCount: 1, meta: { 'C1|GET|/x': { owner: 't', deadline: '2020-01-01' } } })
    assert.strictEqual(runGate([], { BD_BASELINE_PATH: bp }), 1)
  })
  check('E3 exit-code·越天花板 → exit 1', () => {
    const bp = fixture('overcap.json', { keys: ['a', 'b', 'c'], targetMaxCount: 1 })
    assert.strictEqual(runGate([], { BD_BASELINE_PATH: bp }), 1)
  })
  check('E4 exit-code·非空 baseline 缺天花板 → exit 1（fail-closed 缺省=红）', () => {
    const bp = fixture('nocap.json', { keys: ['C1|GET|/x'] })
    assert.strictEqual(runGate([], { BD_BASELINE_PATH: bp }), 1)
  })
  check('E5 exit-code·坏白名单(缺 deadline) → 无条件 exit 1', () => {
    const bp = fixture('h2.json', healthyBaseline)
    const wp = fixture('badwl.json', { entries: [{ path: '/x/*', method: '*', owner: 't' }] })
    assert.strictEqual(runGate([], { BD_BASELINE_PATH: bp, BD_WHITELIST_PATH: wp }), 1)
  })
  check('E6 exit-code·坏白名单 + --only=C1 也红（治理不受 --only 豁免·旁路口已堵）', () => {
    const bp = fixture('h3.json', healthyBaseline)
    const wp = fixture('badwl2.json', { entries: [{ path: '/x/*', method: '*', owner: 't' }] })
    assert.strictEqual(runGate(['--only=C1'], { BD_BASELINE_PATH: bp, BD_WHITELIST_PATH: wp }), 1)
  })
  check('E7 exit-code·--update-baseline 遇坏白名单 → 拒绝 exit 2（不可洗白）', () => {
    const bp = fixture('h4.json', healthyBaseline)
    const wp = fixture('badwl3.json', { entries: [{ path: '/x/*', method: '*', owner: 't' }] })
    assert.strictEqual(runGate(['--update-baseline'], { BD_BASELINE_PATH: bp, BD_WHITELIST_PATH: wp }), 2)
  })
  check('E8 exit-code·--update-baseline 与 --only 同用 → 拒绝 exit 2（防局部快照截断基线）', () => {
    const bp = fixture('h5.json', healthyBaseline)
    assert.strictEqual(runGate(['--update-baseline', '--only=C1'], { BD_BASELINE_PATH: bp }), 2)
  })
  check('E9 exit-code·死锁已解·过期 meta 指向「已修(非现违规)」的键 → --update-baseline 放行 exit 0', () => {
    // 键不是任何真实当前违规 → --update-baseline 重算后掉出 → meta 剪掉 → 新 doc 干净 → 放行（旧版会被旧 doc 过期 meta 死锁）
    const bp = fixture('deadlock-ok.json', { keys: ['C1|GET|/fixture-ghost-not-real'], targetMaxCount: 100, meta: { 'C1|GET|/fixture-ghost-not-real': { owner: 't', deadline: '2020-01-01' } } })
    assert.strictEqual(runGate(['--update-baseline'], { BD_BASELINE_PATH: bp }), 0)
  })
  check('E10 exit-code·仍未修·过期 meta 指向真实现违规键 → --update-baseline 照拒 exit 2（fail-closed 不破）', () => {
    // /logs/export 是真实 C1 幽灵（存量）→ --update-baseline 重算后仍在 keys → meta 仍过期 → 拒。
    // （原用 /reports/personnel-efficiency，已随「清理幽灵报表端点」删除、不再是现违规，故换存量幽灵 /logs/export）
    const bp = fixture('deadlock-blocked.json', { keys: ['C1|GET|/logs/export'], targetMaxCount: 100, meta: { 'C1|GET|/logs/export': { owner: 't', deadline: '2020-01-01' } } })
    assert.strictEqual(runGate(['--update-baseline'], { BD_BASELINE_PATH: bp }), 2)
  })
  check('E14 exit-code·C5 野生授权（注入 temp routes 的 req.user.role）→ 无条件 exit 1（warn 模式也红·fail-closed 公理一）', () => {
    // BD_AUTHZ_ROUTES_DIR 把 C5 的扫描目标指到临时目录（同 BD_BASELINE_PATH 注入手法）——证「C5 已接进 run-all
    // 的 fail-closed 层」：一处野生授权即无条件红，且不受 --block/baseline 影响（这里 warn 模式无 --block 仍红）。
    const rdir = path.join(TMP, 'wild-routes')
    fs.mkdirSync(rdir, { recursive: true })
    fs.writeFileSync(path.join(rdir, 'evil-v1.1.ts'), 'router.put("/x",(req,res)=>{ if(req.user.role==="admin"){} })\n')
    const bp = fixture('h-c4.json', healthyBaseline)
    assert.strictEqual(runGate([], { BD_BASELINE_PATH: bp, BD_AUTHZ_ROUTES_DIR: rdir }), 1)
  })
  check('E15 exit-code·C5 干净 temp routes（无野生授权）不误红 → exit 0（no-false-positive 端到端）', () => {
    const rdir = path.join(TMP, 'clean-routes')
    fs.mkdirSync(rdir, { recursive: true })
    fs.writeFileSync(path.join(rdir, 'ok-v1.1.ts'), 'const operator=req.user?.username??"unknown";\nsuccess(res,{operator})\n')
    const bp = fixture('h-c4-clean.json', healthyBaseline)
    assert.strictEqual(runGate([], { BD_BASELINE_PATH: bp, BD_AUTHZ_ROUTES_DIR: rdir }), 0)
  })
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 条失败。`)
process.exit(failures ? 1 : 0)
