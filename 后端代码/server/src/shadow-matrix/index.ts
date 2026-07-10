/**
 * 权限影子断言矩阵 —— 装配层（把真实源文件接进纯核心 + 运行时端点集）。
 *
 * 只读源、绝不改判定（本轮只断言不接管）。产出结构化结果供 gate 测试断言与生产快照脚本复用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SEED_MATRIX, NON_ADMIN_ROLES, adminAllPermissions,
} from '../middleware/rbac-matrix.js'
import {
  parseRouteRegistry, parsePermissionsVisibility, parseAppMounts, parseAppImports, parseRouteFileGuards,
  joinPath, type MountGuard, type RegistryEntry,
} from './source-parsers.js'
import {
  type Caps, type GuardId, type VisibilityDiff, type GuardDiff, type Classification,
  SPECIAL_ALL, SPECIAL_FINANCE_ADMIN,
  buildVisibilityMatrix, buildGuardMatrix, classify, evaluateGate,
} from './matrix-core.js'
import type { RuntimeEndpoint } from './route-introspect.js'

// ── 仓库根定位（worktree 友好：向上找同时含 前端代码 + 后端代码 的目录）──
export function findRepoRoot(startFromUrl = import.meta.url): string {
  let dir = path.dirname(fileURLToPath(startFromUrl))
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '前端代码')) && fs.existsSync(path.join(dir, '后端代码'))) return dir
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  throw new Error('shadow-matrix: 找不到仓库根（需同时含 前端代码/ 与 后端代码/）')
}

export interface SourceInputs {
  root: string
  registry: RegistryEntry[]
  activeRoutes: string[]
  permsVis: ReturnType<typeof parsePermissionsVisibility>
  mounts: MountGuard[]
  imports: Record<string, string>
  routesDir: string
}

export function loadSourceInputs(root = findRepoRoot()): SourceInputs {
  const feLib = path.join(root, '前端代码', 'src', 'lib')
  const beSrc = path.join(root, '后端代码', 'server', 'src')
  const registrySrc = fs.readFileSync(path.join(feLib, 'route-registry.ts'), 'utf8')
  const permsSrc = fs.readFileSync(path.join(feLib, 'permissions.ts'), 'utf8')
  const appSrc = fs.readFileSync(path.join(beSrc, 'app.ts'), 'utf8')
  const registry = parseRouteRegistry(registrySrc)
  const activeRoutes = registry.filter((e) => e.status === 'active').map((e) => e.path)
  return {
    root,
    registry,
    activeRoutes,
    permsVis: parsePermissionsVisibility(permsSrc),
    mounts: parseAppMounts(appSrc),
    imports: parseAppImports(appSrc),
    routesDir: path.join(beSrc, 'routes'),
  }
}

// ============================================================================
// 断言 A · 可见性：解析器（route→module 映射，两侧唯一变量）
// ============================================================================
export interface VisibilityWiring {
  routes: string[]
  legacyModuleOf: (route: string) => string
  registryModuleOf: (route: string) => string
  /** 路由集相等前置（终裁 4）：{ onlyLegacy, onlyRegistry } 均空才算相等。 */
  routeSetDiff: { onlyLegacy: string[]; onlyRegistry: string[] }
}

const NEVER_MODULE = '__none__' // 无任何角色拥有 → 恒不可见（sentinel）

export function buildVisibilityWiring(src: SourceInputs): VisibilityWiring {
  const { permsVis, registry, activeRoutes } = src
  const navMod = permsVis.navPathModule
  const financeAdmin = new Set(permsVis.financeAdminPaths)

  // 现行（legacy·permissions.ts）route→module 或特例
  const legacyModuleOf = (route: string): string => {
    if (route === '/') return SPECIAL_ALL
    if (navMod[route]) return navMod[route]
    if (financeAdmin.has(route)) return SPECIAL_FINANCE_ADMIN
    return NEVER_MODULE
  }
  // 派生（registry·route-registry.ts）route→module 或特例（permModule=null → 特例·两侧共用同一分类器）
  const regByPath = new Map(registry.map((e) => [e.path, e]))
  const registryModuleOf = (route: string): string => {
    const e = regByPath.get(route)
    if (!e) return NEVER_MODULE
    if (e.permModule == null) return route === '/' ? SPECIAL_ALL : SPECIAL_FINANCE_ADMIN
    return e.permModule
  }

  // 路由集：legacy = navPathModule 键 ∪ financeAdminPaths ∪ {'/'}；registry = active 路由。
  const legacySet = new Set<string>(['/', ...Object.keys(navMod), ...permsVis.financeAdminPaths])
  const registrySet = new Set<string>(activeRoutes)
  const onlyLegacy = [...legacySet].filter((p) => !registrySet.has(p)).sort()
  const onlyRegistry = [...registrySet].filter((p) => !legacySet.has(p)).sort()
  // 遍历路由 = 两侧并集（差集非空时也要能对每格判——差集本身会产 BLOCK/review，不静默）
  const routes = [...new Set([...legacySet, ...registrySet])].sort()
  return { routes, legacyModuleOf, registryModuleOf, routeSetDiff: { onlyLegacy, onlyRegistry } }
}

