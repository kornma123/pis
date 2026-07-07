#!/usr/bin/env node
/**
 * 构建纪律闸 — 统一入口（含 baseline 棘轮/delta 模式）。
 *
 * 把三条检查（C1 前端→后端 / C2 后端→消费者 / C3 配置→引擎）跑一遍，打印人读汇总。
 *
 * ★ 棘轮（ratchet / delta）★——本闸能「防新增」而非只「盘存量」的关键：
 *   `baseline.json` 记录当前已接受的存量违规键集合。每次运行把当前违规分成
 *   「存量已知（在 baseline 里）」与「**新增**（不在 baseline 里）」。
 *   --block 只对**新增**判红 → 可**立刻**对干净的检查开 block，而不会被 45 条历史存量红墙挡住所有 PR。
 *   存量只减不增：修掉一条就 --update-baseline 收紧（棘轮），永不回退。
 *   这让 PR 模板「无新增违规」变成机器可判定的事实。
 *
 * 用法：
 *   node scripts/build-discipline/run-all.cjs                  # warn，全量+delta 汇总（永远 exit 0）
 *   node scripts/build-discipline/run-all.cjs --block=C1       # 仅对 C1 的**新增**判红（存量不拦）
 *   node scripts/build-discipline/run-all.cjs --block=C1,C2,C3 # 三条都对新增判红
 *   node scripts/build-discipline/run-all.cjs --update-baseline# 把当前违规写进 baseline（收紧棘轮）
 *   node scripts/build-discipline/run-all.cjs --json           # 附机器可读 JSON
 *   node scripts/build-discipline/run-all.cjs --only=C1        # 只跑某条
 *
 * 落地节奏（见 README）：三条先 warn 跑一轮看误报率；delta 稳定后逐条切 --block（对新增）。
 */

const fs = require('fs')
const path = require('path')
const c1 = require('./check-frontend-to-backend.cjs')
const c2 = require('./check-backend-consumers.cjs')
const c3 = require('./check-config-engine.cjs')

const BASELINE_PATH = path.join(__dirname, 'baseline.json')

function parseArgs(argv) {
  const args = { block: new Set(), only: null, json: false, updateBaseline: false }
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true
    else if (a === '--update-baseline') args.updateBaseline = true
    else if (a.startsWith('--block=')) a.slice(8).split(',').filter(Boolean).forEach((x) => args.block.add(x.toUpperCase()))
    else if (a.startsWith('--only=')) args.only = a.slice(7).split(',').map((x) => x.toUpperCase())
  }
  return args
}

/**
 * 违规的稳定键（跨运行可比对，用于 delta 棘轮）。
 * 刻意用「归一后」的 path（param 段 → ':'）以保证键在 param 改名/加尾斜杠等无害重构下稳定——
 * 这是棘轮可用的前提。已知取舍（低危）：两个 method+归一路径完全同形的端点会共享键
 * （如同文件两处 GET /:id 折叠成一个），一个与已基线项同形的新违规可能读成「非新增」被静默收编。
 * 现无活跃碰撞（全部违规键互异）。要更精细就把 routeFile 也纳入键，但会牺牲跨文件搬动的稳定性——不值。
 */
function keyOf(checkId, v) {
  if (checkId === 'C3') return `C3|${v.table}.${v.column}`
  return `${checkId}|${v.method}|${v.path}`
}

function loadBaseline() {
  try {
    const j = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    return new Set(Array.isArray(j.keys) ? j.keys : [])
  } catch {
    return null // 无 baseline 文件 → delta 模式退化为「全部视作新增」（首次或未生成时）
  }
}

