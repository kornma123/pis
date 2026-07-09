/**
 * 检查④ 路由↔导航注册表（CON-4 + CON-7 · 让孤儿化在构造上不可能）。
 *
 * 地面真相 = 前端 `App.tsx` 的 <Route path> 清单（结构路由 /login、* 除外）。
 * 声明源   = `前端代码/src/lib/route-registry.ts` 的 ROUTE_REGISTRY。
 *
 * 规则（每条都是「治理完整性」结构违规·run-all 见 hardFail 即无条件红——不受 baseline 收编 /
 *       --only 豁免 / --update-baseline 洗白；C4 无 baseline 棘轮，因为迁移时已把全部路由声明干净、
 *       零存量债，此后任一新页无声明即红）：
 *   1. 每条 App 路由必须在注册表声明（否则 undeclared-route）。
 *   2. 注册表每条声明必须对应一条真实 App 路由（否则 dangling-registry；防「迁移弄丢从两边同时消失」）。
 *   3. status='active' 必须有 navGroup ∈ 封闭枚举 NAV_GROUPS + label（否则 active-without-navgroup /
 *      unknown-navgroup / active-without-label）。加新 navGroup 须走评审改 NAV_GROUPS，不能现场编。
 *   4. status='headless' 吃 CON-2 同款 fail-closed：owner+reason 必填、due 必填且合法
 *      （YYYY-MM-DD·未过期·≤ today+MAX_DEADLINE_HORIZON_DAYS）。缺死线=红（忘填≠永久绿）。
 *      headless 条数 ≤ MAX_HEADLESS_ROUTES（逃生门膨胀=红·逼降级/补入口/退役）。
 *   5. status='deprecated' 必须有 reason（为何退役）。
 *
 * 为什么 fail-closed 缺省方向=红：新页无归宿 / 忘填死线 / 悬空声明都是人为疏漏，安全底线是把疏漏
 *   顶回给作者，而不是让一个孤儿悄悄漂进系统。恢复被误删的页是 git 一条命令，消除「浮现的孤儿页/
 *   撒谎页误导用户」不是。
 *
 * 纯解析 + 纯校验（validateRouteNav 可注入内存对象，selftest 变异断言证有牙）。
 * 环境覆盖（仅 selftest 注入 fixture 用，不污染仓库文件）：
 *   BD_APP_TSX_PATH / BD_ROUTE_REGISTRY_PATH。
 */

const fs = require('fs')
const path = require('path')
const { MAX_DEADLINE_HORIZON_DAYS, MAX_HEADLESS_ROUTES } = require('./lib/constants.cjs')

const FRONTEND_SRC = path.join(__dirname, '..', '..', '前端代码', 'src')
const APP_TSX_PATH = process.env.BD_APP_TSX_PATH || path.join(FRONTEND_SRC, 'App.tsx')
const REGISTRY_PATH = process.env.BD_ROUTE_REGISTRY_PATH || path.join(FRONTEND_SRC, 'lib', 'route-registry.ts')

// 结构路由：公开鉴权入口 + 全捕获 404，不是「应用页面」、不需要导航分类，故不纳入 C4 地面真相。
const STRUCTURAL_EXEMPT = new Set(['/login', '*'])

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** ISO 日期字符串 +N 天 → ISO 日期字符串（UTC，避免本地时区把日期算偏一天）。 */
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 去块注释（/* *​/ 与 JSX {/* *​/}）+ 行首行注释，防注释掉的 <Route>/条目被误当真。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSX {/* ... */} 的内层）
    .replace(/^\s*\/\/.*$/gm, '')     // 行首的 // 行注释（不碰字符串里的 :// ）
}

/**
 * 解析 App.tsx 的应用路由清单（<Route path="...">，排除结构路由 /login、*）。返回 [{ path, line }]。
 *
 * ⚠️ 不用 `/<Route\b[^>]*\bpath=/`——`[^>]*` 会在 element JSX 的 '>' 处截断（属性顺序 element 在 path 前、
 *    值含 <Foo/> 时漏掉该路由 = 未声明孤儿静默变绿·假阴性）。改为**按 `<Route` 分段**：每段 = 一个 Route 标签
 *    到下一个 `<Route` 的文本，取段内第一个 `path=` 属性——容忍属性任意顺序 + element 里的 '>'。
 *    `<Routes>` 因 `Route` 后接 `s`（无词边界）不被 `<Route\b` 命中，天然不误分。
 */
