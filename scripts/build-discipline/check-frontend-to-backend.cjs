/**
 * 检查① 前端→后端：每条前端 API 调用必须命中一个已注册后端路由，否则=幽灵 404。
 *
 * 防误报：
 *  - 非 '/' 开头的拼接路径 / 无法回溯的动态 fetch(变量) → 标 unresolvable、不当违规。
 *    但**不再静默**：这些进 `unverifiable` 列表由 run-all 打印，供人工过目（堵住"动态 fetch 藏幽灵"的逃逸口）。
 *  - 模板串 `${id}` 归一为 param 段、`cost-drivers${query}` 只取 literal 前缀（见 registry.normalizePath）。
 *  - fetch(变量) 尽量回溯同函数前若干行的 `const 变量 = \`...\`` 赋值解析；动态方法记 'ANY' 匹配任意方法。
 */

const fs = require('fs')
const R = require('./lib/registry.cjs')

/**
 * 仅供 selftest 注入一组完全合成的 {calls,endpoints}，让 run-all 的 C1 最后一公里
 * 不依赖真实仓库里恰好存在一个幽灵端点。坏/缺字段 fixture 直接抛错，保持 fail-closed。
 */
function loadSelftestFixture() {
  const fixturePath = process.env.BD_C1_FIXTURE_PATH
  if (!fixturePath) return null
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  if (!fixture || !Array.isArray(fixture.calls) || !Array.isArray(fixture.endpoints)) {
    throw new Error('BD_C1_FIXTURE_PATH 必须指向含 calls/endpoints 数组的 JSON fixture')
  }
  return fixture
}

function run() {
  const fixture = loadSelftestFixture()
  const endpoints = fixture ? fixture.endpoints : R.buildBackendRegistry().endpoints
  const calls = fixture ? fixture.calls : R.parseFrontendCalls().calls

  const violations = []
  let matched = 0
  const unverifiable = calls
    .filter((c) => !c.resolvable)
    .map((c) => ({ file: c.file, line: c.line, rawPath: c.rawPath, kind: c.kind }))

  for (const call of calls) {
    if (!call.resolvable) continue
    const hit = R.matchCallToEndpoint(call, endpoints)
    if (hit) {
      matched++
    } else {
      violations.push({
        file: call.file, // 已是项目相对路径
        line: call.line,
        method: call.method,
        path: call.relPath,
        kind: call.kind,
        fromVar: !!call.fromVar,
      })
    }
  }

  return {
    id: 'C1',
    title: '前端→后端（幽灵 404）',
    intent: '每条前端 API 调用必须命中已注册后端路由',
    violations,
    unverifiable,
    stats: {
      totalCalls: calls.length,
      resolvable: calls.filter((c) => c.resolvable).length,
      matched,
      ghost: violations.length,
      unverifiableDynamic: unverifiable.length,
    },
  }
}

module.exports = { run }