export function capsFromSeedMatrix(): { roles: string[]; capsByRole: Record<string, Caps>; adminRoles: Set<string> } {
  const capsByRole: Record<string, Caps> = {}
  for (const r of NON_ADMIN_ROLES) capsByRole[r] = SEED_MATRIX[r] as Caps
  capsByRole['admin'] = adminAllPermissions() as Caps
  return { roles: ['admin', ...NON_ADMIN_ROLES], capsByRole, adminRoles: new Set(['admin']) }
}

// ============================================================================
// 断言 B · 守卫：装配 actual 守卫（挂载层 + 路由文件·别名解析）
// ============================================================================
export interface ActualGuardBuild {
  guards: Record<string, GuardId>
  /** 诊断：每个挂载前缀解析出的端点数（交叉核对用）。 */
  perMount: Record<string, number>
  /** 无法定位路由文件的挂载（诊断）。 */
  unresolvedMounts: string[]
}

export function buildActualGuards(src: SourceInputs): ActualGuardBuild {
  const guards: Record<string, GuardId> = {}
  const perMount: Record<string, number> = {}
  const unresolvedMounts: string[] = []

  for (const mount of src.mounts) {
    const file = mount.routerVar ? src.imports[mount.routerVar] : null
    if (!file) {
      // 无 router 变量（如 app.use(errorHandler)）或未 import → 跳过（非资源挂载）
      if (mount.routerVar) unresolvedMounts.push(`${mount.prefix} → ${mount.routerVar}`)
      continue
    }
    const abs = path.join(src.routesDir, `${file}.ts`)
    let routeSrc: string
    try { routeSrc = fs.readFileSync(abs, 'utf8') } catch { unresolvedMounts.push(`${mount.prefix} → ${file}.ts (缺文件)`); continue }
    const routeGuards = parseRouteFileGuards(routeSrc)
    let count = 0
    for (const rg of routeGuards) {
      const key = `${rg.method} ${joinPath(mount.prefix, rg.relPath)}`
      const module = rg.module ?? mount.module
      const level = rg.module ? rg.level : mount.level // 路由有 requirePermission → 用其级别；否则继承挂载级别
      // 首次写入或已有则取「更严」的（同 key 同文件重复注册几乎不发生，稳健起见保留先到）
      if (!(key in guards)) {
        guards[key] = { module, level: level ?? null, conditions: rg.conditions }
        count++
      }
    }
    perMount[mount.prefix] = count
  }
  return { guards, perMount, unresolvedMounts }
}

/** 给运行时端点补默认守卫（运行时有、静态没解析出 → module/level 空 → UNGUARDED 待裁）。 */
export function resolveActualForEndpoint(build: ActualGuardBuild, endpointKey: string): GuardId {
  return build.guards[endpointKey] ?? { module: null, level: null, conditions: [] }
}

// ============================================================================
// 已批准工件（committed·门读它们判「未静默过」）
// ============================================================================
export const SHADOW_DIR = path.dirname(fileURLToPath(import.meta.url))
export const SNAPSHOT_FILE = path.join(SHADOW_DIR, 'expected-guards.snapshot.json')
export const ALLOWLIST_FILE = path.join(SHADOW_DIR, 'public-endpoints.allowlist.json')
export const DECISIONS_FILE = path.join(SHADOW_DIR, 'review-decisions.json')

export function loadExpectedGuards(): Record<string, GuardId> {
  const doc = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'))
  return doc.guards ?? {}
}
export function loadPublicAllowlist(): Set<string> {
  const doc = JSON.parse(fs.readFileSync(ALLOWLIST_FILE, 'utf8'))
  return new Set<string>((doc.endpoints ?? []).map((e: any) => (typeof e === 'string' ? e : e.endpoint)))
}
export function loadReviewDecisions(): Set<string> {
  const doc = JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf8'))
  return new Set<string>((doc.acknowledged ?? []).map((e: any) => (typeof e === 'string' ? e : e.key)))
}

export interface MatrixAssessment {
  runtimeCount: number
  actualGuards: Record<string, GuardId>
  visibilityDiffs: VisibilityDiff[]
  guardDiffs: GuardDiff[]
  classification: Classification
  routeSetDiff: { onlyLegacy: string[]; onlyRegistry: string[] }
  /** 门违规（非空即红）——每类都不许静默过。 */
  routeSetUnequal: boolean
  blockCount: number
  escalatedCount: number
  unguardedNotAllowlisted: GuardDiff[]
  reviewNotDecided: (VisibilityDiff | GuardDiff)[]
  /** 一句话门结论。 */
  clean: boolean
}

