/**
 * 检查⑤（C5）授权组合子 —— 堵住路由 handler 里的「野生授权逻辑」。
 *
 * 注：C5 是**独立轴**（授权可枚举性），与 C1–C4「功能先于消费者」轴正交（C4=路由↔导航注册表·姊妹 PR）。
 *
 * 迁移序第 1 步（权限影子断言矩阵前置）：授权「条件」必须只经具名组合子/守卫表达
 * （见 后端代码/server/src/middleware/authz-combinators.ts + permissions.ts + auth.ts），
 * 否则散落在 handler 的 `if` 里就无法可靠枚举。本检查把这个不变量机器化：
 *
 *   规则①（角色门）：路由文件 handler 内**禁止对「请求用户」做 .role / .roles 访问**——
 *     含 req.user.role / (req as any).user.roles / 别名（const user = req.user 后 user.role）/
 *     解构（const { role } = req.user）。角色判定必须走 requireAdmin/isAdmin/requireAnyRole 等组合子。
 *     （attribution 只读 .username/.userId，绝不读 .role/.roles → 天然不误伤；
 *      auth.ts 里 user 是 DB 行、非 req.user 别名 → 不在追踪范围、不误伤。）
 *
 *   规则②（SoD 判决）：路由文件**禁止裸写 'SELF_REVIEW_FORBIDDEN' 字面量**——
 *     SoD 自审判决必须由组合子 assertNotSelfReview 发（它持有该错误码的单一事实源）。
 *
 * 零容忍：任一违规即红（无 baseline/棘轮宽容——授权缺口不是可攒的存量债）。run-all.cjs 把它接进
 * fail-closed 治理层（无条件红）。selftest.cjs 用变异 fixture 证「有牙」（植一处野生授权 → 必红）。
 *
 * 只扫 routes/*.ts；注册表文件（middleware/*）天然不在扫描范围（那里才是 .role/SELF_REVIEW_FORBIDDEN 的家）。
 */

const fs = require('fs')
const path = require('path')

const DEFAULT_ROUTES_DIR = path.join(__dirname, '..', '..', '后端代码', 'server', 'src', 'routes')

/**
 * 把注释「涂白」为空格（保留换行 → 行号不变），字符串字面量**保留**（规则② 要在字符串里找字面量）。
 * 状态机识别 // 行注释、/* *​/ 块注释、'…' "…" `…` 字符串（含 \ 转义）。
 */
function blankComments(src) {
  let out = ''
  let i = 0
  const n = src.length
  // state: 0 normal, 1 line-comment, 2 block-comment, 3 single, 4 double, 5 template
  let state = 0
  while (i < n) {
    const c = src[i]
    const c2 = i + 1 < n ? src[i + 1] : ''
    if (state === 0) {
      if (c === '/' && c2 === '/') { out += '  '; i += 2; state = 1; continue }
      if (c === '/' && c2 === '*') { out += '  '; i += 2; state = 2; continue }
      if (c === "'") { out += c; i++; state = 3; continue }
      if (c === '"') { out += c; i++; state = 4; continue }
      if (c === '`') { out += c; i++; state = 5; continue }
      out += c; i++; continue
    }
    if (state === 1) { // line comment
      if (c === '\n') { out += '\n'; i++; state = 0; continue }
      out += ' '; i++; continue
    }
    if (state === 2) { // block comment
      if (c === '*' && c2 === '/') { out += '  '; i += 2; state = 0; continue }
      out += c === '\n' ? '\n' : ' '; i++; continue
    }
    // string states: keep chars, honor escape, exit on matching quote
    if (c === '\\') { out += c + (c2 || ''); i += 2; continue }
    if (state === 3 && c === "'") { out += c; i++; state = 0; continue }
    if (state === 4 && c === '"') { out += c; i++; state = 0; continue }
    if (state === 5 && c === '`') { out += c; i++; state = 0; continue }
    out += c; i++; continue
  }
  return out
}

// 「请求用户」对象的两种字面写法：req.user / (req as any).user（含可选链 ?.）。
const REQ_USER = String.raw`(?:\(\s*req\s+as\s+any\s*\)|req)\s*\??\.\s*user`

