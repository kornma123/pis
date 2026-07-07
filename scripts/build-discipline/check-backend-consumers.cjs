/**
 * 检查② 后端→消费者：每个后端端点须有 ≥1 消费者，否则须进白名单（带 owner+deadline 的孵化）。
 *
 * 消费者信号（满足其一即算「被消费」，不进违规）：
 *   1) 精确命中：某条可解析前端调用 method+segs 匹配该端点。
 *   2) 文本引用兜底：端点 literalBase（如 /abc/cost-drivers）作为子串出现在前端源码里
 *      —— 覆盖「动态 fetch(url) 变量拼 base」这类静态匹配不到、但确有消费的情况（防误报，见 task）。
 *
 * 未被消费的端点：
 *   - 命中白名单且 deadline 未过 → 豁免（孵化中，warning 级）。
 *   - 命中白名单但 deadline 已过 → 违规（孵化过期）。
 *   - 不在白名单 → 违规（无消费者、无 owner）。
 *
 * 说明：本项目无 cron/定时任务、无跨路由内部 import（已核实），故消费者=前端。
 *       测试/e2e 覆盖不算「生产消费者」，仅作旁注（needs-real-consumer 的整个意义就在此）。
 */

const fs = require('fs')
const path = require('path')
const R = require('./lib/registry.cjs')

const WHITELIST_PATH = path.join(__dirname, 'consumer-whitelist.json')

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

// today 用注入值（便于测试）；默认取运行时日期。
function run(opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10)
  const { endpoints } = R.buildBackendRegistry()
  const { calls } = R.parseFrontendCalls()
  const blob = R.frontendCallContextBlob()
  const whitelist = loadWhitelist()

  // 1) 前端精确命中的端点集合
  const consumed = new Set()
  for (const call of calls) {
    const hit = R.matchCallToEndpoint(call, endpoints)
    if (hit) consumed.add(hit.method + ' ' + hit.relPath)
  }

  const violations = []
  const exempt = []
  let consumedCount = 0
  let textRefCount = 0

  for (const ep of endpoints) {
    const key = ep.method + ' ' + ep.relPath
    if (consumed.has(key)) {
      consumedCount++
      continue
    }
    // 文本引用兜底（精确形状匹配）：仅当**完整端点形状**（各字面段 + param 处为 ${...} 模板插值）
    // 出现在「发请求的文件」里，才算被动态消费。避免死的兄弟子路由因共享前缀被误判消费（HIGH 修复）。
    const rx = R.endpointCallRegex(ep.relPath)
    if (rx && rx.test(blob)) {
      textRefCount++
      continue // 视为「动态消费」——不进违规
    }
    // 未被消费 → 查白名单
    const wl = whitelist.find((e) => whitelistCovers(e, ep))
    if (wl) {
      const expired = wl.deadline && wl.deadline < today
      if (expired) {
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
    stats: {
      totalEndpoints: endpoints.length,
      consumedByCall: consumedCount,
      consumedByText: textRefCount,
      exemptWhitelisted: exempt.length,
      unconsumedViolations: violations.length,
    },
  }
}

function epRec(ep) {
  return { method: ep.method, path: ep.relPath, routeFile: 'routes/' + ep.routeFile, line: ep.line }
}

module.exports = { run, whitelistCovers, loadWhitelist }
