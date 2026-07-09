import type { ElementType } from 'react'
import {
  LayoutDashboard,
  Package,
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCheck,
  FlaskConical,
  ClipboardList,
  BarChart3,
  FolderTree,
  Boxes,
  Bell,
  Activity,
  Truck,
  MapPin,
  Users,
  Shield,
  FileText,
  ShoppingCart,
  Undo2,
  Trash2,
  ArrowRightLeft,
  CornerUpLeft,
  Wrench,
  Clock,
  TrendingUp,
  Layers,
  Settings,
  Scale,
  Database,
  AlertTriangle,
  History,
  GitBranch,
  Container,
  Receipt,
  Wallet,
  ShieldCheck,
  CalendarClock,
} from 'lucide-react'

// ============================================================================
// 路由注册表（单一来源）—— CON-4 + CON-5 + CON-7 · Phase 1
// ----------------------------------------------------------------------------
// 目的：让「新页默认有归宿」。每条 App.tsx 应用路由都必须在这里声明一次，
//   携带 navGroup（出现在哪个菜单区）+ permModule（谁能访问·声明用）+ status。
//   侧栏菜单从本表**派生**（不再各处手写 MenuItem）；构建纪律闸第 4 检查
//   （scripts/build-discipline/check-route-nav.cjs）强制「每条路由必须声明且分组，
//   否则须 headless 带死线，否则红」——孤儿化在构造上不可能。
//
// ⚠️ Phase 1 边界（零行为变更）：
//   - 本表**只登记状态 + 派生菜单**。permModule 是**声明**（供闸/后续影子断言），
//     Phase 1 **不接管**访问判定——侧栏可见性仍由 permissions.ts 的
//     getAccessiblePaths() 决定（与迁移前逐字节一致，快照测试锁死）。
//   - 权限派生翻转（permissions.ts 改读本表）是 Phase 2、本次不做。
//   - 孤儿的真正删页/退役/补入口是后续独立小 PR；本次只登记 headless/deprecated。
//
// 声明承重（防橡皮图章）：navGroup 决定页面出现在哪个菜单区、填错开发者自己第一个
//   看见（页面进错区）→ 声明自纠。headless 逃生门比老实声明更贵（owner+死线+理由+
//   条数上限，缺死线=红）。
// ============================================================================

/**
 * 导航功能域（**封闭枚举**）。加新分组 = 走评审的显式变更，不能现场编——
 * check-route-nav.cjs 校验每个 active 路由的 navGroup ∈ NAV_GROUPS，越界即红。
 */
export type NavGroup =
  | 'overview'      // 概览（仪表盘）
  | 'inventory'     // 库存与出入库流转
  | 'catalog'       // 主数据（检测项目/BOM/物料分类/耗材）
  | 'consumption'   // 消耗与物料成本（消耗对账/物料成本分析/预警）
  | 'hospital-pnl'  // 按医院成本/盈利（盈利看板/账实核对/合作配置/LIS/导入）
  | 'abc-cost'      // ABC 成本核算看板（看板/单片/盈利/异常/审计）
  | 'abc-config'    // ABC 配置类参数录入（活动中心/动因/池/映射/预算/质量/季度/设备/工时/间接）
  | 'system'        // 系统管理（采购/供应商/库位/用户/角色/日志）

/** navGroup 的封闭集合（check-route-nav.cjs 也解析本数组作单一事实源）。 */
export const NAV_GROUPS: readonly NavGroup[] = [
  'overview',
  'inventory',
  'catalog',
  'consumption',
  'hospital-pnl',
  'abc-cost',
  'abc-config',
  'system',
] as const

/** 菜单区。Phase 1 保持迁移前两段式布局（主菜单 + 分隔线 + 系统菜单）。 */
export type MenuArea = 'main' | 'system'

/**
 * 每个 navGroup 渲染到哪个菜单区。
 * Phase 1：仅 system 组进「系统菜单」区，其余进「主菜单」区——与迁移前
 * ALL_MAIN_MENU / ALL_SYSTEM_MENU 的两段式布局一致（不引入功能域小节，零行为变更）。
 */
export const NAV_GROUP_AREA: Record<NavGroup, MenuArea> = {
  overview: 'main',
  inventory: 'main',
  catalog: 'main',
  consumption: 'main',
  'hospital-pnl': 'main',
  'abc-cost': 'main',
  'abc-config': 'main',
  system: 'system',
}