function parseAppRoutes(file) {
  const raw = fs.readFileSync(file || APP_TSX_PATH, 'utf8')
  const src = stripComments(raw)
  const lines = raw.split('\n')
  const out = []
  const seen = new Set()
  const segs = src.split(/<Route\b/)
  for (let i = 1; i < segs.length; i++) {
    const m = /\bpath\s*=\s*(['"])([^'"]+)\1/.exec(segs[i])
    if (!m) continue // 无 path（如 <Route element={<AppLayout/>}> 布局包裹路由）
    const p = m[2]
    if (STRUCTURAL_EXEMPT.has(p) || seen.has(p)) continue
    seen.add(p)
    // 行号：在原始文本里找该 path 声明（近似定位，供人读）
    const lineIdx = lines.findIndex((l) => l.includes(`path="${p}"`) || l.includes(`path='${p}'`))
    out.push({ path: p, line: lineIdx >= 0 ? lineIdx + 1 : 0 })
  }
  return out
}

/** 从条目文本抽单引号字符串字段（值内不含单引号，见 route-registry.ts 编写约定）。 */
function field(entryText, key) {
  const m = new RegExp(`\\b${key}:\\s*'([^']*)'`).exec(entryText)
  return m ? m[1] : undefined
}

/**
 * 抽出源码里所有**字符串感知、花括号配平**的顶层 `{...}` 块。
 * ⚠️ 不用 `/\{[^{}]*\}/`——字段字符串值里的 '{'/'}'（如 reason: 'see {foo}'）会截断匹配、丢条目
 *    （→ 该路由被误报未声明·假阳性红）。此扫描器跳过单引号字符串内的花括号，故值里的 '{}' 无害。
 *    深度>0 时也跟进（虽注册表条目为扁平对象，稳健起见配平任意深度）。
 */
function extractBraceBlocks(src) {
  const out = []
  const n = src.length
  let i = 0
  while (i < n) {
    if (src[i] !== '{') { i++; continue }
    let depth = 0
    let inStr = false
    const start = i
    for (; i < n; i++) {
      const c = src[i]
      if (inStr) {
        if (c === '\\') { i++; continue } // 跳过转义符及其后一字符
        if (c === "'") inStr = false
        continue
      }
      if (c === "'") { inStr = true; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { out.push(src.slice(start, i + 1)); break } }
    }
    i++
  }
  return out
}

/**
 * 解析 route-registry.ts：返回 { entries, navGroups }。
 * - navGroups：封闭枚举 NAV_GROUPS 数组里的字符串。
 * - entries：ROUTE_REGISTRY 里每个「同时含 quoted path: 与 status:」的对象字面量
 *   （NAV_GROUP_AREA 映射 / MenuItem 派生对象因无此二者天然被排除）。
 */
function parseRegistry(file) {
  const src = stripComments(fs.readFileSync(file || REGISTRY_PATH, 'utf8'))

  // NAV_GROUPS 封闭枚举
  const navGroups = []
  const ngm = /NAV_GROUPS[\s\S]*?=\s*\[([\s\S]*?)\]/.exec(src)
  if (ngm) {
    const inner = ngm[1]
    let q
    const qre = /'([^']+)'/g
    while ((q = qre.exec(inner))) navGroups.push(q[1])
  }

  // ROUTE_REGISTRY 条目：字符串感知配平抽块，只取含 quoted path+status 的
  // （NAV_GROUP_AREA 映射 / RouteEntry 接口 / deriveSidebarMenu 内 { path: entry.path } 因缺 quoted path+status 天然被排除）。
  const entries = []
  for (const t of extractBraceBlocks(src)) {
    if (!/\bpath:\s*'/.test(t) || !/\bstatus:\s*'/.test(t)) continue
    // permModule 可为 null（无引号）或字符串
    let permModule = field(t, 'permModule')
    if (permModule === undefined && /\bpermModule:\s*null\b/.test(t)) permModule = null
    entries.push({
      path: field(t, 'path'),
      label: field(t, 'label'),
      navGroup: field(t, 'navGroup'),
      permModule,
      status: field(t, 'status'),
      owner: field(t, 'owner'),
      due: field(t, 'due'),
      reason: field(t, 'reason'),
    })
  }
  return { entries, navGroups }
}

/**
 * 纯校验：给定 App 路由 + 注册表条目 + navGroups 封闭枚举 + today，产出结构违规数组。
 * 空数组 = 健康。所有违规都是 fail-closed 治理完整性错误。
 */
