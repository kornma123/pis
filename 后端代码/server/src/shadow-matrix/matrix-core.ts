/**
 * 权限影子断言矩阵 —— 纯核心逻辑（无 I/O、无 app、无 fs · 输入全注入 → 埋雷自测可纯跑）。
 *
 * ============================================================================
 * 这是什么 / 为什么（迁移序第 2 步 · Phase 2 权限翻转的门）
 * ----------------------------------------------------------------------------
 * 路由注册表 Phase 1（#107）让「新页默认有归宿」，但**权限判定**仍由 permissions.ts 手工映射
 * （NAV_PATH_MODULE）+ 后端 app.ts 挂载守卫各自决定，注册表的 permModule 只是**声明**、尚未接管。
 * Phase 2 的计划是让注册表成为单一事实源、权限从它**派生**。翻转前必须先有一张**机器可证的门**：
 *   「派生出来的权限」与「现行手工权限」在每一格上一致，且任何**放宽（privilege 扩大）**被无条件拦下。
 *
 * 本矩阵就是那张门。**本轮只断言、不接管**（never flip）——它只读三份源
 * （route-registry.ts / permissions.ts / authz-combinators.ts 表达的守卫）并比对，绝不改判定。
 *
 * 两个**独立**断言、维度不同、**并列**跑（专家终裁：上一版把可见性维度丢了 = 化石，必须两个都在）：
 *
 *   ┌ 断言 A · 可见性（**角色相关** · per role×route）────────────────────────────┐
 *   │ 现行 legacyVisible(role,route)  = permissions.ts（NAV_PATH_MODULE + 角色特例）│
 *   │ 派生 registryVisible(role,route)= route-registry.ts（permModule + 同角色特例）│
 *   │ 判定：不可见→可见 = 放宽 = BLOCK；可见→不可见 = 收窄 = review               │
 *   │       （收窄命中「活跃写端点」[operation_logs] → 提级 escalated：掐死正在跑的流程）│
 *   └────────────────────────────────────────────────────────────────────────────┘
 *   ┌ 断言 B · 守卫（**角色无关** · per endpoint×method）──────────────────────────┐
 *   │ guardId = { module, level(R|W), conditions:Set<具名条件> }                    │
 *   │ 现行 actual   = 运行时端点真相 + 源码守卫静态抽取                             │
 *   │ 期望 expected = 已批准的守卫快照（ratified snapshot·committed）               │
 *   │ 判定：模块不同→BLOCK；level 降级(W→R)→BLOCK；conditions 少任一条→BLOCK；      │
 *   │       任一侧无守卫→UNGUARDED（独立类别·不许「无 diff」静默过·SEC-1）          │
 *   │       别给守卫排「强弱」造语义（会漏）——就用「等式或阻塞」。                 │
 *   └────────────────────────────────────────────────────────────────────────────┘
 *
 * 两道门（run 层执行）：CI 门 = BLOCK==0；review/UNGUARDED **不许静默过**——全部须进已批准清单
 *   （decisions / public-allowlist），未登记即红（逼显式裁决）。
 *
 * 完备性由**埋雷自测**（SEC-2）机器证明：四维各植一个 diff（改可见性/降 W→R/删条件/换模块），
 *   断言矩阵逐个抓到且 verdict 正确 → 这张网不漏。见 tests/shadow-permission-matrix.test.ts。
 * ============================================================================
 */

// ── 基础类型 ────────────────────────────────────────────────────────────────

export type Level = 'R' | 'W'
/** 一个角色对各模块的能力（R/W）。admin 由调用方展开为全 W（本核心不特判 admin）。 */
export type Caps = Record<string, Level | undefined>

/**
 * 守卫身份。module=null 表示「非模块守卫」（纯角色/条件守卫，如 requireAnyRole('finance') 而无 requirePermission）。
 * conditions = 具名组合子产生的条件集（authz-combinators 的具名词汇表 + requireAnyRole/requireAdmin），
 *   已排序去重的字符串数组（当集合用）。
 */
export interface GuardId {
  module: string | null
  level: Level | null
  conditions: string[]
}

export type VisibilityVerdict = 'equal' | 'BLOCK' | 'review' | 'escalated'
export type GuardVerdict = 'equal' | 'BLOCK' | 'review' | 'UNGUARDED'

export interface VisibilityDiff {
  role: string
  route: string
  legacyVisible: boolean
  registryVisible: boolean
  verdict: VisibilityVerdict
  reason: string
}

export interface GuardDiff {
  endpoint: string // "METHOD /api/v1/full/path"
  expected: GuardId | null // null = 快照无此端点（新端点）
  actual: GuardId | null // null = 运行时无此端点（已删端点，快照仍留 = 防两边同时丢）
  verdict: GuardVerdict
  reasons: string[]
}