export type RouteStatus =
  | 'active'      // 有顶层导航入口（navGroup 必填）
  | 'headless'    // 可 URL 直达 / 父页下钻，无顶层导航（owner+due+reason 必填·fail-closed）
  | 'deprecated'  // 计划退役（reason 必填；真正删页是后续独立 PR）

export interface RouteEntry {
  /** 路由路径（须与 App.tsx 的 <Route path> 一一对应）。 */
  path: string
  /** 侧栏文案（active 必填；headless/deprecated 无导航、可省）。 */
  label?: string
  /** 侧栏图标（active 必填）。 */
  icon?: ElementType
  /** 功能域（active 必填，∈ NAV_GROUPS）。决定页面出现在哪个菜单区。 */
  navGroup?: NavGroup
  /**
   * 访问权限模块码（**声明用**）。与 permissions.ts 的 NAV_PATH_MODULE 同口径；
   * 按角色放行（无单一模块能力）的页为 null。Phase 1 不用它做判定。
   */
  permModule: string | null
  /** headless/deprecated 的负责人（fail-closed·缺则闸红）。 */
  owner?: string
  /** headless 的死线（YYYY-MM-DD·缺/坏/过期/超上限=红·忘填≠永久绿）。 */
  due?: string
  /** headless/deprecated 的分诊结论（去向/依据）。 */
  reason?: string
}

/**
 * 路由注册表。**声明顺序 = 迁移前 ALL_MAIN_MENU 顺序 + ALL_SYSTEM_MENU 顺序**——
 * deriveSidebarMenu 按声明顺序渲染，故与迁移前侧栏逐字节一致（快照测试锁死）。
 */
