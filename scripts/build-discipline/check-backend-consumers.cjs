/**
 * 检查② 后端→消费者：每个后端端点须有 ≥1 消费者，否则须进白名单（带 owner+deadline 的孵化）。
 *
 * 消费者信号（满足其一即算「被消费」，不进违规）：
 *   1) 精确命中：某条可解析前端调用 method+segs 匹配该端点。
 *   2) 文本引用兜底：端点 literalBase（如 /abc/cost-drivers）作为子串出现在前端源码里
 *      —— 覆盖「动态 fetch(url) 变量拼 base」这类静态匹配不到、但确有消费的情况（防误报，见 task）。
 *
 * 未被消费的端点：
 *   - 命中白名单且条目「结构有效 ∧ deadline 未过」→ 豁免（孵化中，warning 级）。
 *   - 命中白名单但条目结构无效（缺/坏/超上限 deadline）或 deadline 已过 → 违规（不豁免）。
 *   - 不在白名单 → 违规（无消费者、无 owner）。
 *
 * ★ 白名单 fail-closed（公理一·CON-2）★——白名单自己不能成为「它要治的病」的旁路口。
 *   过去 `wl.deadline && wl.deadline < today` 对缺 deadline 的条目短路成 false=永不过期=永久放行（fail-open）。
 *   现改成三条 fail-closed 规则（见 validateWhitelist）：
 *     1. 缺 deadline = 判过期 = 红（缺省方向反转：忘填 = 已过期，而非永不过期放行）。
 *     2. deadline 上限 today+MAX_DEADLINE_HORIZON_DAYS（防填 2099 变相永久豁免）。
 *     3. 白名单条数上限 MAX_WHITELIST_ENTRIES（防孵化名单膨胀成万年赦免簿）。
 *   为什么缺省方向是「红」：忘填期限属人为疏漏，安全底线是「疑罪从有」——把疏漏顶回给作者，
 *   而不是让一个没期限的豁免悄悄变成永久债。这三条是「治理完整性」违规，独立于端点是否被消费；
 *   即使坏条目覆盖的端点碰巧被消费，坏条目本身仍是死重结构违规。run-all 对其 fail-closed
 *   （hardFail：不受 baseline 收编、不受 --only 豁免、不可 --update-baseline 洗白）。
 *
 * 说明：本项目无 cron/定时任务、无跨路由内部 import（已核实），故消费者=前端。
 *       测试/e2e 覆盖不算「生产消费者」，仅作旁注（needs-real-consumer 的整个意义就在此）。
 */

const fs = require('fs')
const path = require('path')
const R = require('./lib/registry.cjs')
const { MAX_DEADLINE_HORIZON_DAYS, MAX_WHITELIST_ENTRIES } = require('./lib/constants.cjs')

// 白名单路径：默认同目录 consumer-whitelist.json；`BD_WHITELIST_PATH` 可覆盖（仅 selftest 注入 fixture 用，
// 让 run-all 的 exit-code 端到端断言能在临时目录跑坏白名单而不污染仓库文件）。
const WHITELIST_PATH = process.env.BD_WHITELIST_PATH || path.join(__dirname, 'consumer-whitelist.json')

/** ISO 日期字符串 +N 天 → ISO 日期字符串（UTC，避免本地时区把日期算偏一天）。 */
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 单条白名单是否结构性无效（缺/坏格式/超上限 deadline）——无效条目不得豁免其覆盖端点。 */
function whitelistEntryInvalid(entry, maxDeadline) {
  if (!entry.deadline) return true
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.deadline)) return true
  if (entry.deadline > maxDeadline) return true
  return false
}

/**
 * 白名单结构完整性校验（fail-closed 的核心）。返回错误数组（空 = 健康）。
 * 这些是「治理完整性」错误，独立于端点是否被消费——即使坏条目覆盖的端点碰巧被消费，
 * 坏条目本身仍是结构违规（死重），必须红。run-all 对本错误 fail-closed。
 */
function validateWhitelist(whitelist, today) {
  const errors = []
  const maxDeadline = addDays(today, MAX_DEADLINE_HORIZON_DAYS)
  if (whitelist.length > MAX_WHITELIST_ENTRIES) {
    errors.push({
      type: 'too-many-entries',
      detail: `白名单 ${whitelist.length} 条 > 上限 ${MAX_WHITELIST_ENTRIES}（孵化名单膨胀=万年赦免风险；封顶逼清理）`,
    })
  }
  for (const e of whitelist) {
    const id = `${e.method || '*'} ${e.path}`
    if (!e.deadline) {
      errors.push({ type: 'missing-deadline', entry: id, detail: `${id}：缺 deadline（fail-closed：忘填=已过期=红，owner ${e.owner || '?'}）` })
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(e.deadline)) {
      errors.push({ type: 'bad-deadline-format', entry: id, detail: `${id}：deadline "${e.deadline}" 非 YYYY-MM-DD` })
    } else if (e.deadline > maxDeadline) {
      errors.push({ type: 'deadline-too-far', entry: id, detail: `${id}：deadline ${e.deadline} > 上限 ${maxDeadline}（today+${MAX_DEADLINE_HORIZON_DAYS}d，防变相永久豁免）` })
    }
  }
  return errors
}