function pad(n) { return String(n).padStart(3) }
function shortFiles(files) { return files.map((f) => f.replace(/^.*\/routes\//, 'routes/')).join(', ') }

function printC1(r, isNew) {
  console.log(`\n【${r.id}】${r.title} — ${r.intent}`)
  console.log(`  调用 ${r.stats.totalCalls}（可解析 ${r.stats.resolvable} / 动态未核 ${r.stats.unverifiableDynamic}）· 命中 ${r.stats.matched} · 幽灵 ${r.stats.ghost}`)
  if (r.violations.length) {
    console.log('  幽灵 404（前端调了、后端无此路由）：')
    for (const v of r.violations) console.log(`    ${isNew(v) ? '🆕' : '✗ '} ${v.method.padEnd(6)} ${v.path}   ← ${v.file}:${v.line}`)
  }
  if (r.unverifiable && r.unverifiable.length) {
    console.log('  ⚠ 动态调用·无法静态核对（人工过目，防动态 fetch 藏幽灵）：')
    for (const u of r.unverifiable) console.log(`    ? ${u.rawPath}   ← ${u.file}:${u.line}`)
  }
}

function printC2(r, isNew) {
  console.log(`\n【${r.id}】${r.title} — ${r.intent}`)
  console.log(`  端点 ${r.stats.totalEndpoints} · 前端命中 ${r.stats.consumedByCall} · 文本引用兜底 ${r.stats.consumedByText} · 白名单豁免 ${r.stats.exemptWhitelisted} · 违规 ${r.stats.unconsumedViolations}`)
  if (r.exempt.length) {
    console.log('  白名单豁免（孵化中，有 owner+deadline）：')
    for (const e of r.exempt) console.log(`    ○ ${e.method.padEnd(6)} ${e.path}   [owner ${e.owner} · deadline ${e.deadline}]`)
  }
  if (r.violations.length) {
    console.log('  无消费者（未登记白名单 / 孵化过期）：')
    for (const v of r.violations) console.log(`    ${isNew(v) ? '🆕' : '✗ '} ${v.method.padEnd(6)} ${v.path}   ← ${v.routeFile}:${v.line}  (${v.reason})`)
  }
}

function printC3(r, isNew) {
  console.log(`\n【${r.id}】${r.title} — ${r.intent}`)
  console.log(`  配置字段检查 ${r.stats.configFieldsChecked} · 高置信空转 ${r.stats.idleHighConfidence} · 低置信(仅报告) ${r.stats.idleLowConfidence}`)
  if (r.violations.length) {
    console.log('  高置信空转参数（计算旋钮却无人读，同 allocation_base）：')
    for (const v of r.violations) console.log(`    ${isNew(v) ? '🆕' : '✗ '} ${v.table}.${v.column}   拥有 CRUD：${shortFiles(v.ownerFiles)}`)
  }
  if (r.lowConfidence && r.lowConfidence.length) {
    console.log(`  低置信候选 ${r.lowConfidence.length} 项（多为纯展示/记录字段，不拦截；全表见 --json 或存量清单）`)
  }
}

function main() {
  const args = parseArgs(process.argv)
  const run = (id) => !args.only || args.only.includes(id)

  // 护栏：堵住「exit 0 却有新增违规」的自相矛盾旗组合（独立复核逮到的两个 footgun）。
  if (args.updateBaseline && args.block.size > 0) {
    console.error('✗ --update-baseline 与 --block 不可同用（前者会重写基线、把新增违规当存量收编，静默缴械拦截）。二选一。')
    process.exit(2)
  }
  for (const id of args.block) {
    if (!run(id)) {
      console.error(`✗ --block=${id} 但被 --only 排除，其拦截永不会被评估（会假绿）。要拦 ${id} 就别用 --only 把它排除。`)
      process.exit(2)
    }
  }

  const baseline = loadBaseline()

  const results = []
  const printers = { C1: printC1, C2: printC2, C3: printC3 }
  const runners = { C1: c1.run, C2: c2.run, C3: c3.run }

  for (const id of ['C1', 'C2', 'C3']) {
    if (!run(id)) continue
    const r = runners[id]()
    // 标注每条违规是否「新增」（不在 baseline）。无 baseline 文件时 fail-closed：全部计为新增，
    // 逼使先 --update-baseline 生成基线，再谈 --block（防基线丢失时 block 静默放行）。
    const isNew = (v) => baseline === null || !baseline.has(keyOf(id, v))
    r._new = r.violations.filter(isNew)
    r._fixed = baseline
      ? [...baseline].filter((k) => k.startsWith(id + '|') && !r.violations.some((v) => keyOf(id, v) === k))
      : []
    results.push(r)
    printers[id](r, isNew)
    if (baseline !== null) {
      console.log(`  ↳ vs baseline：新增 ${r._new.length} · 存量已知 ${r.violations.length - r._new.length} · 已修复 ${r._fixed.length}`)
    }
  }

  // 更新 baseline（收紧棘轮）
  if (args.updateBaseline) {
    const keys = []
    for (const r of results) for (const v of r.violations) keys.push(keyOf(r.id, v))
    keys.sort()
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({
      _doc: '构建纪律闸 baseline（棘轮基线）：当前已接受的存量违规键集合。--block 只对不在此集合里的「新增」判红。修掉存量后 --update-baseline 收紧，只减不增。',
      generated: '运行 --update-baseline 生成（日期见 git 提交）',
      count: keys.length,
      keys,
    }, null, 2) + '\n')
    console.log(`\n✎ 已写 baseline：${keys.length} 条存量键 → ${path.relative(process.cwd(), BASELINE_PATH)}`)
    process.exit(0)
  }

  // 汇总 + 退出码（block 只看「新增」）
  console.log('\n' + '─'.repeat(72))
  let blockedFail = false
  const baselineNote = baseline === null ? '（无 baseline：全部计为新增）' : ''
  for (const r of results) {
    const total = r.violations.length
    const nw = r._new.length
    const willBlock = args.block.has(r.id)
    const mode = willBlock ? 'BLOCK' : 'warn '
    let flag
    if (willBlock) flag = nw > 0 ? `❌ FAIL（新增 ${nw}）` : '✅ pass（无新增）'
    else flag = total > 0 ? `⚠️  warn（新增 ${nw}）` : '✅ pass'
    console.log(`  [${mode}] ${r.id} ${r.title}: 存量 ${pad(total)} · 新增 ${pad(nw)}  ${flag}`)
    if (willBlock && nw > 0) blockedFail = true
  }
  console.log('─'.repeat(72))
  if (args.block.size === 0) {
    console.log(`  模式：全部 warn（不拦合并）${baselineNote}。逐条稳定后加 --block=<ids> 切棘轮拦截（只拦新增）。`)
  } else {
    console.log(`  拦截：${[...args.block].join(',')} 对**新增**违规判红（存量不拦）${baselineNote}。`)
  }

  if (args.json) {
    console.log('\n===JSON===')
    const slim = results.map((r) => ({
      id: r.id, title: r.title, total: r.violations.length,
      new: r._new, fixed: r._fixed, violations: r.violations,
      lowConfidence: r.lowConfidence, exempt: r.exempt, stats: r.stats,
    }))
    console.log(JSON.stringify({ results: slim, block: [...args.block], blockedFail }, null, 2))
  }

  process.exit(blockedFail ? 1 : 0)
}

main()