export const ROUTE_REGISTRY: RouteEntry[] = [
  // ===== 主菜单区（menuArea=main）— 概览 =====
  { path: '/', label: '仪表盘', icon: LayoutDashboard, navGroup: 'overview', permModule: null, status: 'active' },

  // ----- 库存与出入库流转 -----
  { path: '/inventory', label: '库存列表', icon: Package, navGroup: 'inventory', permModule: 'inventory', status: 'active' },
  { path: '/inbound', label: '入库记录', icon: ArrowDownToLine, navGroup: 'inventory', permModule: 'inbound', status: 'active' },
  { path: '/outbound', label: '出库记录', icon: ArrowUpFromLine, navGroup: 'inventory', permModule: 'outbound', status: 'active' },
  { path: '/returns', label: '退库管理', icon: Undo2, navGroup: 'inventory', permModule: 'returns', status: 'active' },
  { path: '/supplier-returns', label: '退货给供应商', icon: CornerUpLeft, navGroup: 'inventory', permModule: 'supplier_returns', status: 'active' },
  { path: '/scraps', label: '报废管理', icon: Trash2, navGroup: 'inventory', permModule: 'scraps', status: 'active' },
  { path: '/transfers', label: '调拨管理', icon: ArrowRightLeft, navGroup: 'inventory', permModule: 'transfers', status: 'active' },
  { path: '/stocktaking', label: '库存盘点', icon: ClipboardCheck, navGroup: 'inventory', permModule: 'stocktaking', status: 'active' },

  // ----- 主数据 / 消耗与物料成本（保持迁移前交错顺序，零行为变更）-----
  { path: '/projects', label: '检测项目', icon: FlaskConical, navGroup: 'catalog', permModule: 'projects', status: 'active' },
  { path: '/bom', label: 'BOM清单', icon: ClipboardList, navGroup: 'catalog', permModule: 'bom', status: 'active' },
  { path: '/reconciliation', label: '消耗对账', icon: Activity, navGroup: 'consumption', permModule: 'reconciliation', status: 'active' },
  { path: '/cost-analysis', label: '物料成本分析', icon: BarChart3, navGroup: 'consumption', permModule: 'cost_analysis', status: 'active' },
  { path: '/categories', label: '物料分类', icon: FolderTree, navGroup: 'catalog', permModule: 'categories', status: 'active' },
  { path: '/materials', label: '耗材管理', icon: Boxes, navGroup: 'catalog', permModule: 'materials', status: 'active' },
  { path: '/alerts', label: '预警中心', icon: Bell, navGroup: 'consumption', permModule: 'alerts', status: 'active' },

  // ----- 按医院成本/盈利 -----
  { path: '/hospital-pnl', label: '医院盈利看板', icon: TrendingUp, navGroup: 'hospital-pnl', permModule: 'cost_analysis', status: 'active' },
  { path: '/account-reconcile', label: '账实核对', icon: Scale, navGroup: 'hospital-pnl', permModule: 'account_reconcile', status: 'active' },
  // 以下四页按角色(finance/admin)放行（无单一模块能力），permModule=null·见 permissions.getAccessiblePaths。
  { path: '/partner-config', label: '合作医院配置', icon: Settings, navGroup: 'hospital-pnl', permModule: null, status: 'active' },
  { path: '/lis-cases', label: 'LIS 病例', icon: Database, navGroup: 'hospital-pnl', permModule: null, status: 'active' },
  { path: '/import-console', label: '导入测试台', icon: FlaskConical, navGroup: 'hospital-pnl', permModule: null, status: 'active' },
  { path: '/import-wizard', label: '财务月度导入', icon: FileText, navGroup: 'hospital-pnl', permModule: null, status: 'active' },

  // ----- ABC 成本核算看板 -----
  { path: '/abc/dashboard', label: 'ABC成本看板', icon: BarChart3, navGroup: 'abc-cost', permModule: 'abc_dashboard', status: 'active' },
  { path: '/abc/slide-cost', label: '单片成本分析', icon: Layers, navGroup: 'abc-cost', permModule: 'slide_cost', status: 'active' },
  { path: '/abc/profitability', label: '盈利分析', icon: TrendingUp, navGroup: 'abc-cost', permModule: 'profitability', status: 'active' },
  { path: '/abc/alerts', label: '成本异常台账', icon: AlertTriangle, navGroup: 'abc-cost', permModule: 'abc_dashboard', status: 'active' },
  { path: '/abc/audit', label: '成本审计追溯', icon: History, navGroup: 'abc-cost', permModule: 'abc_dashboard', status: 'active' },

  // ----- ABC 配置类（参数唯一录入入口，I-1 补导航）-----
  { path: '/abc/activity-centers', label: 'ABC配置', icon: Settings, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },
  { path: '/abc/cost-drivers', label: '成本动因', icon: GitBranch, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },
  { path: '/abc/cost-pools', label: '成本池', icon: Container, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },
  { path: '/abc/fee-mappings', label: '收费映射配置', icon: Receipt, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },
  { path: '/abc/budgets', label: '成本预算', icon: Wallet, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },
  { path: '/abc/quality-costs', label: '质量成本', icon: ShieldCheck, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },
  { path: '/abc/quarterly-adjustment', label: '季度成本调整', icon: CalendarClock, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },
  { path: '/equipment', label: '设备管理', icon: Wrench, navGroup: 'abc-config', permModule: 'equipment', status: 'active' },
  { path: '/labor-times', label: '标准工时库', icon: Clock, navGroup: 'abc-config', permModule: 'labor_times', status: 'active' },
  { path: '/indirect-costs', label: '间接成本中心', icon: Settings, navGroup: 'abc-config', permModule: 'abc_config', status: 'active' },

  // ===== 系统菜单区（menuArea=system）=====
  { path: '/purchase-orders', label: '采购订单', icon: ShoppingCart, navGroup: 'system', permModule: 'purchase_orders', status: 'active' },
  { path: '/suppliers', label: '供应商管理', icon: Truck, navGroup: 'system', permModule: 'suppliers', status: 'active' },
  { path: '/locations', label: '库位管理', icon: MapPin, navGroup: 'system', permModule: 'locations', status: 'active' },
  { path: '/users', label: '用户管理', icon: Users, navGroup: 'system', permModule: 'users', status: 'active' },
  { path: '/roles', label: '角色权限', icon: Shield, navGroup: 'system', permModule: 'roles', status: 'active' },
  { path: '/logs', label: '操作日志', icon: FileText, navGroup: 'system', permModule: 'logs', status: 'active' },

  // ===== headless（可 URL 直达 / 父页下钻·无顶层导航）=====
  // 孤儿分诊（迁移时逐条·证据=PM 已拍板 ABC 处置清单 #61 + 唯一资产读码 + 口径诚实核实；
  //   operation_logs 无 path 列·dev 库无直 URL 证据故不作依据）。7 条均有唯一资产且诚实/已诚实降级，
  //   分诊结论=保留待接入（补导航/合并/口径修正），故 headless（非 deprecated）+ owner+due+reason·
  //   死线到期须重新分诊（fail-closed·忘填≠永久绿）。真正的补入口/合并/退役是后续独立小 PR。
  { path: '/equipment/types', permModule: 'equipment', status: 'headless', owner: 'PM待拍（设备主数据）', due: '2026-10-07', reason: '设备类型主数据子页·经父页「设备管理」navigate 进入（有意子路由）·待定是否给面包屑/子导航或维持父页下钻' },
  { path: '/equipment/depreciation', permModule: 'equipment', status: 'headless', owner: 'PM待拍（设备主数据）', due: '2026-10-07', reason: '设备折旧统计子页（读 /equipment/depreciation-stats）·当前无任何页面链入·待接父页下钻入口或并入报表平台' },
  { path: '/abc/fee-comparison', permModule: 'abc_dashboard', status: 'headless', owner: 'PM待拍（报表平台 I-2）', due: '2026-10-07', reason: '逐笔出库 cost-vs-fee + 未配收费告警唯一视图（#61 §3B 待定·落点=统一报表平台 I-2）' },
  { path: '/abc/supplier-costs', permModule: 'cost_analysis', status: 'headless', owner: 'PM待拍（合并 I-5）', due: '2026-10-07', reason: '供应商成本（同端点 cost-analysis 已消费·#61 §3A 合并候选 I-5→cost-analysis 供应商 Tab）·退款三列半成品恒 0·合并前不外显' },
  { path: '/abc/trend', permModule: 'slide_cost', status: 'headless', owner: 'PM待拍（报表平台 I-2）', due: '2026-10-07', reason: '切片成本/利润率趋势（读 /abc/slide-cost-trend·#61 §3A 合并候选 I-2）·合并须并入逐 BOM 切片折线+季度维度角度' },
  { path: '/abc/variance', permModule: 'abc_dashboard', status: 'headless', owner: 'PM待拍（口径 I-4）', due: '2026-10-07', reason: '成本差异·标准成本已诚实降级（#99/P-7 后端恒返回 null + 前端仅展示实际成本）·口径修正 I-4 后再定收编/下线（#61 §3B 待定）' },
  { path: '/abc/model-validation', permModule: 'slide_cost', status: 'headless', owner: 'PM待拍（报表平台 I-2）', due: '2026-10-07', reason: 'BOM what-if 成本试算器（纯只读·无写操作·#61 §3A 合并候选 I-2→并入 /abc/slide-cost）' },
]