/**
 * 跑整张矩阵并对齐已批准工件，产出门结论。runtimeEndpoints 由调用方（测试/脚本）自省 app 传入
 *   —— 保持本模块不 import app（纯装配·可被无 app 环境复用）。
 *
 * capsByRole 默认 = SEED_MATRIX（fixture·CI 用）；生产快照脚本注入真实库角色（终裁 7·独立翻转门产物）。
 */
export function runMatrix(
  runtimeEndpoints: RuntimeEndpoint[],
  opts: {
    src?: SourceInputs
    expectedGuards?: Record<string, GuardId>
    publicAllowlist?: Set<string>
    reviewDecisions?: Set<string>
    capsByRole?: Record<string, Caps>
    roles?: string[]
    adminRoles?: Set<string>
    isActiveWriteRoute?: (role: string, route: string) => boolean
  } = {},
): MatrixAssessment {
  const src = opts.src ?? loadSourceInputs()
  const expectedGuards = opts.expectedGuards ?? loadExpectedGuards()
  const publicAllowlist = opts.publicAllowlist ?? loadPublicAllowlist()
  const reviewDecisions = opts.reviewDecisions ?? loadReviewDecisions()

  // 断言 B · 守卫
  const build = buildActualGuards(src)
  const actualGuards: Record<string, GuardId> = {}
  for (const e of runtimeEndpoints) actualGuards[e.key] = resolveActualForEndpoint(build, e.key)
  const guardDiffs = buildGuardMatrix({
    runtimeEndpoints: runtimeEndpoints.map((e) => e.key),
    actualGuards,
    expectedGuards,
  })

  // 断言 A · 可见性
  const vw = buildVisibilityWiring(src)
  const caps = capsFromSeedMatrix()
  const visibilityDiffs = buildVisibilityMatrix({
    roles: opts.roles ?? caps.roles,
    routes: vw.routes,
    capsByRole: opts.capsByRole ?? caps.capsByRole,
    adminRoles: opts.adminRoles ?? caps.adminRoles,
    legacyModuleOf: vw.legacyModuleOf,
    registryModuleOf: vw.registryModuleOf,
    isActiveWriteRoute: opts.isActiveWriteRoute,
  })

  const classification = classify(visibilityDiffs, guardDiffs)
  const routeSetUnequal = vw.routeSetDiff.onlyLegacy.length > 0 || vw.routeSetDiff.onlyRegistry.length > 0
  const gate = evaluateGate({ classification, publicAllowlist, reviewDecisions, routeSetUnequal })

  return {
    runtimeCount: runtimeEndpoints.length,
    actualGuards,
    visibilityDiffs,
    guardDiffs,
    classification,
    routeSetDiff: vw.routeSetDiff,
    routeSetUnequal,
    blockCount: gate.blockCount,
    escalatedCount: gate.escalatedCount,
    unguardedNotAllowlisted: gate.unguardedNotAllowlisted,
    reviewNotDecided: gate.reviewNotDecided,
    clean: gate.clean,
  }
}

/**
 * 从 operation_logs 派生「活跃写路由」集（终裁 6 · escalated 的真实数据源）——收窄命中它 → 提级。
 * operation_logs 的 operation 列形如 "POST account-reconcile"（method + baseUrl 段）。best-effort：
 *   按前端路由首段与已用写端点段匹配。CI 的 :memory: 库通常无写历史 → 空集（无 escalation·诚实·非死代码）；
 *   生产库有真实写历史 → 命中活跃写端点的收窄被提级。多段前端路由（/abc/dashboard）与后端段（abc）不完全对齐属已知近似。
 */
export function activeWriteRoutesFromLogs(db: any, activeRoutes: string[]): Set<string> {
  const set = new Set<string>()
  try {
    const rows = db
      .prepare(
        `SELECT DISTINCT operation FROM operation_logs
         WHERE outcome IS NULL AND (operation LIKE 'POST %' OR operation LIKE 'PUT %' OR operation LIKE 'PATCH %' OR operation LIKE 'DELETE %')`,
      )
      .all() as Array<{ operation: string }>
    const usedSegments = new Set<string>()
    for (const r of rows) {
      const seg = String(r.operation).split(/\s+/)[1]
      if (seg) usedSegments.add(seg.split('/')[0])
    }
    for (const route of activeRoutes) {
      const seg = route.replace(/^\//, '').split('/')[0]
      if (seg && usedSegments.has(seg)) set.add(route)
    }
  } catch {
    /* operation_logs 缺列/空 → 空集（无 escalation·fail-safe） */
  }
  return set
}