// ── 集合工具 ──────────────────────────────────────────────────────────────

export function sortedUniq(xs: string[]): string[] {
  return [...new Set(xs)].sort()
}

/** a ⊇ b ？（a 是否为 b 的超集） */
export function isSuperset(a: string[], b: string[]): boolean {
  const sa = new Set(a)
  return b.every((x) => sa.has(x))
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && isSuperset(a, b) && isSuperset(b, a)
}

/** 守卫是否「无守卫」：module 空 **且** 无任何条件。（module 空但有 requireAnyRole 条件 = 有守卫。） */
export function isUnguarded(g: GuardId | null): boolean {
  return g == null || (g.module == null && g.conditions.length === 0)
}

// ── 断言 A · 可见性 ──────────────────────────────────────────────────────────

/**
 * 单格可见性判定。方向语义（现行 legacy → 派生 registry，registry 是「翻转后」的样子）：
 *   - 不可见→可见 = registry 让某角色多看见一个页 = **放宽/提权** → BLOCK。
 *   - 可见→不可见 = registry 让某角色少看见一个页 = **收窄** → review（可能掐掉在跑的流程）。
 *   - 收窄且该路由是「活跃写端点」（operation_logs 有记录）→ **escalated**（比 review 更硬·须人裁）。
 */
export function diffVisibility(
  role: string,
  route: string,
  legacyVisible: boolean,
  registryVisible: boolean,
  isActiveWriteRoute = false,
): VisibilityDiff {
  let verdict: VisibilityVerdict = 'equal'
  let reason = '一致'
  if (!legacyVisible && registryVisible) {
    verdict = 'BLOCK'
    reason = `放宽：现行对 ${role} 隐藏 ${route}，派生却可见（提权，无条件拦）`
  } else if (legacyVisible && !registryVisible) {
    if (isActiveWriteRoute) {
      verdict = 'escalated'
      reason = `收窄且命中活跃写端点：现行对 ${role} 可见 ${route}，派生隐藏——会掐死正在跑的流程（提级人裁）`
    } else {
      verdict = 'review'
      reason = `收窄：现行对 ${role} 可见 ${route}，派生隐藏（须确认不破坏流程）`
    }
  }
  return { role, route, legacyVisible, registryVisible, verdict, reason }
}

/**
 * 可见性解析器输入。route→module 映射是两侧唯一的变量；能力引擎（caps）两侧共享，
 * 故 diff 只在「同一路由被两侧映到不同模块」或「路由集不等」时出现（后者由 run 层前置断言拦）。
 *
 * moduleOf 返回：真实模块码字符串 | 特例标记 SPECIAL_ALL（如 '/'·所有角色可见） |
 *   SPECIAL_FINANCE_ADMIN（如导入器三页 + LIS·财务/管理员可见）。特例两侧用同一解析、天然不产 diff，
 *   仅当一侧把某路由从特例改成真实模块（或反之）才产生 diff——正是我们要抓的翻转错误。
 */
export const SPECIAL_ALL = 'SPECIAL::all'
export const SPECIAL_FINANCE_ADMIN = 'SPECIAL::finance_admin'

/** 给定路由的「模块或特例标记」与角色能力，判可见。admin 恒可见（调用方在 caps 里展开 admin=全 W，或此处特判）。 */
export function visibleUnder(moduleOrSpecial: string, role: string, caps: Caps, isAdmin: boolean): boolean {
  if (isAdmin) return true
  if (moduleOrSpecial === SPECIAL_ALL) return true
  if (moduleOrSpecial === SPECIAL_FINANCE_ADMIN) return role === 'finance' // admin 已在上面短路
  // 真实模块：能力表里有该模块（任意级别即满足读可见，与 canAccess(mod,'R') 一致）。
  return caps[moduleOrSpecial] != null
}

export interface VisibilityMatrixInput {
  roles: string[]
  routes: string[]
  /** 每角色的能力表（不含 admin 展开；admin 由 adminRoles 标记）。 */
  capsByRole: Record<string, Caps>
  adminRoles: Set<string>
  legacyModuleOf: (route: string) => string // 真实模块 | SPECIAL_*
  registryModuleOf: (route: string) => string
  /** 该 (role,route) 收窄时是否算「活跃写端点」→ 提级。默认恒 false（无 operation_logs 数据时）。 */
  isActiveWriteRoute?: (role: string, route: string) => boolean
}

