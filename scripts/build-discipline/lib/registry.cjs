/**
 * 构建纪律闸 — 共享解析层（registry）
 *
 * 目的：把「前端 API 调用」「后端已注册路由」「配置字段」从源码里静态解析出来，
 * 供三条 CI 检查（前端→后端 / 后端→消费者 / 配置→引擎）复用。
 *
 * 设计约束：
 *  - 纯 Node（CommonJS）、零依赖、不编译 TS（正则静态扫描），CI 里 `node` 直接跑。
 *  - 只做「静态可判定」的部分；动态拼接（变量做路径、运行时拼 base）**一律标记 unresolvable 跳过**，
 *    绝不当成违规（防误报——见 task「防误报」要求）。
 *
 * 与运行时的口径对齐：
 *  - 前端 `request` 客户端 baseURL = `.../api/v1`，故 `request.get('/inventory')` 命中 `/api/v1/inventory`。
 *    → 所有路径统一归一到「/api/v1 之后」的相对形式再比对。
 *  - 直接 `fetch('/api/v1/...')` 是绝对路径，去掉 `/api/v1` 前缀后同样归一。
 */

const fs = require('fs')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..')
const FRONTEND_SRC = path.join(PROJECT_ROOT, '前端代码', 'src')
const BACKEND_SRC = path.join(PROJECT_ROOT, '后端代码', 'server', 'src')
const ROUTES_DIR = path.join(BACKEND_SRC, 'routes')
const APP_TS = path.join(BACKEND_SRC, 'app.ts')
const DB_MANAGER = path.join(BACKEND_SRC, 'database', 'DatabaseManager.ts')
const API_PREFIX = '/api/v1'

// ---------- 文件遍历 ----------

/** 绝对路径 → 相对项目根，便于报告可读（可点击） */
function rel(p) {
  return path.relative(PROJECT_ROOT, p)
}

/** 递归收集指定扩展名的文件，跳过 node_modules/dist/build 与测试文件 */
function walk(dir, exts) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'build', '.git', 'coverage'].includes(entry.name)) continue
      out.push(...walk(full, exts))
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      if (/\.(test|spec)\.(t|j)sx?$/.test(entry.name)) continue
      if (entry.name.endsWith('.d.ts')) continue
      out.push(full)
    }
  }
  return out
}

/** 去掉块注释 /* ... *\/（避免匹配被注释掉的代码）。行注释在逐行扫描时按行首过滤。 */
function stripBlockComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/** 该行是否是纯注释行（行首为 // 或 *），是则扫描时跳过 */
function isCommentLine(line) {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*')
}

// ---------- 路径归一 ----------

/**
 * 把一个路径字符串归一成「段数组」，param 段统一记为 ':'。
 * 处理：
 *  - 去查询串（? 之后）
 *  - 整段是 ${...} 或 :xxx → param 段 ':'
 *  - 段内含 ${...}（literal 前缀 + 动态后缀/查询拼接）→ 只保留 literal 前缀
 * 返回 { segs, hadDynamic }。hadDynamic=true 表示路径里出现过 ${...}（用于判断可解析性时参考）。
 */
function normalizePath(raw) {
  let p = raw.split('?')[0]
  let hadDynamic = false
  const rawSegs = p.split('/')
  const segs = []
  for (const seg of rawSegs) {
    if (seg === '') continue
    if (seg.startsWith('${') || seg.startsWith(':')) {
      hadDynamic = hadDynamic || seg.startsWith('${')
      segs.push(':')
      continue
    }
    const dollar = seg.indexOf('${')
    if (dollar >= 0) {
      hadDynamic = true
      const prefix = seg.slice(0, dollar)
      if (prefix) segs.push(prefix)
      // 动态后缀（查询串/拼接）丢弃——保守取 literal 前缀
      continue
    }
    segs.push(seg)
  }
  return { segs, hadDynamic }
}

/** 两条归一后的段数组是否匹配（param 段 ':' 通配任意单段） */
function segsMatch(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === ':' || b[i] === ':') continue
    if (a[i] !== b[i]) return false
  }
  return true
}

