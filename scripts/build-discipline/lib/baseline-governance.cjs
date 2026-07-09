/**
 * 构建纪律闸 — baseline 治理层（CON-5 · 公理一 fail-closed）
 *
 * baseline 是「已接受的存量违规」棘轮基线（`--block` 只拦不在里面的新增）。它同样有 fail-open 风险：
 * 一堆存量违规无限期赦免、且没人对某一条负责/兑现。本层给 baseline 补三条 fail-closed 规则：
 *
 *   1. **per-entry 死线兑现**（B.1/B.3）：`baseline.meta[key] = {owner, deadline, note}` 给「害人型」存量
 *      挂负责人 + 死线。deadline 过期仍没处置 → 红（催：改前端死调用 / 补真只读路由，然后 --update-baseline
 *      把它清出 baseline）。不是所有存量都要 meta——只给需要现在就动的（如 live-404 幽灵报表）。
 *   2. **净条数天花板**（B.1）：`baseline.targetMaxCount` 封顶存量条数。棘轮本就只减不增，天花板让
 *      「悄悄涨」变成显式违规——要抬高天花板须在 PR diff 里可见 + 说明理由（防赦免簿无限膨胀）。
 *   3. **被依赖者禁入死物名单**（B.2）：某 C2 baseline 键对应端点**现被消费**（活跃业务流程依赖）→ 红。
 *      被依赖=非死物，按定义不许进「死物豁免簿」；修法=--update-baseline 自然把它清出（它已不是违规）。
 *
 * 为什么 fail-closed 缺省方向：忘填/过期/膨胀都是人为疏漏，安全底线是把疏漏顶回给作者，
 * 而不是让「临时」悄悄沉淀成永久债。本层错误由 run-all 当 hardFail 处理——不受 baseline 自身收编、
 * 不受 --only 豁免、不可 --update-baseline 洗白。
 *
 * 纯函数、零依赖、可被 selftest 直接注入内存对象测试（变异断言证有牙）。
 */

// 死线上限与白名单同口径——收口到 lib/constants.cjs（单一事实源，防两处漂移·独立复核 item 4）。
const { MAX_DEADLINE_HORIZON_DAYS } = require('./constants.cjs')

/** ISO 日期字符串 +N 天 → ISO 日期字符串（UTC）。 */
function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * B.1/B.3 — 校验 baseline.meta（per-entry owner+deadline）。返回错误数组（空=健康）。
 * meta 是可选的、只覆盖「需要治理」的存量键；未挂 meta 的存量沿用原 warn 级欠账（不强制全员挂死线）。
 */
function validateBaselineMeta(doc, today) {
  const errors = []
  const meta = doc && doc.meta && typeof doc.meta === 'object' ? doc.meta : {}
  const keys = new Set(Array.isArray(doc && doc.keys) ? doc.keys : [])
  const maxDeadline = addDays(today, MAX_DEADLINE_HORIZON_DAYS)
  for (const [key, m] of Object.entries(meta)) {
    if (!keys.has(key)) {
      errors.push({ type: 'orphan-meta', key, detail: `baseline.meta 键 ${key} 不在 baseline.keys 里（悬空 meta；该键已被清出却漏删 meta）` })
      continue
    }
    if (!m || !m.deadline) {
      errors.push({ type: 'missing-deadline', key, detail: `${key}：baseline meta 缺 deadline（fail-closed：忘填=红，owner ${m && m.owner || '?'}）` })
      continue
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.deadline)) {
      errors.push({ type: 'bad-deadline-format', key, detail: `${key}：baseline meta deadline "${m.deadline}" 非 YYYY-MM-DD` })
      continue
    }
    if (m.deadline > maxDeadline) {
      errors.push({ type: 'deadline-too-far', key, detail: `${key}：baseline meta deadline ${m.deadline} > 上限 ${maxDeadline}（today+${MAX_DEADLINE_HORIZON_DAYS}d，防变相永久豁免）` })
      continue
    }
    if (m.deadline < today) {
      errors.push({ type: 'expired', key, owner: m.owner, detail: `${key}：baseline 赦免到期（deadline ${m.deadline} < ${today}，owner ${m.owner || '?'}）——须处置：改前端死调用/补真只读路由后 --update-baseline 清出，或经 PM 拍板续期` })
    }
  }
  return errors
}