export function buildVisibilityMatrix(input: VisibilityMatrixInput): VisibilityDiff[] {
  const { roles, routes, capsByRole, adminRoles, legacyModuleOf, registryModuleOf } = input
  const isActiveWrite = input.isActiveWriteRoute ?? (() => false)
  const diffs: VisibilityDiff[] = []
  for (const role of roles) {
    const caps = capsByRole[role] ?? {}
    const admin = adminRoles.has(role)
    for (const route of routes) {
      const legVis = visibleUnder(legacyModuleOf(route), role, caps, admin)
      const regVis = visibleUnder(registryModuleOf(route), role, caps, admin)
      const d = diffVisibility(role, route, legVis, regVis, legVis && !regVis && isActiveWrite(role, route))
      if (d.verdict !== 'equal') diffs.push(d)
    }
  }
  return diffs
}

// ── 断言 B · 守卫 ────────────────────────────────────────────────────────────

/**
 * 单端点守卫判定：expected（已批准快照）vs actual（当前运行时+源码）。方向 = actual 必须**不弱于** expected。
 *   - actual 无守卫而 expected 有 → 守卫被拿掉 → BLOCK（弱化到零）。
 *   - 两侧都无守卫 → UNGUARDED（独立类别·须进 public 白名单否则红·SEC-1 不许静默过）。
 *   - expected 无守卫而 actual 有 → 收紧 → review。
 *   - 模块不同 → BLOCK（不给跨模块排强弱，等式或阻塞）。
 *   - level 降级 W→R → BLOCK；升级 R→W → review（drift·非回归但须知会）。
 *   - actual.conditions 不是 expected.conditions 的超集（少任一条）→ BLOCK；多出条件（严格超集）→ review。
 */
export function diffGuard(endpoint: string, expected: GuardId | null, actual: GuardId | null): GuardDiff {
  // 端点从运行时消失（快照仍留它·防「两边同时丢」）→ review（更新快照），非安全回归、不 BLOCK。
  if (actual === null) {
    return { endpoint, expected, actual, verdict: 'review', reasons: ['端点已从运行时移除（快照仍保留·防两边同时丢）→ 须更新快照'] }
  }
  // 新端点（快照无）：无守卫 → UNGUARDED（须进 public 白名单）；有守卫 → review（须批准其守卫进快照）。
  if (expected === null) {
    if (isUnguarded(actual)) {
      return { endpoint, expected, actual, verdict: 'UNGUARDED', reasons: ['新端点且无守卫（须在 public 白名单登记，否则视为缺口）'] }
    }
    return { endpoint, expected, actual, verdict: 'review', reasons: ['新端点（守卫须批准进快照）'] }
  }

  const eU = isUnguarded(expected)
  const aU = isUnguarded(actual)
  const reasons: string[] = []
  let verdict: GuardVerdict

  if (aU && !eU) {
    verdict = 'BLOCK'
    reasons.push('守卫被移除：期望有守卫，当前无守卫（弱化到零）')
  } else if (!aU && eU) {
    verdict = 'review'
    reasons.push('守卫被新增：期望无守卫，当前有守卫（收紧·drift）')
  } else if (aU && eU) {
    verdict = 'UNGUARDED'
    reasons.push('两侧均无守卫（须在 public 白名单登记，否则视为缺口）')
  } else {
    // 两侧都有守卫
    const e = expected as GuardId
    const a = actual as GuardId
    if (e.module !== a.module) reasons.push(`模块不同：期望 ${e.module ?? '(role-only)'} · 当前 ${a.module ?? '(role-only)'}`)
    if (e.level === 'W' && a.level === 'R') reasons.push('level 降级 W→R（放宽）')
    else if (e.level !== a.level) reasons.push(`level 变更 ${e.level ?? '∅'}→${a.level ?? '∅'}（收紧/drift）`)
    if (!isSuperset(a.conditions, e.conditions)) {
      const missing = e.conditions.filter((c) => !a.conditions.includes(c))
      reasons.push(`条件缺失：少了 [${missing.join(', ')}]（放宽）`)
    } else if (!sameSet(a.conditions, e.conditions)) {
      const extra = a.conditions.filter((c) => !e.conditions.includes(c))
      reasons.push(`条件新增：多了 [${extra.join(', ')}]（收紧/drift）`)
    }
    // 归类：任一「放宽」原因 → BLOCK；否则任一原因（收紧/drift）→ review；无原因 → equal。
    const widened =
      e.module !== a.module ||
      (e.level === 'W' && a.level === 'R') ||
      !isSuperset(a.conditions, e.conditions)
    verdict = widened ? 'BLOCK' : reasons.length ? 'review' : 'equal'
  }
  return { endpoint, expected, actual, verdict, reasons }
}