// ============================================================================
// 派生：侧栏菜单
// ============================================================================

export interface MenuItem {
  label: string
  path: string
  icon: ElementType
}

/**
 * 从注册表派生侧栏菜单：active 项按**声明顺序**、按 menuArea 分组、按 allowedPaths 过滤。
 * headless / deprecated 不进菜单。渲染顺序 = 声明顺序（= 迁移前 ALL_MAIN_MENU + ALL_SYSTEM_MENU）
 * → 与迁移前逐字节一致（route-registry.test.ts 快照锁死）。
 */
export function deriveSidebarMenu(allowedPaths: string[]): { main: MenuItem[]; system: MenuItem[] } {
  const allowed = new Set(allowedPaths)
  const main: MenuItem[] = []
  const system: MenuItem[] = []
  for (const entry of ROUTE_REGISTRY) {
    if (entry.status !== 'active') continue
    if (!allowed.has(entry.path)) continue
    // active 项 label/icon/navGroup 恒存在（check-route-nav.cjs 强制），此处非空断言安全。
    const item: MenuItem = { label: entry.label!, path: entry.path, icon: entry.icon! }
    const area = entry.navGroup ? NAV_GROUP_AREA[entry.navGroup] : 'main'
    if (area === 'system') system.push(item)
    else main.push(item)
  }
  return { main, system }
}

/** 所有 active 路由的路径（未登录时侧栏显示全部 active 项，与迁移前一致）。 */
export function allActivePaths(): string[] {
  return ROUTE_REGISTRY.filter((e) => e.status === 'active').map((e) => e.path)
}