function loadWhitelist() {
  try {
    const j = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'))
    return Array.isArray(j.entries) ? j.entries : []
  } catch {
    return []
  }
}

/** 白名单条目是否覆盖某端点。path 支持 '/prefix/*' 前缀通配；method '*' 通配。 */
function whitelistCovers(entry, ep) {
  if (entry.method && entry.method !== '*' && entry.method.toUpperCase() !== ep.method) return false
  const pat = entry.path
  if (pat.endsWith('/*')) {
    const base = pat.slice(0, -2)
    return ep.relPath === base || ep.relPath.startsWith(base + '/')
  }
  // 精确：把白名单 path 也归一后比对 segs
  const { segs } = R.normalizePath(pat)
  return R.segsMatch(segs, ep.segs)
}

// today 用注入值（便于测试）；默认取运行时日期。opts.whitelist 可注入白名单（便于变异测试）。
function run(opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10)
  const { endpoints } = R.buildBackendRegistry()
  const { calls } = R.parseFrontendCalls()
  const blob = R.frontendCallContextBlob()
  const whitelist = opts.whitelist || loadWhitelist()

  // 白名单结构完整性（fail-closed）——先于端点判定；坏条目不豁免其端点、且整体 hardFail。
  const whitelistErrors = validateWhitelist(whitelist, today)
  const maxDeadline = addDays(today, MAX_DEADLINE_HORIZON_DAYS)

  // 1) 前端精确命中的端点集合
  const consumed = new Set()
  for (const call of calls) {
    const hit = R.matchCallToEndpoint(call, endpoints)
    if (hit) consumed.add(hit.method + ' ' + hit.relPath)
  }

  const violations = []
  const exempt = []
  const consumedKeys = [] // 'METHOD|relPath' —— 供 run-all 的 B.2「被消费端点不该赖在死物名单」交叉核对
  let consumedCount = 0
  let textRefCount = 0

  for (const ep of endpoints) {
    const key = ep.method + ' ' + ep.relPath
    if (consumed.has(key)) {
      consumedCount++
      consumedKeys.push(ep.method + '|' + ep.relPath)
      continue
    }
    // 文本引用兜底（精确形状匹配）：仅当**完整端点形状**（各字面段 + param 处为 ${...} 模板插值）
    // 出现在「发请求的文件」里，才算被动态消费。避免死的兄弟子路由因共享前缀被误判消费（HIGH 修复）。
    const rx = R.endpointCallRegex(ep.relPath)
    if (rx && rx.test(blob)) {
      textRefCount++
      consumedKeys.push(ep.method + '|' + ep.relPath)
      continue // 视为「动态消费」——不进违规
    }
    // 未被消费 → 查白名单
    const wl = whitelist.find((e) => whitelistCovers(e, ep))
    if (wl) {
      if (whitelistEntryInvalid(wl, maxDeadline)) {
        // fail-closed：缺/坏/超上限 deadline 的条目不豁免其端点（防旁路口敞开）。
        violations.push({ ...epRec(ep), reason: `白名单条目无效·不豁免（缺/坏/超上限 deadline，owner ${wl.owner || '?'}）`, cls: 'expired' })
      } else if (wl.deadline < today) {
        violations.push({ ...epRec(ep), reason: `孵化过期（deadline ${wl.deadline} < ${today}，owner ${wl.owner}）`, cls: 'expired' })
      } else {
        exempt.push({ ...epRec(ep), owner: wl.owner, deadline: wl.deadline })
      }
    } else {
      violations.push({ ...epRec(ep), reason: '无生产消费者、未登记白名单', cls: 'unconsumed' })
    }
  }

  return {
    id: 'C2',
    title: '后端→消费者（无人消费的端点）',
    intent: '每个后端端点须有 ≥1 生产消费者，否则进白名单（有名有期的孵化）',
    violations,
    exempt,
    // fail-closed 结构层：白名单本身的治理完整性错误。run-all 见 hardFail 即红（不受 baseline/only 影响）。
    whitelistErrors,
    hardFail: whitelistErrors.length > 0,
    consumedKeys,
    stats: {
      totalEndpoints: endpoints.length,
      consumedByCall: consumedCount,
      consumedByText: textRefCount,
      exemptWhitelisted: exempt.length,
      unconsumedViolations: violations.length,
      whitelistErrors: whitelistErrors.length,
    },
  }
}

function epRec(ep) {
  return { method: ep.method, path: ep.relPath, routeFile: 'routes/' + ep.routeFile, line: ep.line }
}

module.exports = {
  run,
  whitelistCovers,
  loadWhitelist,
  validateWhitelist,
  whitelistEntryInvalid,
  addDays,
  MAX_DEADLINE_HORIZON_DAYS,
  MAX_WHITELIST_ENTRIES,
}
