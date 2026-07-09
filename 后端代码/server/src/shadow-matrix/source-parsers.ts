/**
 * 权限影子断言矩阵 —— 源码静态解析器（把三份源解析成矩阵输入）。
 *
 * 为什么静态解析而非运行时抽守卫：requirePermission('x','R') 在运行时是**匿名闭包**
 *   （probe 实证 layer.handle.name==''），运行时链上读不出 module/level；且 SoD/口径门
 *   （assertNotSelfReview / assertCaliberChangeAllowed）是**handler 内调用**、根本不在中间件链上。
 *   静态解析源码反而两者都看得见（字面量 + handler 体内组合子），且**不改任何源文件**（纯读）。
 *
 * 端点**集合**仍以**运行时**为地面真相（route-introspect.ts）——静态解析只提供每端点的守卫**语义**。
 *   运行时有某端点、静态解析不出守卫 → 该端点落 UNGUARDED / 解析缺口（fail-closed·响亮报错，非静默假绿）。
 *
 * 覆盖边界（诚实标注·防「有门禁在自动跑」的假象）：本解析是 tokenizer/正则级——
 *   够覆盖本仓已在用的守卫写法（挂载层 requirePermission、路由中间件 requirePermission/requireAnyRole/
 *   requireAdmin、const 别名、handler 内 assertNotSelfReview/assertCaliberChangeAllowed）。
 *   **不覆盖**：跨文件 re-export 的守卫工厂、把守卫塞进数组 spread 的写法、运行时动态构造的守卫。
 *   这类若出现 → 该端点静态抽不出守卫 → 落 UNGUARDED（fail-closed 待裁），不会静默放行。
 */

// ── 注释涂白（保留字符串·保留行号）——移植自 check-authz-combinators.cjs 的状态机 ──
//   ⚠️ 含**正则字面量词法态**（对抗复核 #4）：无它则 `/[",\n\r]/` 内的引号被误当字符串定界符 →
//   状态机失步、EOF 落在字符串/模板态、尾部注释不被涂白（abc-v1.1.ts:339 实测触发）。正则内容涂白成空格
//   （正则非守卫·涂白防其内容误配 requirePermission 正则），故其内引号/括号不再干扰下游 extractBalanced。
const REGEX_PREV = new Set(['', '(', '[', '{', ',', ';', '=', ':', '?', '!', '&', '|', '+', '-', '*', '%', '^', '~', '<', '>', '\n'])
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case'])