function validateRouteNav({ routes, entries, navGroups, today }) {
  const errors = []
  const SCOPE = '路由注册表(C4)'
  const push = (type, detail, p) => errors.push({ type, scope: SCOPE, detail, path: p })
  const maxDeadline = addDays(today, MAX_DEADLINE_HORIZON_DAYS)
  const navGroupSet = new Set(navGroups)

  const appPaths = routes.map((r) => r.path)
  const appSet = new Set(appPaths)

  // 注册表内查重 + 建 path 集
  const regSet = new Set()
  for (const e of entries) {
    if (regSet.has(e.path)) push('duplicate-registry', `路由 ${e.path} 在 route-registry.ts 声明多次`, e.path)
    else regSet.add(e.path)
  }

  // 1. undeclared：App 路由未声明（新页无归宿的核心拦截）
  for (const p of appPaths) {
    if (!regSet.has(p)) push('undeclared-route', `App.tsx 路由 ${p} 未在 route-registry.ts 声明（新页必须登记：active+navGroup / 或 headless 带死线）`, p)
  }
  // 2. dangling：声明了不存在的路由（防「迁移弄丢从两边同时消失」）
  for (const p of regSet) {
    if (!appSet.has(p)) push('dangling-registry', `注册表声明了 ${p} 但 App.tsx 无此 <Route>（悬空声明·迁移弄丢或拼错）`, p)
  }

  // 3~5. 逐条 status 校验
  let headlessCount = 0
  let activeCount = 0
  let deprecatedCount = 0
  for (const e of entries) {
    const st = e.status
    if (st !== 'active' && st !== 'headless' && st !== 'deprecated') {
      push('unknown-status', `${e.path}：未知 status "${st || ''}"（须 active/headless/deprecated）`, e.path)
      continue
    }
    if (st === 'active') {
      activeCount++
      if (!e.navGroup) push('active-without-navgroup', `${e.path}：active 路由缺 navGroup（须声明功能域，或改 headless 带死线）`, e.path)
      else if (!navGroupSet.has(e.navGroup)) push('unknown-navgroup', `${e.path}：navGroup "${e.navGroup}" 不在封闭枚举 NAV_GROUPS（加新分组须走评审改 NAV_GROUPS·不能现场编）`, e.path)
      if (!e.label) push('active-without-label', `${e.path}：active 路由缺 label（菜单渲染需要）`, e.path)
    } else if (st === 'headless') {
      headlessCount++
      if (!e.owner) push('headless-missing-owner', `${e.path}：headless 缺 owner（谁负责兑现死线）`, e.path)
      if (!e.reason) push('headless-missing-reason', `${e.path}：headless 缺 reason（分诊结论/去向）`, e.path)
      if (!e.due) push('headless-missing-deadline', `${e.path}：headless 缺 due（fail-closed：忘填=已过期=红，owner ${e.owner || '?'}）`, e.path)
      else if (!DATE_RE.test(e.due)) push('headless-bad-deadline', `${e.path}：due "${e.due}" 非 YYYY-MM-DD`, e.path)
      else if (e.due > maxDeadline) push('headless-deadline-too-far', `${e.path}：due ${e.due} > 上限 ${maxDeadline}（today+${MAX_DEADLINE_HORIZON_DAYS}d·防变相永久 headless）`, e.path)
      else if (e.due < today) push('headless-expired', `${e.path}：headless 死线到期（due ${e.due} < ${today}，owner ${e.owner || '?'}）——须重新分诊：补入口(active)/合并/退役(deprecated)`, e.path)
      if (e.navGroup && !navGroupSet.has(e.navGroup)) push('unknown-navgroup', `${e.path}：navGroup "${e.navGroup}" 不在封闭枚举 NAV_GROUPS`, e.path)
    } else {
      deprecatedCount++
      if (!e.reason) push('deprecated-missing-reason', `${e.path}：deprecated 缺 reason（为何退役）`, e.path)
    }
  }
  if (headlessCount > MAX_HEADLESS_ROUTES) {
    push('too-many-headless', `headless ${headlessCount} 条 > 上限 ${MAX_HEADLESS_ROUTES}（逃生门膨胀=孤儿在堆积·逼降级/补入口/退役）`)
  }

  return {
    errors,
    stats: {
      appRoutes: appPaths.length,
      registered: entries.length,
      active: activeCount,
      headless: headlessCount,
      deprecated: deprecatedCount,
    },
  }
}

// opts 可注入 {today, routes, entries, navGroups}（变异测试）；默认解析真实文件。
function run(opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10)
  const routes = opts.routes || parseAppRoutes()
  let entries = opts.entries
  let navGroups = opts.navGroups
  if (!entries || !navGroups) {
    const parsed = parseRegistry()
    if (!entries) entries = parsed.entries
    if (!navGroups) navGroups = parsed.navGroups
  }
  const { errors, stats } = validateRouteNav({ routes, entries, navGroups, today })
  return {
    id: 'C4',
    title: '路由↔导航注册表（未声明/悬空/死线）',
    intent: '每条 App 路由须在注册表声明并分组（active+navGroup）或 headless 带死线，否则红',
    errors,
    hardFail: errors.length > 0,
    stats,
  }
}

module.exports = {
  run,
  parseAppRoutes,
  parseRegistry,
  validateRouteNav,
  stripComments,
  addDays,
  STRUCTURAL_EXEMPT,
  MAX_HEADLESS_ROUTES,
  MAX_DEADLINE_HORIZON_DAYS,
}
