/**
 * 权限影子断言矩阵 —— 生产角色快照报告（终裁 7：独立翻转门产物）。
 *
 * 为什么与 CI 分开：CI 无生产库 → 只能跑 fixture（SEED_MATRIX）。但生产库的 roles.permissions 可经
 *   「角色权限」页改，真实角色能力可能已偏离 SEED_MATRIX。若把生产角色和 fixture 合一个循环，CI 会
 *   **静默退化成 fixture-only**、假装覆盖了生产。故：CI 跑 fixture；**翻转前**用本脚本对**真实库角色**
 *   跑断言 A（可见性·角色相关），产出**带日期报告**——这是 Phase-2 翻转门的必备件（无报告=门不开·fail-closed）。
 *
 * 断言 B（守卫·角色无关）不随角色变，已由 CI 覆盖，这里不重复。
 *
 * 用法：
 *   npx tsx src/shadow-matrix/production-report.ts [--db <path>] [--out <dir>]
 *   默认 db = DATABASE_PATH 或 data/coreone.db；默认 out = docs/shadow-matrix-reports/
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { parsePermissions, adminAllPermissions, mergePermissions, type PermMap } from '../middleware/rbac-matrix.js'
import { loadSourceInputs, buildVisibilityWiring, findRepoRoot, activeWriteRoutesFromLogs } from './index.js'
import { buildVisibilityMatrix, visibleUnder, type Caps } from './matrix-core.js'

/** 从生产库读真实角色 → capsByRole（admin → 全 W；含 user_roles 组合的用户不在此列，此处按 role code 维度）。 */
export function loadProductionCaps(dbPath: string): { roles: string[]; capsByRole: Record<string, Caps>; adminRoles: Set<string> } {
  // readOnly 在 Node 22 的 node:sqlite 运行时支持（实证：跑报告后库 hash 不变、无 -wal/-shm），
  // 但本仓 @types/node 的 DatabaseSyncOptions 尚未收该字段 → 显式 cast（仅类型滞后·非行为问题）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new DatabaseSync(dbPath, { readOnly: true } as any)
  try {
    const rows = db.prepare("SELECT code, permissions FROM roles WHERE is_deleted = 0 ORDER BY code").all() as Array<{ code: string; permissions: string }>
    const capsByRole: Record<string, Caps> = {}
    const adminRoles = new Set<string>()
    for (const r of rows) {
      if (r.code === 'admin') { capsByRole[r.code] = adminAllPermissions() as Caps; adminRoles.add('admin'); continue }
      const pm: PermMap = {}
      mergePermissions(pm, parsePermissions(r.permissions))
      capsByRole[r.code] = pm as Caps
    }
    return { roles: rows.map((r) => r.code), capsByRole, adminRoles }
  } finally {
    db.close()
  }
}

/** 从生产库 operation_logs 派生活跃写路由（escalated 数据源·真实数据·终裁 6/7）。 */
export function loadProductionActiveWriteRoutes(dbPath: string, activeRoutes: string[]): Set<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = new DatabaseSync(dbPath, { readOnly: true } as any)
  try { return activeWriteRoutesFromLogs(db, activeRoutes) } finally { db.close() }
}

export interface ProductionReport {
  date: string
  dbPath: string
  roles: string[]
  routeSetDiff: { onlyLegacy: string[]; onlyRegistry: string[] }
  visibilityDiffs: ReturnType<typeof buildVisibilityMatrix>
  blockCount: number
  escalatedCount: number
  reviewCount: number
  /** 门结论：无 BLOCK/escalated → 翻转门（可见性维度）就绪。 */
  flipGateReady: boolean
  /** 绝对可见性表（role × route → visible）——留档，供人核对真实库下每角色看得见什么。 */
  visibilityTable: Record<string, Record<string, boolean>>
}

