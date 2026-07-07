/**
 * 检查③ 配置→引擎：每个「用户可写的持久化配置字段」须在其自身 CRUD 之外有读取点，否则=空转参数。
 *
 * 判定（启发式，warn 起步；高置信 TP=allocation_base）：
 *   - 配置字段候选 = DatabaseManager 建表列 ∩ 在某路由的 INSERT/UPDATE 列表里被写（用户可设），
 *     且不属通用结构列（id/created_at/status/... 见 GENERIC）。
 *   - 「自身 CRUD 之外的读取点」= 除 DatabaseManager.ts 与「拥有该表 CRUD 的路由文件」外，
 *     后端 src 里还有别的文件引用该列名（引擎/工具/其它路由读它）。
 *   - 零外部引用 → 空转候选（写进去了没人读；比死代码更坏，见 task allocation_base 实例）。
 *
 * 局限（诚实标注）：静态列名匹配，不做语义分析。可能把「仅用于展示/审计留档」的列也报为候选
 *   （如 allocation_base_value 在写时算出 allocation_rate、自身不被引擎读）→ 故 warn 起步 + 人工确认。
 */

const fs = require('fs')
const R = require('./lib/registry.cjs')

// 通用结构列：不是计算口径配置，跳过
const GENERIC = new Set([
  'id', 'created_at', 'updated_at', 'deleted_at', 'is_deleted', 'status',
  'remark', 'remarks', 'description', 'note', 'notes', 'name', 'code',
  'operator', 'created_by', 'updated_by', 'reviewed_by', 'submitted_by',
  'year_month', 'month', 'date', 'sort_order', 'display_order',
])

/**
 * 「计算旋钮」字段名特征：像是要驱动某个计算/口径选择的参数，
 * 若这种字段写进库、UI 让人选，却在自身 CRUD 之外无人读 → 高置信空转（allocation_base 就是此类）。
 * 与「纯展示/记录字段」（model/manufacturer/zone/system_stock…）区分开，后者被 CRUD 内读取+回显是正常的。
 */
function isCalcKnobName(col) {
  return /(_base$|_base_value$|_method$|_mode$|_rate$|_ratio$|_factor$|_weight$|_strategy$|_formula$|_driver$|_threshold$|_coefficient$|allocation)/.test(col)
}