/** 收集「= req.user」的本地别名名（const/let/var user = req.user；RHS 恰是 user 对象、其后不再接 .prop）。 */
function collectUserAliases(code) {
  const aliases = new Set()
  const re = new RegExp(
    String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${REQ_USER}\s*(?![.?\w])`,
    'g',
  )
  let m
  while ((m = re.exec(code))) aliases.add(m[1])
  return [...aliases]
}

// 覆盖边界（诚实标注，防「有门禁在自动跑」的假象）：本 lint 是正则/tokenizer 级，闭包覆盖「直接对请求用户
// 做的授权写法」——够堵住 task 要求的变异（if(req.user.role...)）与已知规避（点/可选链/别名/解构/方括号 + 内联身份比对）。
// **不覆盖**：先抽成标量再比对的派生变量（const uid = req.user.userId; if (uid === row.owner)）、经 helper 读角色
// （resolveRequestRoles(req.user).includes('admin')）、capability 数组内联判决。这些属「注册表 + 人工复核」兜底面，
// 不在正则闭包内（要闭合需强制 req.user 唯一访问器，会牵动 ~30 处合法 attribution，超出本 task 结构重构范围）。

/**
 * 扫一份路由源码，返回违规行列表 [{ line, rule, snippet }]。
 * rule: 'role-access'（规则①·角色门）| 'self-review-literal'（规则②·SoD 判决码）| 'identity-compare'（规则③·内联身份比对）。
 */
function scanSource(src) {
  const code = blankComments(src)
  const aliases = collectUserAliases(code)

  // 规则①：req.user / 别名 上的 .role/.roles 访问（点 / 可选链 / 方括号 / 解构）。
  const roleMatchers = [
    new RegExp(String.raw`${REQ_USER}\s*\??\.\s*(?:role|roles)\b`), // req.user.role / (req as any).user?.roles
    new RegExp(String.raw`${REQ_USER}\s*\??\s*\[\s*['"](?:role|roles)['"]\s*\]`), // req.user['role']（方括号规避）
    new RegExp(String.raw`\b(?:const|let|var)\s*\{[^}]*\b(?:role|roles)\b[^}]*\}\s*=\s*${REQ_USER}\b`), // const { role } = req.user
  ]
  // 规则③：请求用户身份字段（userId/username/id）的内联相等比对（=== / !==）——身份型 SoD/归属守卫必须走组合子，
  //   不得在 handler 里裸比对（堵住 `if(row.x === req.user.userId) error(...,'FORBIDDEN',403)` 这类既不读 .role 又不用
  //   SELF_REVIEW_FORBIDDEN 码、对影子矩阵隐形的规避）。
  const idField = String.raw`(?:userId|username|id)`
  const identityMatchers = [
    new RegExp(String.raw`${REQ_USER}\s*\??\.\s*${idField}\s*(?:===|!==)`), // req.user.userId === X
    new RegExp(String.raw`(?:===|!==)\s*${REQ_USER}\s*\??\.\s*${idField}\b`), // X === req.user.username
  ]
  for (const a of aliases) {
    roleMatchers.push(new RegExp(String.raw`\b${a}\s*\??\.\s*(?:role|roles)\b`)) // user.role（别名·点/可选链）
    roleMatchers.push(new RegExp(String.raw`\b${a}\s*\??\s*\[\s*['"](?:role|roles)['"]\s*\]`)) // user['role']（别名·方括号）
    identityMatchers.push(new RegExp(String.raw`\b${a}\s*\??\.\s*${idField}\s*(?:===|!==)`))
    identityMatchers.push(new RegExp(String.raw`(?:===|!==)\s*${a}\s*\??\.\s*${idField}\b`))
  }
  // 规则②：SoD 判决错误码字面量（单/双引号）——注释已被 blankComments 涂白，不误伤迁移注释。
  const selfReviewMatcher = /['"]SELF_REVIEW_FORBIDDEN['"]/

  const lines = code.split('\n')
  const srcLines = src.split('\n')
  const violations = []
  const push = (idx, rule) => violations.push({ line: idx + 1, rule, snippet: (srcLines[idx] || '').trim().slice(0, 160) })
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    if (roleMatchers.some((re) => re.test(line))) push(idx, 'role-access')
    if (identityMatchers.some((re) => re.test(line))) push(idx, 'identity-compare')
    if (selfReviewMatcher.test(line)) push(idx, 'self-review-literal')
  }
  return violations
}

function run(opts = {}) {
  const routesDir = opts.routesDir || process.env.BD_AUTHZ_ROUTES_DIR || DEFAULT_ROUTES_DIR
  let files = []
  try {
    files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.ts')).sort()
  } catch {
    files = []
  }

  const violations = []
  for (const f of files) {
    const abs = path.join(routesDir, f)
    let src
    try { src = fs.readFileSync(abs, 'utf8') } catch { continue }
    for (const v of scanSource(src)) {
      violations.push({ file: `routes/${f}`, line: v.line, rule: v.rule, snippet: v.snippet })
    }
  }

  return {
    id: 'C5',
    title: '授权组合子（野生授权逻辑）',
    intent: '路由 handler 里的授权条件必须经具名组合子表达（禁裸 req.user.role/.roles 与裸 SELF_REVIEW_FORBIDDEN 判决）',
    violations,
    stats: {
      filesScanned: files.length,
      violations: violations.length,
      roleAccess: violations.filter((v) => v.rule === 'role-access').length,
      selfReviewLiteral: violations.filter((v) => v.rule === 'self-review-literal').length,
    },
  }
}

module.exports = { run, scanSource, blankComments, collectUserAliases }