/** 段数组的「literal 前缀基路径」= 直到第一个 param 段为止的字面部分（保留兼容，已不用于兜底） */
function literalBase(segs) {
  const out = []
  for (const s of segs) {
    if (s === ':') break
    out.push(s)
  }
  return '/' + out.join('/')
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从端点路径构造「动态调用点」精确正则：param 段（:xxx）→ 要求调用处是 ${...} 模板插值；字面段精确转义。
 * 用于 C2 文本兜底——只有当**完整端点形状**（含各字面段、param 处是模板插值）出现在发请求的文件里，才算被动态消费。
 * 这避免了「literalBase 截到第一个 param 就用前缀 substring 匹配」的坍缩误判（死的兄弟子路由不再因共享前缀被判消费）。
 * 无字面段可辨识（如根 '/'）→ 返回 null（不启用兜底）。
 */
function endpointCallRegex(relPath) {
  const parts = relPath.split('/').filter(Boolean)
  if (!parts.length) return null
  if (!parts.some((s) => !s.startsWith(':'))) return null // 全是 param，无字面可辨 → 不兜底
  const body = parts.map((s) => (s.startsWith(':') ? '\\$\\{[^}]+\\}' : escapeRe(s))).join('/')
  return new RegExp('/' + body)
}

// ---------- 后端路由注册表 ----------

/**
 * 解析 app.ts：得到 挂载前缀(去掉 /api/v1 的相对形式) → 路由文件 的映射。
 * 例：app.use('/api/v1/reports', authenticateToken, requirePermission(...), reportRoutes)
 *     import reportRoutes from './routes/reports-v1.1.js'
 */
function parseAppMounts() {
  const src = stripBlockComments(fs.readFileSync(APP_TS, 'utf8'))
  // import 变量 → 路由文件名(.ts)
  const importMap = {}
  const reImport = /import\s+(\w+)\s+from\s+'\.\/routes\/([\w.\-]+)\.js'/g
  let m
  while ((m = reImport.exec(src))) {
    importMap[m[1]] = m[2] + '.ts'
  }
  // app.use('<prefix>', ... , <var>)
  const mounts = []
  const lines = src.split('\n')
  for (const line of lines) {
    if (isCommentLine(line)) continue
    const um = /app\.use\(\s*'([^']+)'\s*,(.*)\)/.exec(line)
    if (!um) continue
    const prefix = um[1]
    if (!prefix.startsWith(API_PREFIX)) continue
    const argsTail = um[2]
    // 取参数尾里出现的、已知的 import 变量（router 通常是最后一个参数）
    let routeFile = null
    let chosenVar = null
    for (const v of Object.keys(importMap)) {
      const re = new RegExp('\\b' + v + '\\b')
      if (re.test(argsTail)) {
        routeFile = importMap[v]
        chosenVar = v
        break
      }
    }
    if (!routeFile) continue
    const relPrefix = prefix.slice(API_PREFIX.length) || '/' // /api/v1/reports → /reports
    mounts.push({ prefix, relPrefix, routeFile, importVar: chosenVar })
  }
  return mounts
}