/** 词法扫描：返回涂白结果 + EOF 时的状态（0=干净·非 0=失步·自测用）。state：0 normal,1 line,2 block,3 single,4 double,5 template,6 regex。 */
function lexScan(src: string): { out: string; endState: number } {
  let out = ''
  let i = 0
  const n = src.length
  let state = 0
  let prevCode = '' // state 0 里最后一个非空有意义字符
  let prevWord = '' // state 0 里最后一个完成的标识符 token
  let curWord = ''
  let reInClass = false // 正则 [...] 字符类内（内部 '/' 不结束正则）
  const bumpCode = (c: string) => {
    if (/\s/.test(c)) { if (curWord) { prevWord = curWord; curWord = '' } return }
    prevCode = c
    if (/[\w$]/.test(c)) curWord += c
    else { if (curWord) prevWord = curWord; curWord = '' }
  }
  while (i < n) {
    const c = src[i]
    const c2 = i + 1 < n ? src[i + 1] : ''
    if (state === 0) {
      if (c === '/' && c2 === '/') { out += '  '; i += 2; state = 1; continue }
      if (c === '/' && c2 === '*') { out += '  '; i += 2; state = 2; continue }
      if (c === '/') {
        const isRegex = REGEX_PREV.has(prevCode) || (/[\w$]/.test(prevCode) && REGEX_KEYWORDS.has(prevWord))
        if (isRegex) { out += ' '; i++; state = 6; reInClass = false; curWord = ''; continue }
        out += c; i++; bumpCode('/'); continue // 除法运算符
      }
      if (c === "'") { out += c; i++; state = 3; continue }
      if (c === '"') { out += c; i++; state = 4; continue }
      if (c === '`') { out += c; i++; state = 5; continue }
      out += c; i++; bumpCode(c); continue
    }
    if (state === 1) { if (c === '\n') { out += '\n'; i++; state = 0; continue } out += ' '; i++; continue }
    if (state === 2) { if (c === '*' && c2 === '/') { out += '  '; i += 2; state = 0; continue } out += c === '\n' ? '\n' : ' '; i++; continue }
    if (state === 6) { // 正则字面量：涂白内容·处理转义/字符类·未转义 '/'（非字符类内）收尾 + 跳 flags
      if (c === '\\') { out += ' '; if (c2) out += c2 === '\n' ? '\n' : ' '; i += c2 ? 2 : 1; continue }
      if (c === '[') { reInClass = true; out += ' '; i++; continue }
      if (c === ']') { reInClass = false; out += ' '; i++; continue }
      if (c === '/' && !reInClass) {
        out += ' '; i++
        while (i < n && /[a-z]/i.test(src[i])) { out += ' '; i++ } // flags
        state = 0; prevCode = 'r'; prevWord = ''; continue // 正则是值 → 后续 '/' 视作除法
      }
      out += c === '\n' ? '\n' : ' '; i++; continue
    }
    // 字符串态 3/4/5：保留内容（供解析路径/模块字面量），处理转义
    if (c === '\\') { out += c + (c2 || ''); i += 2; continue }
    if (state === 3 && c === "'") { out += c; i++; state = 0; prevCode = "'"; continue }
    if (state === 4 && c === '"') { out += c; i++; state = 0; prevCode = '"'; continue }
    if (state === 5 && c === '`') { out += c; i++; state = 0; prevCode = '`'; continue }
    out += c; i++; continue
  }
  return { out, endState: state }
}

export function blankComments(src: string): string {
  return lexScan(src).out
}

/** EOF 词法状态（0=干净）。自测断言每个被建模源文件涂白后回 0——把正则/字符串失步变成响亮红，非潜伏。 */
export function lexerEndState(src: string): number {
  return lexScan(src).endState
}

/** 抽字符串感知、括号配平的 `(...)` / `{...}` 块。open/close 指定括号种类。返回 [start,endInclusive] 段文本。 */
function extractBalanced(src: string, startIdx: number, open: string, close: string): { text: string; end: number } | null {
  let depth = 0
  let inStr: string | null = null
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') { i++; continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) return { text: src.slice(startIdx, i + 1), end: i } }
  }
  return null
}

/** 顶层逗号切分（尊重括号/方括号/花括号/字符串嵌套）。用于切 router.METHOD(...) 的参数列表。 */
function splitTopLevelCommas(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inStr: string | null = null
  let cur = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (inStr) {
      cur += c
      if (c === '\\') { if (i + 1 < inner.length) { cur += inner[i + 1]; i++ } continue }
      if (c === inStr) inStr = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; cur += c; continue }
    if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue }
    if (c === ')' || c === ']' || c === '}') { depth--; cur += c; continue }
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

// ── 路径归一（两侧共用·保证运行时键 == 静态键）──
export function normalizePath(p: string): string {
  let out = ('/' + p).replace(/\/{2,}/g, '/')
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}
export function joinPath(prefix: string, rel: string): string {
  return normalizePath(prefix + '/' + rel)
}

// ============================================================================
// 前端：route-registry.ts —— active 路由 + permModule
// ============================================================================
export interface RegistryEntry { path: string; permModule: string | null; status: string }