export interface GuardMatrixInput {
  /** 运行时端点真相（METHOD /full/path 键集）。 */
  runtimeEndpoints: string[]
  /** 当前源码抽取的守卫（键 = 端点）。运行时有、这里没有 → UNGUARDED/解析缺口（fail-closed）。 */
  actualGuards: Record<string, GuardId>
  /** 已批准的守卫快照（键 = 端点）。 */
  expectedGuards: Record<string, GuardId>
}

/**
 * 端点集以**运行时真相**为准并叠加快照键（防「端点从源码与快照同时丢 → 无 diff 假绿」）：
 *   - 运行时有、快照无 → 新端点（expected=null）。
 *   - 快照有、运行时无 → 已删端点（actual=null）——快照留着它，故一定产 diff、绝不静默。
 */
export function buildGuardMatrix(input: GuardMatrixInput): GuardDiff[] {
  const { runtimeEndpoints, actualGuards, expectedGuards } = input
  const keys = sortedUniq([...runtimeEndpoints, ...Object.keys(expectedGuards)])
  const diffs: GuardDiff[] = []
  for (const k of keys) {
    const runtimeHas = runtimeEndpoints.includes(k)
    const actual = runtimeHas ? actualGuards[k] ?? { module: null, level: null, conditions: [] } : null
    const expected = k in expectedGuards ? expectedGuards[k] : null
    const d = diffGuard(k, expected, actual)
    if (d.verdict !== 'equal') diffs.push(d)
  }
  return diffs
}

// ── 分类 / 门 ────────────────────────────────────────────────────────────────

export interface Classification {
  block: (VisibilityDiff | GuardDiff)[]
  review: (VisibilityDiff | GuardDiff)[]
  escalated: VisibilityDiff[]
  unguarded: GuardDiff[]
}

/** 把可见性 + 守卫 diff 汇总分类。escalated 单列（比 review 更硬）；UNGUARDED 单列（SEC-1）。 */
export function classify(visibility: VisibilityDiff[], guard: GuardDiff[]): Classification {
  const out: Classification = { block: [], review: [], escalated: [], unguarded: [] }
  for (const d of visibility) {
    if (d.verdict === 'BLOCK') out.block.push(d)
    else if (d.verdict === 'escalated') out.escalated.push(d)
    else if (d.verdict === 'review') out.review.push(d)
  }
  for (const d of guard) {
    if (d.verdict === 'BLOCK') out.block.push(d)
    else if (d.verdict === 'UNGUARDED') out.unguarded.push(d)
    else if (d.verdict === 'review') out.review.push(d)
  }
  return out
}

/** 端点键（GuardDiff）或 role|route 键（VisibilityDiff）——用于和已批准清单比对。 */
export function diffKey(d: VisibilityDiff | GuardDiff): string {
  return 'endpoint' in d ? d.endpoint : `${d.role}|${d.route}`
}

// ── 门闸装配（纯·可注入·独立埋雷）────────────────────────────────────────────
export interface GateInput {
  classification: Classification
  publicAllowlist: Set<string>
  reviewDecisions: Set<string>
  routeSetUnequal: boolean
}
export interface GateResult {
  clean: boolean
  blockCount: number
  escalatedCount: number
  unguardedNotAllowlisted: GuardDiff[]
  reviewNotDecided: (VisibilityDiff | GuardDiff)[]
  routeSetUnequal: boolean
}

/**
 * 门闸判定（从 runMatrix 抽出·纯函数·独立埋雷防「把过滤改恒空静默少报」的突变过门）：
 *   - BLOCK / escalated：**永不能**靠登记洗白（放宽/掐流程=硬红）。
 *   - UNGUARDED：须在 public 白名单登记，否则计入违规。
 *   - review：须在裁决清单登记，否则计入违规。
 *   - 路由集不等：硬红。
 */
export function evaluateGate(input: GateInput): GateResult {
  const { classification, publicAllowlist, reviewDecisions, routeSetUnequal } = input
  const unguardedNotAllowlisted = classification.unguarded.filter((d) => !publicAllowlist.has(d.endpoint))
  const reviewNotDecided = classification.review.filter((d) => !reviewDecisions.has(diffKey(d)))
  const clean =
    !routeSetUnequal &&
    classification.block.length === 0 &&
    classification.escalated.length === 0 &&
    unguardedNotAllowlisted.length === 0 &&
    reviewNotDecided.length === 0
  return {
    clean,
    blockCount: classification.block.length,
    escalatedCount: classification.escalated.length,
    unguardedNotAllowlisted,
    reviewNotDecided,
    routeSetUnequal,
  }
}
