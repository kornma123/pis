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
const R = require('./lib/registry.cjs')
const c1 = require('./check-frontend-to-backend.cjs')
const c2 = require('./check-backend-consumers.cjs')
const c3 = require('./check-config-engine.cjs')

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
check('C1: 6 个 reports 幽灵方法全部命中', () => {
  for (const p of [
    'GET /reports/cost-by-project-group',
    'GET /reports/full-cost-by-project',
    'GET /reports/cost-structure',
    'GET /reports/cost-variance',
    'GET /reports/cost-monthly-comparison',
    'GET /reports/personnel-efficiency',
  ]) assert.ok(ghostPaths.has(p), `缺 ${p}`)
})
check('C1: boms/cost-preview / logs/export / users/reset-password 三个真幽灵命中', () => {
  assert.ok(ghostPaths.has('GET /boms/:/cost-preview'), '缺 boms cost-preview')
  assert.ok(ghostPaths.has('GET /logs/export'), '缺 logs/export')
  assert.ok(ghostPaths.has('POST /users/:/reset-password'), '缺 users reset-password')
})
check('C1: 恰好 9 个幽灵（加固后不多不少、无新误报）', () => {
  assert.strictEqual(r1.violations.length, 9, `实际 ${r1.violations.length}`)
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

console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 条失败。`)
process.exit(failures ? 1 : 0)