/** 解析单个路由文件里的 router.METHOD('<path>', ...) → [{method, routePath, line}] */
function parseRouterEndpoints(routeFile) {
  const full = path.join(ROUTES_DIR, routeFile)
  if (!fs.existsSync(full)) return []
  const src = stripBlockComments(fs.readFileSync(full, 'utf8'))
  const lines = src.split('\n')
  const eps = []
  const re = /router\.(get|post|put|delete|patch)\(\s*(['"`])([^'"`]*)\2/
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isCommentLine(line)) continue
    const rm = re.exec(line)
    if (!rm) continue
    eps.push({ method: rm[1].toUpperCase(), routePath: rm[3], line: i + 1 })
  }
  return eps
}

/**
 * 构建后端端点全表。每个端点：
 *  { method, relPath, segs, literalBase, routeFile, line, mountPrefix }
 * relPath = 挂载相对前缀 + routePath（归一前的可读形式）
 */
function buildBackendRegistry() {
  const mounts = parseAppMounts()
  const endpoints = []
  for (const mt of mounts) {
    const eps = parseRouterEndpoints(mt.routeFile)
    for (const ep of eps) {
      const base = mt.relPrefix === '/' ? '' : mt.relPrefix
      const routePart = ep.routePath === '/' ? '' : ep.routePath
      const relPath = (base + routePart) || '/'
      const { segs } = normalizePath(relPath)
      endpoints.push({
        method: ep.method,
        relPath,
        segs,
        literalBase: literalBase(segs),
        routeFile: mt.routeFile,
        line: ep.line,
        mountPrefix: mt.prefix,
      })
    }
  }
  return { mounts, endpoints }
}

// ---------- 前端调用抽取 ----------

/**
 * 抽取一个前端文件里的 API 调用。
 * 覆盖：
 *   1) request.METHOD<...>('<path>' | `<tpl>`, ...)        —— 路径相对 /api/v1
 *   2) axios.METHOD(`${BASE_URL}/<path>`, ...)             —— 裸 axios（如 request.ts 的 /auth/refresh）
 *   3) fetch('<path>' | `<tpl>`, { method: 'X' })          —— 绝对 /api/v1/...
 *   4) fetch(url, { method })，其中 `const url = \`/api/v1/...\`` 在同函数前若干行 —— 回溯赋值解析
 * method 为动态（三元/变量）时记为 'ANY'（匹配任意方法·避免方法错配造成的假幽灵）。
 * 仍不可解析（fetch(fn())、无本地赋值）→ resolvable:false，另计 unresolvable（可见、不当违规）。
 * 返回 { calls, unresolvable }。call = {file,line,method,rawPath,relPath,segs,resolvable,kind,fromVar}
 */
function parseFrontendCalls() {
  const files = walk(FRONTEND_SRC, ['.ts', '.tsx'])
  const calls = []
  const reReqAxios = /\b(request|axios)\.(get|post|put|delete|patch)\s*(?:<[^(]*>)?\s*\(\s*(['"`])([^'"`]*)\3/
  const reFetchLiteral = /\bfetch\s*\(\s*(['"`])([^'"`]*)\1/
  const reFetchVar = /\bfetch\s*\(\s*([A-Za-z_$][\w$]*)\s*[,)]/ // fetch(url, ...) —— 捕获变量名

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    const src = stripBlockComments(raw)
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (isCommentLine(line)) continue

      // request.METHOD(...) / axios.METHOD(...)
      const rm = reReqAxios.exec(line)
      if (rm) {
        const method = rm[2].toUpperCase()
        pushCall(calls, file, i + 1, method, stripBase(rm[4]), rm[1], false)
        continue
      }

      // fetch('/api/v1/...')
      const fm = reFetchLiteral.exec(line)
      if (fm) {
        const fmeth = findFetchMethod(lines, i)
        pushCall(calls, file, i + 1, fmeth.method, stripBase(fm[2]), 'fetch', false)
        continue
      }

      // fetch(变量, ...) → 回溯同函数前 ~20 行的 `const 变量 = ...` 提取字面路径
      const fv = reFetchVar.exec(line)
      if (fv) {
        const resolved = resolveFetchVar(lines, i, fv[1])
        if (resolved.length) {
          const fmeth = findFetchMethod(lines, i)
          for (const p of resolved) pushCall(calls, file, i + 1, fmeth.method, stripBase(p), 'fetch', true)
        } else {
          calls.push({ file: rel(file), line: i + 1, method: '?', rawPath: `fetch(${fv[1]})`, resolvable: false, kind: 'fetch', fromVar: true })
        }
      }
    }
  }
  return { calls }
}

/** 去掉 `${BASE_URL}`/`${API_BASE...}` 前缀与 `/api/v1` 前缀，归一到「/api/v1 之后」的相对形式 */
function stripBase(p) {
  let s = p
  s = s.replace(/^\$\{[^}]*\}/, '') // 掉头部 ${BASE_URL}
  if (s.startsWith(API_PREFIX)) s = s.slice(API_PREFIX.length) || '/'
  return s
}

/**
 * 回溯解析 `fetch(varName, ...)` 的 varName：在其之前 ~20 行内找 `const|let|var varName = <RHS>`，
 * 从 RHS 里抽出所有以 / 或 ${BASE_URL}/ 开头的字符串/模板字面（三元会有多个）→ 候选路径。
 */
function resolveFetchVar(lines, lineIdx, varName) {
  const start = Math.max(0, lineIdx - 20)
  const reAssign = new RegExp('\\b(?:const|let|var)\\s+' + varName + '\\s*=\\s*(.+)$')
  for (let j = lineIdx; j >= start; j--) {
    const am = reAssign.exec(lines[j])
    if (!am) continue
    const rhs = am[1]
    const out = []
    // 反引号模板（允许内部 ${...} 里带引号）
    const reTpl = /`((?:[^`\\]|\\.)*)`/g
    let m
    while ((m = reTpl.exec(rhs))) out.push(m[1])
    // 普通引号串
    const reStr = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g
    while ((m = reStr.exec(rhs))) out.push(m[1] !== undefined ? m[1] : m[2])
    // 只保留像 API 路径的（/... 或 ${BASE}/...）
    return out.filter((s) => /^\//.test(s) || /^\$\{[^}]*\}\//.test(s))
  }
  return []
}

/**
 * 找 fetch options 里的 method。返回 {method, dynamic}：
 *  - 无 method: 键 → GET（fetch 默认）
 *  - method: '字面' → 该方法
 *  - method: 三元/变量（无紧邻字面）→ 'ANY'（动态，匹配任意方法，避免方法错配假幽灵）
 */
function findFetchMethod(lines, lineIdx) {
  const window = lines.slice(lineIdx, lineIdx + 6).join('\n')
  if (!/\bmethod\s*:/.test(window)) return { method: 'GET', dynamic: false }
  const mm = /\bmethod\s*:\s*['"]([A-Za-z]+)['"]/.exec(window)
  if (mm) return { method: mm[1].toUpperCase(), dynamic: false }
  return { method: 'ANY', dynamic: true }
}

function pushCall(calls, file, line, method, rawPath, kind, fromVar) {
  if (!rawPath || !rawPath.startsWith('/')) {
    // 不是以 / 开头的（动态 base 拼接等）→ 不可解析，跳过（不当违规）
    calls.push({ file: rel(file), line, method, rawPath, resolvable: false, kind, fromVar })
    return
  }
  const { segs, hadDynamic } = normalizePath(rawPath)
  calls.push({
    file: rel(file),
    line,
    method,
    rawPath,
    relPath: '/' + segs.join('/'),
    segs,
    hadDynamic,
    resolvable: true,
    kind,
    fromVar,
  })
}

/**
 * 「调用上下文」文本 blob——只拼**确实发起 HTTP 调用**的前端文件（含 fetch(/request./axios.）。
 * 用于 C2 的「动态消费兜底」：端点 literalBase 出现在这里 = 被某个真发请求的文件提到（大概率动态消费）。
 * 关键：**排除** App.tsx 路由表 / AppSidebar 导航 / permissions.ts 权限表这类「路径字符串≠API 调用」的文件
 * （防 Finding 3：死路由因路径与页面路由同名被误判为"被消费"）。
 */
function frontendCallContextBlob() {
  const files = walk(FRONTEND_SRC, ['.ts', '.tsx'])
  const reCall = /\bfetch\s*\(|\b(?:request|axios)\.(?:get|post|put|delete|patch)\b/
  const parts = []
  for (const f of files) {
    const txt = stripBlockComments(fs.readFileSync(f, 'utf8'))
    if (reCall.test(txt)) parts.push(txt)
  }
  return parts.join('\n')
}

// ---------- 匹配 ----------

/**
 * 一个前端调用命中的后端端点（method + segs 匹配）；返回命中端点或 null。
 * call.method === 'ANY'（动态方法的 fetch(var)）→ 只按 segs 匹配任意方法，避免方法错配造成假幽灵/假空转。
 */
function matchCallToEndpoint(call, endpoints) {
  if (!call.resolvable) return null
  for (const ep of endpoints) {
    if (call.method !== 'ANY' && ep.method !== call.method) continue
    if (segsMatch(call.segs, ep.segs)) return ep
  }
  return null
}

module.exports = {
  PROJECT_ROOT,
  FRONTEND_SRC,
  BACKEND_SRC,
  ROUTES_DIR,
  APP_TS,
  DB_MANAGER,
  API_PREFIX,
  rel,
  walk,
  stripBlockComments,
  isCommentLine,
  normalizePath,
  segsMatch,
  literalBase,
  endpointCallRegex,
  parseAppMounts,
  parseRouterEndpoints,
  buildBackendRegistry,
  parseFrontendCalls,
  frontendCallContextBlob,
  matchCallToEndpoint,
}
