import { describe, it, expect, beforeEach } from 'vitest'
import {
  ROUTE_REGISTRY,
  deriveSidebarMenu,
  allActivePaths,
  NAV_GROUPS,
  NAV_GROUP_AREA,
} from './route-registry'
import { NAV_PATH_MODULE, ROLE_MENU_MAP, getAccessiblePaths } from './permissions'

// ============================================================================
// 零行为变更快照锁（Phase 1 迁移 = AppSidebar 渲染 + 权限矩阵逐字节相等）
// ----------------------------------------------------------------------------
// GOLDEN_* = 迁移前 AppSidebar 的 ALL_MAIN_MENU / ALL_SYSTEM_MENU（label, path·按序）。
// deriveSidebarMenu 必须对任意 allowedPaths 复现「GOLDEN 按 allowedPaths 过滤、保序」的结果——
// 迁移前正是 ALL_MAIN_MENU.filter(p∈allowed) / ALL_SYSTEM_MENU.filter(...)，故此等价 = 逐字节相等证明。
// ============================================================================

const GOLDEN_MAIN: Array<[string, string]> = [
  ['仪表盘', '/'],
  ['库存列表', '/inventory'],
  ['入库记录', '/inbound'],
  ['出库记录', '/outbound'],
  ['退库管理', '/returns'],
  ['退货给供应商', '/supplier-returns'],
  ['报废管理', '/scraps'],
  ['调拨管理', '/transfers'],
  ['库存盘点', '/stocktaking'],
  ['检测项目', '/projects'],
  ['BOM清单', '/bom'],
  ['消耗对账', '/reconciliation'],
  ['物料成本分析', '/cost-analysis'],
  ['物料分类', '/categories'],
  ['耗材管理', '/materials'],
  ['预警中心', '/alerts'],
  ['医院盈利看板', '/hospital-pnl'],
  ['账实核对', '/account-reconcile'],
  ['合作医院配置', '/partner-config'],
  ['LIS 病例', '/lis-cases'],
  ['导入测试台', '/import-console'],
  ['财务月度导入', '/import-wizard'],
  ['ABC成本看板', '/abc/dashboard'],
  ['单片成本分析', '/abc/slide-cost'],
  ['盈利分析', '/abc/profitability'],
  ['成本异常台账', '/abc/alerts'],
  ['成本审计追溯', '/abc/audit'],
  ['ABC配置', '/abc/activity-centers'],
  ['成本动因', '/abc/cost-drivers'],
  ['成本池', '/abc/cost-pools'],
  ['收费映射配置', '/abc/fee-mappings'],
  ['成本预算', '/abc/budgets'],
  ['质量成本', '/abc/quality-costs'],
  ['季度成本调整', '/abc/quarterly-adjustment'],
  ['设备管理', '/equipment'],
  ['标准工时库', '/labor-times'],
  ['间接成本中心', '/indirect-costs'],
]

const GOLDEN_SYSTEM: Array<[string, string]> = [
  ['采购订单', '/purchase-orders'],
  ['供应商管理', '/suppliers'],
  ['库位管理', '/locations'],
  ['用户管理', '/users'],
  ['角色权限', '/roles'],
  ['操作日志', '/logs'],
]

const pairs = (items: Array<{ label: string; path: string }>): Array<[string, string]> =>
  items.map((m) => [m.label, m.path])

const filterGolden = (golden: Array<[string, string]>, allowed: string[]): Array<[string, string]> =>
  golden.filter(([, p]) => allowed.includes(p))