export function parseRouteRegistry(src: string): RegistryEntry[] {
  const code = blankComments(src)
  const entries: RegistryEntry[] = []
  // 逐个 { ... } 块，取同时含 quoted path: 与 status: 的（与 check-route-nav.cjs 同口径）。
  let i = 0
  while (i < code.length) {
    if (code[i] !== '{') { i++; continue }
    const blk = extractBalanced(code, i, '{', '}')
    if (!blk) break
    const t = blk.text
    i = blk.end + 1
    if (!/\bpath:\s*'/.test(t) || !/\bstatus:\s*'/.test(t)) continue
    const path = /\bpath:\s*'([^']*)'/.exec(t)?.[1]
    if (!path) continue
    const status = /\bstatus:\s*'([^']*)'/.exec(t)?.[1] ?? ''
    let permModule: string | null = null
    const pm = /\bpermModule:\s*'([^']*)'/.exec(t)
    if (pm) permModule = pm[1]
    else if (/\bpermModule:\s*null\b/.test(t)) permModule = null
    entries.push({ path, permModule, status })
  }
  return entries
}

// ============================================================================
// 前端：permissions.ts —— NAV_PATH_MODULE + getAccessiblePaths 的角色特例
// ============================================================================
export interface PermissionsVisibility {
  navPathModule: Record<string, string>
  /** 在 getAccessiblePaths 里按 admin/finance 角色 push 的路径（导入器三页 + LIS）。 */
  financeAdminPaths: string[]
  /** 恒可见路径（'/' 仪表盘）。 */
  alwaysPaths: string[]
}

export function parsePermissionsVisibility(src: string): PermissionsVisibility {
  const code = blankComments(src)
  const navPathModule: Record<string, string> = {}
  // NAV_PATH_MODULE 对象体
  const objStart = code.indexOf('NAV_PATH_MODULE')
  if (objStart >= 0) {
    const brace = code.indexOf('{', objStart)
    const blk = brace >= 0 ? extractBalanced(code, brace, '{', '}') : null
    if (blk) {
      const re = /'([^']+)'\s*:\s*'([^']+)'/g
      let m
      while ((m = re.exec(blk.text))) navPathModule[m[1]] = m[2]
    }
  }
  // getAccessiblePaths 里 `paths.push('/x', ...)` 且处于 admin/finance 角色分支的路径。
  // 稳健起见：抓函数体内所有 push 到含 'partner-config'/'import-console'/'import-wizard'/'lis-cases' 的字面量。
  const financeAdminPaths = new Set<string>()
  const gap = code.indexOf('getAccessiblePaths')
  const gapBrace = gap >= 0 ? code.indexOf('{', gap) : -1
  const gapBlk = gapBrace >= 0 ? extractBalanced(code, gapBrace, '{', '}') : null
  if (gapBlk) {
    const pushRe = /paths\.push\(([^)]*)\)/g
    let m
    while ((m = pushRe.exec(gapBlk.text))) {
      const args = m[1]
      // 只收「非恒可见」的 push（即在角色判断分支内 push 的）——用字面量集合识别导入器/LIS。
      const litRe = /'([^']+)'/g
      let lm
      while ((lm = litRe.exec(args))) {
        const p = lm[1]
        if (p !== '/') financeAdminPaths.add(p)
      }
    }
  }
  return { navPathModule, financeAdminPaths: [...financeAdminPaths].sort(), alwaysPaths: ['/'] }
}

// ============================================================================
// 后端：app.ts 挂载层守卫 —— prefix → {module, level} | null（无挂载守卫）
// ============================================================================
export interface MountGuard { prefix: string; module: string | null; level: Level | null; authed: boolean; routerVar: string | null }
type Level = 'R' | 'W'

/** 解析 app.ts 的路由 import：`import xxxRoutes from './routes/inventory-v1.1.js'` → { xxxRoutes: 'inventory-v1.1' }。 */
export function parseAppImports(src: string): Record<string, string> {
  const code = blankComments(src)
  const out: Record<string, string> = {}
  const re = /import\s+([A-Za-z_$][\w$]*)\s+from\s+'\.\/routes\/([^']+?)(?:\.js)?'/g
  let m
  while ((m = re.exec(code))) out[m[1]] = m[2]
  return out
}