export function computeProductionReport(dbPath: string, dateISO: string, root = findRepoRoot()): ProductionReport {
  const src = loadSourceInputs(root)
  const vw = buildVisibilityWiring(src)
  const { roles, capsByRole, adminRoles } = loadProductionCaps(dbPath)
  const activeWrite = loadProductionActiveWriteRoutes(dbPath, src.activeRoutes)

  const visibilityDiffs = buildVisibilityMatrix({
    roles, routes: vw.routes, capsByRole, adminRoles,
    legacyModuleOf: vw.legacyModuleOf, registryModuleOf: vw.registryModuleOf,
    isActiveWriteRoute: (_role, route) => activeWrite.has(route),
  })
  const blockCount = visibilityDiffs.filter((d) => d.verdict === 'BLOCK').length
  const escalatedCount = visibilityDiffs.filter((d) => d.verdict === 'escalated').length
  const reviewCount = visibilityDiffs.filter((d) => d.verdict === 'review').length

  // 绝对可见性表（用 registry 侧解析·翻转后的样子）
  const visibilityTable: Record<string, Record<string, boolean>> = {}
  for (const role of roles) {
    visibilityTable[role] = {}
    for (const route of vw.routes) {
      visibilityTable[role][route] = visibleUnder(vw.registryModuleOf(route), role, capsByRole[role] ?? {}, adminRoles.has(role))
    }
  }

  return {
    date: dateISO,
    dbPath,
    roles,
    routeSetDiff: vw.routeSetDiff,
    visibilityDiffs,
    blockCount,
    escalatedCount,
    reviewCount,
    flipGateReady: blockCount === 0 && escalatedCount === 0,
    visibilityTable,
  }
}

function renderMarkdown(r: ProductionReport): string {
  const lines: string[] = []
  lines.push(`# 权限影子矩阵 · 生产角色快照报告（Phase-2 翻转门产物）`)
  lines.push('')
  lines.push(`- 生成日期：${r.date}`)
  lines.push(`- 数据库：\`${r.dbPath}\``)
  lines.push(`- 角色（${r.roles.length}）：${r.roles.join(', ')}`)
  lines.push(`- 路由集相等：${r.routeSetDiff.onlyLegacy.length === 0 && r.routeSetDiff.onlyRegistry.length === 0 ? '✅ 是' : '❌ 否'}` +
    (r.routeSetDiff.onlyLegacy.length ? ` · 仅现行:${r.routeSetDiff.onlyLegacy.join(',')}` : '') +
    (r.routeSetDiff.onlyRegistry.length ? ` · 仅注册表:${r.routeSetDiff.onlyRegistry.join(',')}` : ''))
  lines.push('')
  lines.push(`## 门结论（可见性维度）：${r.flipGateReady ? '✅ 就绪（无放宽/提级）' : '🔴 未就绪'}`)
  lines.push('')
  lines.push(`- BLOCK（放宽·提权）：**${r.blockCount}**`)
  lines.push(`- escalated（收窄命中活跃写端点）：**${r.escalatedCount}**`)
  lines.push(`- review（收窄·须人裁）：${r.reviewCount}`)
  lines.push('')
  if (r.visibilityDiffs.length) {
    lines.push(`## 可见性 diff 清单`)
    lines.push('')
    lines.push('| role | route | 现行可见 | 派生可见 | 判定 | 说明 |')
    lines.push('|---|---|---|---|---|---|')
    for (const d of r.visibilityDiffs) {
      lines.push(`| ${d.role} | ${d.route} | ${d.legacyVisible ? '✓' : '✗'} | ${d.registryVisible ? '✓' : '✗'} | ${d.verdict} | ${d.reason} |`)
    }
    lines.push('')
  } else {
    lines.push(`_无可见性 diff：真实库角色下现行(permissions.ts) 与派生(route-registry.ts) 逐格一致。_`)
    lines.push('')
  }
  lines.push(`> 断言 B（守卫·角色无关）不随角色变，由 CI 的 vitest 门覆盖，本报告只出角色相关的可见性维度。`)
  return lines.join('\n') + '\n'
}

// CLI 入口
function isMain(): boolean {
  try { return process.argv[1] != null && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) } catch { return false }
}

if (isMain()) {
  const argv = process.argv.slice(2)
  const getArg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const root = findRepoRoot()
  const dbPath = getArg('--db') || process.env.DATABASE_PATH || path.join(root, '后端代码', 'server', 'data', 'coreone.db')
  const outDir = getArg('--out') || path.join(root, 'docs', 'shadow-matrix-reports')
  const dateISO = new Date().toISOString().slice(0, 10)
  const report = computeProductionReport(dbPath, dateISO, root)
  fs.mkdirSync(outDir, { recursive: true })
  const base = path.join(outDir, `production-visibility-${dateISO}`)
  fs.writeFileSync(`${base}.json`, JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(`${base}.md`, renderMarkdown(report))
  // eslint-disable-next-line no-console
  console.log(`权限影子矩阵·生产报告已生成：\n  ${base}.md\n  ${base}.json\n门结论（可见性）：${report.flipGateReady ? '✅ 就绪' : '🔴 未就绪'}（BLOCK ${report.blockCount} · escalated ${report.escalatedCount} · review ${report.reviewCount}）`)
  if (!report.flipGateReady) process.exit(1)
}