/** 从 DatabaseManager.ts 解析 CREATE TABLE → { table: [columns] } */
function parseTables() {
  const src = R.stripBlockComments(fs.readFileSync(R.DB_MANAGER, 'utf8'))
  const tables = {}
  const re = /CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([`"]?)(\w+)\1\s*\(/g
  let m
  while ((m = re.exec(src))) {
    const table = m[2]
    // 从 '(' 起做括号配平，取表体
    let depth = 0
    let i = re.lastIndex - 1
    let body = ''
    for (; i < src.length; i++) {
      const ch = src[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
      if (depth >= 1 && !(ch === '(' && depth === 1)) body += ch
    }
    const cols = []
    for (const rawLine of body.split(/[\n,]/)) {
      const line = rawLine.trim()
      if (!line) continue
      const cm = /^([a-z_][a-z0-9_]*)\s+/i.exec(line)
      if (!cm) continue
      const col = cm[1].toLowerCase()
      if (['primary', 'foreign', 'unique', 'check', 'constraint', 'key'].includes(col)) continue
      cols.push(col)
    }
    tables[table] = cols
  }
  return tables
}

/**
 * 扫描路由文件里的 INSERT INTO <table> (cols...) 与 UPDATE <table> SET col = ...，
 * 得到：writableCols[table] = Set(列名)；ownerFiles[table] = Set(路由文件名)
 */
function parseWrites() {
  const files = R.walk(R.ROUTES_DIR, ['.ts'])
  const writable = {}
  const owners = {}
  for (const f of files) {
    const src = R.stripBlockComments(fs.readFileSync(f, 'utf8'))
    const base = R.rel(f)
    // INSERT INTO t (a, b, c) VALUES
    const reIns = /INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)/gi
    let m
    while ((m = reIns.exec(src))) {
      const t = m[1]
      const cols = m[2].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      writable[t] = writable[t] || new Set()
      cols.forEach((c) => { if (/^[a-z_][a-z0-9_]*$/.test(c)) writable[t].add(c) })
      owners[t] = owners[t] || new Set()
      owners[t].add(base)
    }
    // UPDATE t SET a = ?, b = ?
    const reUpd = /UPDATE\s+(\w+)\s+SET\s+([\s\S]*?)\bWHERE\b/gi
    while ((m = reUpd.exec(src))) {
      const t = m[1]
      const setClause = m[2]
      const colRe = /(\w+)\s*=/g
      let cm
      while ((cm = colRe.exec(setClause))) {
        const c = cm[1].toLowerCase()
        if (/^[a-z_][a-z0-9_]*$/.test(c)) {
          writable[t] = writable[t] || new Set()
          writable[t].add(c)
        }
      }
      owners[t] = owners[t] || new Set()
      owners[t].add(base)
    }
  }
  return { writable, owners }
}

/** snake_case → camelCase（引擎层常以驼峰读列，故两种形式都要探） */
function toCamel(col) {
  return col.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())
}

/** 后端 src 里，引用某列名的文件集合——snake_case 与其 camelCase 形式都算「引用」（防 SELECT *+驼峰读被漏成假空转） */
function filesReferencing(col, allFiles, cache) {
  if (cache[col]) return cache[col]
  const camel = toCamel(col)
  const forms = camel === col ? [col] : [col, camel]
  const re = new RegExp('\\b(' + forms.join('|') + ')\\b')
  const set = new Set()
  for (const [f, txt] of allFiles) {
    if (re.test(txt)) set.add(f)
  }
  cache[col] = set
  return set
}

function run() {
  const tables = parseTables()
  const { writable, owners } = parseWrites()

  // 预读全部后端 src 文本
  const backendFiles = R.walk(R.BACKEND_SRC, ['.ts'])
  const allFiles = backendFiles.map((f) => [R.rel(f), R.stripBlockComments(fs.readFileSync(f, 'utf8'))])
  const dbRel = R.rel(R.DB_MANAGER)
  const cache = {}

  const violations = []
  let checked = 0

  for (const table of Object.keys(writable)) {
    if (!tables[table]) continue // 不是建表列（可能是子查询别名等）
    const ownerSet = owners[table] || new Set()
    for (const col of writable[table]) {
      if (GENERIC.has(col)) continue
      if (!tables[table].includes(col)) continue // 只认真实建表列
      checked++
      const refs = filesReferencing(col, allFiles, cache)
      // 排除：DatabaseManager 定义 + 拥有该表 CRUD 的路由文件
      const external = [...refs].filter((f) => f !== dbRel && !ownerSet.has(f))
      if (external.length === 0) {
        // 高置信=像计算旋钮却无人读（allocation_base 型，真危害）；低置信=多为纯展示/记录字段（噪声）
        const confidence = isCalcKnobName(col) ? 'HIGH' : 'LOW'
        violations.push({
          table,
          column: col,
          ownerFiles: [...ownerSet],
          confidence,
          note: confidence === 'HIGH'
            ? '计算旋钮字段写入后自身 CRUD 之外无读取点（高置信空转，同 allocation_base）'
            : '写入后自身 CRUD 之外无读取点（低置信：多为纯展示/记录字段，需人工确认是否真空转）',
        })
      }
    }
  }

  const high = violations.filter((v) => v.confidence === 'HIGH')
  const low = violations.filter((v) => v.confidence === 'LOW')

  return {
    id: 'C3',
    title: '配置→引擎（空转参数）',
    intent: '每个用户可写的持久化配置字段须在其自身 CRUD 之外有读取点',
    // 拦截用只看 HIGH（低置信是纯展示/记录字段噪声，仅报告不拦）
    violations: high,
    lowConfidence: low,
    stats: {
      configFieldsChecked: checked,
      idleHighConfidence: high.length,
      idleLowConfidence: low.length,
    },
  }
}

module.exports = { run, parseTables, parseWrites }
