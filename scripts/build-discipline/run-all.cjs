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
 *   node scripts/build-discipline/run-all.cjs                  # warn，全量+delta 汇总（无新增违规时 exit 0；
 *                                                              #   但治理层 fail-closed 违规[白名单结构 A / baseline 死线·天花板·被依赖者 B]
 *                                                              #   无条件 exit 1，与是否 --block 无关）
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
const c5authz = require('./check-authz-combinators.cjs') // C5 授权组合子（独立轴·与 C1–C4 功能轴正交）
const BG = require('./lib/baseline-governance.cjs')

// baseline 路径：默认同目录 baseline.json；`BD_BASELINE_PATH` 可覆盖（仅 selftest 注入 fixture 用，
// 让 exit-code 端到端断言能在临时目录跑坏基线而不污染仓库文件）。
const BASELINE_PATH = process.env.BD_BASELINE_PATH || path.join(__dirname, 'baseline.json')

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

function loadBaselineDoc() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
  } catch {
    return null // 无 baseline 文件（首次或未生成）
  }
}

function loadBaseline() {
  const doc = loadBaselineDoc()
  if (!doc) return null // 无 baseline 文件 → delta 模式退化为「全部视作新增」（fail-closed）
  return new Set(Array.isArray(doc.keys) ? doc.keys : [])
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
  // 护栏（独立复核逮到）：--update-baseline 与 --only 不可同用——基线重写用的是 `results`（仅 --only 选中的检查），
  // 会用局部快照重写整份基线、静默丢弃未跑检查(C2/C3)的键与其 meta 死线(B.1 安全网)，还绕过坏白名单的 refuse。
  if (args.updateBaseline && args.only) {
    console.error('✗ --update-baseline 与 --only 不可同用（会用局部快照重写整份基线，静默丢弃未跑检查的键与 meta 死线）。要收紧基线就跑全量 --update-baseline。')
    process.exit(2)
  }
  for (const id of args.block) {
    if (!run(id)) {
      console.error(`✗ --block=${id} 但被 --only 排除，其拦截永不会被评估（会假绿）。要拦 ${id} 就别用 --only 把它排除。`)
      process.exit(2)
    }
  }

  const baseline = loadBaseline()
  const baselineDoc = loadBaselineDoc()
  const today = new Date().toISOString().slice(0, 10)

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

  // ── Fail-closed 治理层（公理一）：白名单结构完整性(A) + baseline 死线/天花板/被依赖者(B) ──
  // 这些是「治理完整性」错误，独立于 --block/baseline delta。任一非空 → 无条件红（exit 1），
  // 不受 --only 豁免、不可 --update-baseline 洗白。缺省方向=红（忘填/过期/膨胀=疏漏顶回作者）。
  //
  // ⚠️ C2 的白名单结构(A) 与消费集(B.2) **不受 --only 影响**（独立复核逮到的旁路口）：
  //    即使 --only 把 C2 排除出打印/拦截集，也无条件跑一次 C2 拿治理数据——否则 `--only=C1`
  //    会静默跳过白名单/被依赖者校验、放行坏白名单。c2.run() 是纯静态扫描、幂等、无副作用。
  const c2res = results.find((r) => r.id === 'C2') || c2.run()
  const consumedC2 = new Set(c2res.consumedKeys || [])

  // A：白名单结构错误（基线更新碰不到白名单 → 这类错误不会被 --update-baseline 清除）。
  const whitelistGovErrors = (Array.isArray(c2res.whitelistErrors) ? c2res.whitelistErrors : [])
    .map((e) => ({ scope: '白名单结构(A)', detail: e.detail }))

  // B：baseline 治理错误（meta 死线 / 天花板 / 被依赖者）——纯 doc + 消费集算出，可对任意 doc 复算
  //    （--update-baseline 用它对「将写入的新 doc」复算，解开「修完却被旧 doc 过期 meta 死锁」的问题）。
  const baselineGovErrorsOf = (doc) => {
    const out = []
    for (const e of BG.validateBaselineMeta(doc, today)) out.push({ scope: 'baseline死线(B.1)', detail: e.detail })
    const capErr = BG.checkBaselineCap(doc)
    if (capErr) out.push({ scope: 'baseline天花板(B.1)', detail: capErr.detail })
    for (const e of BG.consumedInDeadAmnesty(doc, consumedC2)) out.push({ scope: '被依赖者(B.2)', detail: e.detail })
    return out
  }

  // C5 授权组合子：路由 handler 里的「野生授权逻辑」（裸读请求用户 .role/.roles / 裸写 SoD 判决）——
  //   零容忍、无 baseline 宽容（授权缺口不是可攒的存量债）。纯静态扫描、幂等、无副作用；与 --block/--only/baseline
  //   无关，任一违规无条件红（fail-closed 公理一）。独立轴，与 C1–C4「功能先于消费者」正交。
  const authzRes = c5authz.run()
  const authzGovErrors = authzRes.violations.map((v) => ({
    scope: '授权组合子(C5)',
    detail: `${v.file}:${v.line} ${v.rule === 'role-access'
      ? '裸读请求用户 .role/.roles（授权须走组合子 requireAdmin/isAdmin/requireAnyRole/requirePermission）'
      : '裸写 SELF_REVIEW_FORBIDDEN 判决（SoD 须走 assertNotSelfReview 组合子）'} — ${v.snippet}`,
  }))

  const govErrors = [...whitelistGovErrors, ...baselineGovErrorsOf(baselineDoc), ...authzGovErrors]

  // 更新 baseline（收紧棘轮）
  if (args.updateBaseline) {
    // 先算出「本次将写入的」新 doc（keys/meta/targetMaxCount），再对**新 doc** 判治理错误——
    // 这样「存量已修 → 键掉出 → meta 剪掉 → 干净」的合法清理不会被旧 doc 上那条过期 meta 自我死锁
    // （独立复核逮到的死锁）；而「仍没修 → 键还在 → 仍过期」照样被拒（fail-closed 不破）。
    const keys = []
    for (const r of results) for (const v of r.violations) keys.push(keyOf(r.id, v))
    keys.sort()
    // 保留既有 meta（仅留仍在 keys 里的，剪掉悬空）——旧写法会整丢 meta/targetMaxCount → bug。
    const keySet = new Set(keys)
    const prevMeta = baselineDoc && baselineDoc.meta && typeof baselineDoc.meta === 'object' ? baselineDoc.meta : null
    let meta = null
    if (prevMeta) {
      meta = {}
      for (const [k, v] of Object.entries(prevMeta)) if (keySet.has(k)) meta[k] = v
    }
    // targetMaxCount：沿用既有；缺失则**自动播种**为当前条数（每份新基线天生带天花板，堵「删字段=悄悄取消封顶」的旁路口）。
    const targetMaxCount = baselineDoc && Number.isInteger(baselineDoc.targetMaxCount) ? baselineDoc.targetMaxCount : keys.length

    const newDoc = { keys, meta: meta || undefined, targetMaxCount }
    // fail-closed 拒绝：①白名单结构错误(A)（基线更新碰不到白名单、改不掉）；②**新 doc** 仍有 baseline 治理错误(B)
    //   （含越天花板 over-cap：新条数 > targetMaxCount → checkBaselineCap 判红 → 这里拒）。
    const refuse = [...whitelistGovErrors, ...baselineGovErrorsOf(newDoc)]
    if (refuse.length) {
      console.error('✗ 治理层 fail-closed 错误未清，禁止 --update-baseline（会把结构违规洗白成存量）。先清：')
      for (const e of refuse) console.error(`    · [${e.scope}] ${e.detail}`)
      console.error('  （越天花板？修掉存量降到 targetMaxCount 下，或在本次 PR 里显式抬高 baseline.json 的 targetMaxCount 并说明理由。）')
      process.exit(2)
    }
    const out = {
      _doc: '构建纪律闸 baseline（棘轮基线）：当前已接受的存量违规键集合。--block 只对不在此集合里的「新增」判红。修掉存量后 --update-baseline 收紧，只减不增。meta=per-entry 死线兑现(B.1/B.3)；targetMaxCount=净条数天花板(B.1)。见 lib/baseline-governance.cjs。',
      generated: '运行 --update-baseline 生成（日期见 git 提交）',
      count: keys.length,
      keys,
    }
    out.targetMaxCount = targetMaxCount // 总是写（含自动播种）——每份基线都带天花板
    if (meta && Object.keys(meta).length) out.meta = meta
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n')
    console.log(`\n✎ 已写 baseline：${keys.length} 条存量键${meta && Object.keys(meta).length ? ` · 保留 ${Object.keys(meta).length} 条 meta 死线` : ''} · 天花板 ${targetMaxCount} → ${path.relative(process.cwd(), BASELINE_PATH)}`)
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
  // Fail-closed 治理层：无条件红（与 --block/baseline 无关）。缺省方向=红。
  if (govErrors.length) {
    console.log(`\n  ⛔ 治理层 fail-closed 违规 ${govErrors.length} 条（无条件红·不受 --block/baseline/--only 影响）：`)
    for (const e of govErrors) console.log(`    ⛔ [${e.scope}] ${e.detail}`)
    console.log('  修法：')
    console.log('    · 白名单结构(A) → 给条目补 deadline（缺=红）/ 收紧超上限 deadline / 删条目降到条数上限。见 consumer-whitelist.json。')
    console.log('    · baseline死线(B.1) 到期 → 处置该存量（改前端死调用/补真只读路由）后 --update-baseline 清出，或经 PM 拍板在 baseline.json 里续期。')
    console.log('    · baseline天花板(B.1) → 修掉存量降到 targetMaxCount 下，或经说明抬高天花板。')
    console.log('    · 被依赖者(B.2) → 该端点已被消费、非死物 → node scripts/build-discipline/run-all.cjs --update-baseline 把它清出 C2 死物名单。')
    console.log('    · 授权组合子(C5) → 把 handler 里的角色/SoD 判定提升进 middleware/authz-combinators.ts 的具名组合子（requireAdmin/isAdmin/assertNotSelfReview 等）；路由层不得裸读 req.user.role/.roles、不得裸写 SELF_REVIEW_FORBIDDEN。')
  }
  if (blockedFail) {
    console.log('\n  ✗ 有新增违规被拦。修法：')
    console.log('    · C1 幽灵404 → 补上后端路由，或删掉前端那个死调用（前端调的路径必须真有后端路由）。')
    console.log('    · C2 无消费者 → 补上前端消费者/入口，或登记 scripts/build-discipline/consumer-whitelist.json（带 owner+deadline 的孵化），或删掉这个没人用的端点。')
    console.log('    · C3 空转参数 → 让引擎真读这个配置字段（否则它就是个骗人的旋钮），或去掉。')
    console.log('    · 确需接受为存量债 → node scripts/build-discipline/run-all.cjs --update-baseline（baseline.json 的 diff 须在 PR 里说明理由）。')
  }

  if (args.json) {
    console.log('\n===JSON===')
    const slim = results.map((r) => ({
      id: r.id, title: r.title, total: r.violations.length,
      new: r._new, fixed: r._fixed, violations: r.violations,
      lowConfidence: r.lowConfidence, exempt: r.exempt, stats: r.stats,
    }))
    console.log(JSON.stringify({ results: slim, block: [...args.block], blockedFail, govErrors }, null, 2))
  }

  process.exit(blockedFail || govErrors.length > 0 ? 1 : 0)
}

main()