/**
 * B.1 — 净条数天花板。返回错误对象或 null。
 * fail-closed（独立复核 item#2 逮到旧版 fail-open）：
 *   - keys 非空但缺 targetMaxCount → 红（缺天花板本身=疏漏；否则「删掉这行=悄悄取消封顶」的旁路口敞开）。
 *     run-all 的 --update-baseline 会给新基线自动播种 targetMaxCount，故正常流程永不缺这个字段。
 *   - keys 为空（零存量）→ 无需天花板，返回 null。
 *   - keys.length > targetMaxCount → 红（越顶）。
 */
function checkBaselineCap(doc) {
  const keys = Array.isArray(doc && doc.keys) ? doc.keys : []
  if (keys.length === 0) return null
  const hasTarget = doc && Number.isInteger(doc.targetMaxCount)
  if (!hasTarget) {
    return { type: 'missing-cap', detail: `baseline 有 ${keys.length} 条存量却无 targetMaxCount 天花板（fail-closed：缺天花板=红，防「删字段=悄悄取消封顶」旁路口）——补一个 targetMaxCount（run-all --update-baseline 会自动播种）` }
  }
  const target = doc.targetMaxCount
  if (keys.length > target) {
    return { type: 'over-cap', detail: `baseline ${keys.length} 条 > targetMaxCount ${target}（棘轮只减不增；抬高天花板须在 PR diff 里显式说明理由）` }
  }
  return null
}

/**
 * B.2 — 「被活跃业务流程依赖的端点禁止入死物名单」。
 * consumedC2Keys = Set<'METHOD|relPath'>（来自 C2 run().consumedKeys：前端精确命中 + 文本兜底）。
 * 某 C2 baseline 键的端点若在此集合里 = 现被消费 = 活跃依赖 → 不该赖在 C2「无消费者」死物名单里。
 * 说明：本项目已核实无跨路由内部 import / cron，故「后端路由/状态机引用」当前恒空；消费信号=前端
 *       （与 C2 判定同源，零新增模糊扫描 → 零误报）。若日后引入后端内部消费，扩 consumedC2Keys 即可。
 */
function consumedInDeadAmnesty(doc, consumedC2Keys) {
  const keys = Array.isArray(doc && doc.keys) ? doc.keys : []
  const set = consumedC2Keys instanceof Set ? consumedC2Keys : new Set(consumedC2Keys || [])
  const bad = []
  for (const k of keys) {
    if (!k.startsWith('C2|')) continue
    const rest = k.slice(3) // 'METHOD|relPath'
    if (set.has(rest)) {
      bad.push({ type: 'consumed-in-dead-amnesty', key: k, detail: `${k}：端点现被消费（活跃依赖）→ 非死物、不该在 C2 死物名单里，请 --update-baseline 清出` })
    }
  }
  return bad
}

/**
 * 汇总 baseline 治理错误（三规则合流）。返回错误数组（空=健康）。
 * @param doc            解析后的 baseline.json 对象
 * @param today          YYYY-MM-DD
 * @param consumedC2Keys Set<'METHOD|relPath'>（C2 run().consumedKeys）
 */
function validateBaseline(doc, today, consumedC2Keys) {
  const errors = []
  errors.push(...validateBaselineMeta(doc, today))
  const cap = checkBaselineCap(doc)
  if (cap) errors.push(cap)
  errors.push(...consumedInDeadAmnesty(doc, consumedC2Keys))
  return errors
}

module.exports = {
  MAX_DEADLINE_HORIZON_DAYS,
  addDays,
  validateBaselineMeta,
  checkBaselineCap,
  consumedInDeadAmnesty,
  validateBaseline,
}