export function parseAppMounts(src: string): MountGuard[] {
  const code = blankComments(src)
  const mounts: MountGuard[] = []
  // app.use('/api/v1/xxx', ...args)
  const re = /app\.use\(\s*'([^']+)'\s*,/g
  let m
  while ((m = re.exec(code))) {
    const prefix = m[1]
    if (!prefix.startsWith('/api')) continue
    // 取整个 app.use( 的参数区（可能跨行·用括号配平）
    const openIdx = code.indexOf('(', m.index)
    const blk = openIdx >= 0 ? extractBalanced(code, openIdx, '(', ')') : null
    const argsText = blk ? blk.text.slice(1, -1) : ''
    const authed = /\bauthenticateToken\b/.test(argsText)
    const rp = /requirePermission\(\s*'([^']+)'\s*(?:,\s*'([RW])')?\s*\)/.exec(argsText)
    // 末参 = router 变量（标识符）
    const parts = splitTopLevelCommas(argsText)
    const lastArg = (parts[parts.length - 1] || '').trim()
    const routerVar = /^[A-Za-z_$][\w$]*$/.test(lastArg) ? lastArg : null
    mounts.push({
      prefix: normalizePath(prefix),
      module: rp ? rp[1] : null,
      level: rp ? ((rp[2] as Level) || 'R') : null,
      authed,
      routerVar,
    })
  }
  return mounts
}