describe('route-registry · 零行为变更快照锁', () => {
  describe('deriveSidebarMenu = 迁移前 ALL_MAIN_MENU/ALL_SYSTEM_MENU 逐字节', () => {
    it('全 active（未登录态）→ main/system 与 GOLDEN 完全一致（含顺序）', () => {
      const { main, system } = deriveSidebarMenu(allActivePaths())
      expect(pairs(main)).toEqual(GOLDEN_MAIN)
      expect(pairs(system)).toEqual(GOLDEN_SYSTEM)
    })

    it('每个 active 菜单项都带 icon（迁移未丢图标）', () => {
      const { main, system } = deriveSidebarMenu(allActivePaths())
      for (const item of [...main, ...system]) expect(item.icon).toBeTruthy()
    })

    // 属性证明：对任意 allowedPaths，派生结果 = GOLDEN 按 allowedPaths 过滤保序（= 迁移前 filter 语义）。
    it.each([
      ['全集', allActivePaths()],
      ['空集', [] as string[]],
      ['单项 /inventory', ['/inventory']],
      ['含孤儿路径也不误显（headless 不进菜单）', ['/', '/abc/variance', '/abc/trend', '/inventory']],
    ])('过滤等价 · %s', (_label, allowed) => {
      const { main, system } = deriveSidebarMenu(allowed as string[])
      expect(pairs(main)).toEqual(filterGolden(GOLDEN_MAIN, allowed as string[]))
      expect(pairs(system)).toEqual(filterGolden(GOLDEN_SYSTEM, allowed as string[]))
    })
  })

  describe('每个角色（legacy 兜底态）菜单 = GOLDEN 按该角色可见路径过滤', () => {
    beforeEach(() => localStorage.clear())

    it.each(Object.keys(ROLE_MENU_MAP))('角色 %s 的派生菜单逐字节复现迁移前', (role) => {
      // 无 capabilities → getAccessiblePaths 走 ROLE_MENU_MAP[role]（与迁移前一致）
      localStorage.setItem('user', JSON.stringify({ role }))
      const allowed = getAccessiblePaths()
      const { main, system } = deriveSidebarMenu(allowed)
      expect(pairs(main)).toEqual(filterGolden(GOLDEN_MAIN, allowed))
      expect(pairs(system)).toEqual(filterGolden(GOLDEN_SYSTEM, allowed))
    })
  })

  describe('权限矩阵未被扰动（本 PR 不改 permissions.ts 判定）', () => {
    beforeEach(() => localStorage.clear())

    it.each(Object.keys(ROLE_MENU_MAP))('getAccessiblePaths(%s·legacy) = ROLE_MENU_MAP[role]', (role) => {
      localStorage.setItem('user', JSON.stringify({ role }))
      expect(getAccessiblePaths()).toEqual(ROLE_MENU_MAP[role])
    })
  })

  describe('注册表声明忠实性', () => {
    it('permModule 与 permissions.NAV_PATH_MODULE 逐路径一致（声明不撒谎）', () => {
      const byPath = new Map(ROUTE_REGISTRY.map((e) => [e.path, e]))
      for (const [p, mod] of Object.entries(NAV_PATH_MODULE)) {
        const entry = byPath.get(p)
        expect(entry, `NAV_PATH_MODULE 路径 ${p} 应在注册表`).toBeDefined()
        expect(entry!.permModule, `路径 ${p} 的 permModule 应与 NAV_PATH_MODULE 一致`).toBe(mod)
      }
    })

    it('active 项均有 label/icon/navGroup 且 navGroup ∈ 封闭枚举', () => {
      for (const e of ROUTE_REGISTRY) {
        if (e.status !== 'active') continue
        expect(e.label, `${e.path} 缺 label`).toBeTruthy()
        expect(e.icon, `${e.path} 缺 icon`).toBeTruthy()
        expect(e.navGroup, `${e.path} 缺 navGroup`).toBeTruthy()
        expect(NAV_GROUPS).toContain(e.navGroup)
      }
    })

    it('headless 项均带 owner + due + reason（fail-closed 声明完整）', () => {
      for (const e of ROUTE_REGISTRY) {
        if (e.status !== 'headless') continue
        expect(e.owner, `${e.path} 缺 owner`).toBeTruthy()
        expect(e.due, `${e.path} 缺 due`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        expect(e.reason, `${e.path} 缺 reason`).toBeTruthy()
      }
    })

    it('NAV_GROUP_AREA 覆盖全部 navGroup（无遗漏映射）', () => {
      for (const g of NAV_GROUPS) expect(NAV_GROUP_AREA[g]).toMatch(/^(main|system)$/)
    })

    it('路由 path 无重复声明', () => {
      const paths = ROUTE_REGISTRY.map((e) => e.path)
      expect(new Set(paths).size).toBe(paths.length)
    })
  })
})