// ============================================================================
// 后端：路由文件守卫 —— 每个 router.METHOD('/rel', ...guards, handler)
// ============================================================================
export interface RouteGuardRaw {
  method: string
  relPath: string
  /** 路由中间件里的模块守卫（requirePermission）——若有则覆盖挂载层。 */
  module: string | null
  level: Level | null
  /** 具名条件（requireAnyRole:xxx / requireAdmin / sod:self-review / caliber-admin）。 */
  conditions: string[]
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

/**
 * 编码 requireAdmin 的**判别性选项**（对抗复核 #1）：primaryRoleOnly:true = 只看 primary role（更严·更小用户集），
 * 默认 = roles-aware isAdmin（更松·roles[] 含 admin 也放行）。两者授权语义不同，必须编进 condition，否则
 * 「删掉 primaryRoleOnly = 放宽」会被抹平成同一 'admin' 字符串、diff 判 equal、静默过门。
 */
function adminCondition(argsText: string): string {
  return /\bprimaryRoleOnly\s*:\s*true\b/.test(argsText) ? 'admin:primaryRole' : 'admin:rolesAware'
}

/** 抽 text 里每个 `name(...)` 调用的完整括号参数段（text 须已 blankComments·内部引号/正则已中和）。 */
function extractCallArgs(text: string, name: string): string[] {
  const out: string[] = []
  const re = new RegExp(`\\b${name}\\s*\\(`, 'g')
  let m
  while ((m = re.exec(text))) {
    const open = text.indexOf('(', m.index + m[0].length - 1)
    const blk = open >= 0 ? extractBalanced(text, open, '(', ')') : null
    out.push(blk ? blk.text : '')
  }
  return out
}

/** 收集 const 别名 → 守卫定义。支持 requirePermission / requireAnyRole / requireAdmin。 */
function collectGuardAliases(code: string): Record<string, { kind: string; args: string }> {
  const aliases: Record<string, { kind: string; args: string }> = {}
  const re = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(requirePermission|requireAnyRole|requireAdmin)\s*\(/g
  let m
  while ((m = re.exec(code))) {
    const name = m[1]
    const kind = m[2]
    const open = code.indexOf('(', m.index + m[0].length - 1)
    const blk = open >= 0 ? extractBalanced(code, open, '(', ')') : null
    aliases[name] = { kind, args: blk ? blk.text.slice(1, -1) : '' }
  }
  return aliases
}

/** 把一段守卫表达（`requirePermission('m','W')` / 别名 / `requireAnyRole('a','b')`）解释成 module/level/condition。 */
function interpretGuardExpr(
  expr: string,
  aliases: Record<string, { kind: string; args: string }>,
): { module?: string; level?: Level; condition?: string } {
  const e = expr.trim()
  // 直接调用
  let mm = /^requirePermission\(\s*'([^']+)'\s*(?:,\s*'([RW])')?\s*\)$/.exec(e)
  if (mm) return { module: mm[1], level: (mm[2] as Level) || 'R' }
  mm = /^requireAnyRole\(([^)]*)\)$/.exec(e)
  if (mm) {
    const roles = [...mm[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
    return { condition: `anyRole:${roles.join('+')}` }
  }
  if (/^requireAdmin\(/.test(e)) return { condition: adminCondition(e) }
  // 别名标识符
  const idm = /^([A-Za-z_$][\w$]*)$/.exec(e)
  if (idm && aliases[idm[1]]) {
    const a = aliases[idm[1]]
    if (a.kind === 'requirePermission') {
      const am = /'([^']+)'\s*(?:,\s*'([RW])')?/.exec(a.args)
      if (am) return { module: am[1], level: (am[2] as Level) || 'R' }
    }
    if (a.kind === 'requireAnyRole') {
      const roles = [...a.args.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
      return { condition: `anyRole:${roles.join('+')}` }
    }
    if (a.kind === 'requireAdmin') return { condition: adminCondition(a.args) }
  }
  return {}
}

export function parseRouteFileGuards(src: string): RouteGuardRaw[] {
  const code = blankComments(src)
  const aliases = collectGuardAliases(code)
  const out: RouteGuardRaw[] = []
  // 逐个 router.METHOD(
  const re = new RegExp(`\\brouter\\.(${METHODS.join('|')})\\s*\\(`, 'g')
  let m
  while ((m = re.exec(code))) {
    const method = m[1].toUpperCase()
    const open = code.indexOf('(', m.index + m[0].length - 1)
    const blk = open >= 0 ? extractBalanced(code, open, '(', ')') : null
    if (!blk) continue
    const inner = blk.text.slice(1, -1)
    const args = splitTopLevelCommas(inner)
    if (!args.length) continue
    const relM = /^\s*'([^']+)'/.exec(args[0])
    if (!relM) continue // 路径非字面量（动态挂载）——跳过（会作为运行时端点无静态守卫 → UNGUARDED 待裁）
    const relPath = relM[1]
    // 末参 = handler；中间参 = 中间件守卫
    const middlewares = args.slice(1, -1)
    const handlerText = args[args.length - 1] || ''
    let module: string | null = null
    let level: Level | null = null
    const conditions = new Set<string>()
    for (const mwRaw of middlewares) {
      const mw = mwRaw.trim()
      if (mw === 'authenticateToken') continue
      const g = interpretGuardExpr(mw, aliases)
      if (g.module) { module = g.module; level = g.level ?? 'R' }
      if (g.condition) conditions.add(g.condition)
    }
    // handler 体内的具名组合子（in-handler·不在中间件链）——编码判别性选项（对抗复核 #1）：
    //   assertNotSelfReview 的 failClosedOnMissing:true 在提交人缺失时也拒（数据缺陷→拒签发·兜底更严），
    //   必须编进 condition，否则「删掉 failClosedOnMissing = 放宽」会被抹平成同一 'sod:self-review'、静默过门。
    for (const argsRaw of extractCallArgs(handlerText, 'assertNotSelfReview')) {
      conditions.add(/\bfailClosedOnMissing\s*:\s*true\b/.test(argsRaw) ? 'sod:self-review:failClosed' : 'sod:self-review')
    }
    // assertCaliberChangeAllowed 的 changed 表达式属 handler 运行时逻辑·静态抽不出（已知盲区·文档化）——仅记存在。
    if (/\bassertCaliberChangeAllowed\s*\(/.test(handlerText)) conditions.add('caliber-admin')
    out.push({ method, relPath, module, level, conditions: [...conditions].sort() })
  }
  return out
}
