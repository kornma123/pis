/**
 * 数据驱动 RBAC —— 纯矩阵逻辑（无 DB / 无 express 依赖，可被 DatabaseManager 与 permissions 共享，避免环）。
 */
export type Level = 'R' | 'W'
export type PermMap = Record<string, Level>

/** 31 个业务模块（权限码）。partners/partner_pricing = 按医院成本盈利特性新增；antibody_cost = 逐抗体成本地基；account_reconcile = 账实核对（财务域·区别于 BOM 消耗对账 reconciliation）。 */
export const MODULES = [
  'inventory', 'inbound', 'outbound', 'transfers', 'stocktaking', 'returns', 'scraps',
  'materials', 'categories', 'locations',
  'bom', 'projects',
  'suppliers', 'purchase_orders', 'supplier_returns',
  'reconciliation',
  'cost_analysis', 'abc_dashboard', 'slide_cost', 'profitability', 'abc_config',
  'antibody_cost', 'account_reconcile',
  'equipment', 'labor_times',
  'partners', 'partner_pricing',
  'alerts', 'users', 'roles', 'logs',
] as const

/** 成本/利润类模块（成本可见性开关作用域） */
export const COST_MODULES = ['cost_analysis', 'abc_dashboard', 'slide_cost', 'profitability', 'abc_config'] as const

export const NON_ADMIN_ROLES = [
  'lab_director', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance',
] as const

/** 初始化时由系统维护的角色码；数据驱动权限不等于可由非 admin 改写这些身份定义。 */
export const SYSTEM_ROLE_CODES = ['admin', ...NON_ADMIN_ROLES] as const

/** 初始种子矩阵（admin 单独处理为全 W；未列模块=无权限）。RBAC 文档 §8.2，用户逐行确认。 */
export const SEED_MATRIX: Record<string, PermMap> = {
  // lab_director（实验室主任）= 高权限管理角色（已持 users/roles/reconciliation 审批 + transfers/scraps 写）。
  // 2026-07-06 PM 拍板：退库/盘点由 R→W，与已有的调拨/报废/管理用户/审批对账写权限一致——
  //   消除「能报废/调拨却不能退库/盘点」的不对称。源：非-P0 审计项 E 的 W 守卫（#76）暴露此口径缺口。
  //   ⚠️ 既有库的 lab_director 行(roles.permissions)会 shadow 本矩阵（getEffectivePermissionsForRoles 先读 roles 行）
  //   → 单改此处对既有库静默无效；配套迁移 reconcileLabDirectorInventoryPerms（DatabaseManager）把既有行两键对齐 'W'、保证全库生效。
  lab_director: {
    inventory: 'R', inbound: 'R', outbound: 'R', transfers: 'W', stocktaking: 'W', returns: 'W', scraps: 'W',
    materials: 'R', categories: 'R', locations: 'R',
    bom: 'W', projects: 'W',
    suppliers: 'R', purchase_orders: 'R', supplier_returns: 'R',
    reconciliation: 'W',
    cost_analysis: 'R', abc_dashboard: 'R', slide_cost: 'R', profitability: 'R', abc_config: 'W',
    antibody_cost: 'R', account_reconcile: 'R',
    equipment: 'W', labor_times: 'R',
    partners: 'W', partner_pricing: 'W',
    alerts: 'R', users: 'W', roles: 'W', logs: 'R',
  },
  warehouse_manager: {
    inventory: 'W', inbound: 'W', outbound: 'W', transfers: 'W', stocktaking: 'W', returns: 'W', scraps: 'W',
    materials: 'W', categories: 'W', locations: 'W',
    bom: 'R',
    suppliers: 'R', purchase_orders: 'R', supplier_returns: 'W',
    reconciliation: 'R',
    equipment: 'R',
    alerts: 'R',
  },
  technician: {
    inventory: 'R', outbound: 'W', stocktaking: 'W', returns: 'W', scraps: 'W',
    materials: 'R', categories: 'R',
    bom: 'W', projects: 'W',
    reconciliation: 'W',
    equipment: 'W', labor_times: 'R',
    alerts: 'R',
  },
  pathologist: {
    inventory: 'R',
    bom: 'R', projects: 'W',
    alerts: 'R',
  },
  procurement: {
    inventory: 'R', inbound: 'W',
    materials: 'R', categories: 'R',
    suppliers: 'W', purchase_orders: 'W', supplier_returns: 'W',
    cost_analysis: 'R',
    alerts: 'R',
  },
  finance: {
    inventory: 'R',
    materials: 'R', categories: 'R',
    bom: 'R', projects: 'W',
    suppliers: 'R', purchase_orders: 'R', supplier_returns: 'R',
    reconciliation: 'W',
    cost_analysis: 'W', abc_dashboard: 'W', slide_cost: 'W', profitability: 'W', abc_config: 'W',
    antibody_cost: 'W', account_reconcile: 'W',
    equipment: 'W', labor_times: 'W',
    partners: 'R', partner_pricing: 'W',
    alerts: 'R', logs: 'R',
  },
}

/**
 * 职责分离(SoD)不相容角色组合（同一人同时持有时告警，非硬阻断——小实验室可豁免确认）。
 * 依据：采购需求 vs 选择定价分离、保管 vs 对账核准分离、技术员 vs 医师不兼职(CNAS 信号)。
 */
export const SOD_INCOMPATIBLE: Array<[string, string]> = [
  ['procurement', 'finance'],
  ['warehouse_manager', 'finance'],
  ['pathologist', 'technician'],
]

/** 检测角色集合中的 SoD 冲突，返回冲突描述（如 'procurement+finance'）；admin 不参与 */
export function detectSoDConflicts(roles: string[]): string[] {
  const set = new Set(roles)
  const out: string[] = []
  for (const [a, b] of SOD_INCOMPATIBLE) if (set.has(a) && set.has(b)) out.push(`${a}+${b}`)
  return out
}

/** admin 全模块 W */
export function adminAllPermissions(): PermMap {
  return Object.fromEntries(MODULES.map((m) => [m, 'W'])) as PermMap
}

/**
 * 解析 roles.permissions 原始值为 PermMap。双形态兼容：
 *  - 对象 {module:'R'|'W'} → 直接用（过滤非法）
 *  - 旧扁平数组 ['inventory',...] → 列出的码视为 'W'
 *  - 含 '*'（admin 旧值）→ 全 W
 */
export function parsePermissions(raw: any): PermMap {
  let val = raw
  if (val == null || val === '') return {}
  if (typeof val === 'string') {
    try {
      val = JSON.parse(val)
    } catch {
      return {}
    }
  }
  const out: PermMap = {}
  if (Array.isArray(val)) {
    if (val.includes('*')) return adminAllPermissions()
    for (const code of val) {
      if (typeof code === 'string' && (MODULES as readonly string[]).includes(code)) out[code] = 'W'
    }
    return out
  }
  if (typeof val === 'object') {
    for (const [mod, lvl] of Object.entries(val)) {
      if ((MODULES as readonly string[]).includes(mod) && (lvl === 'R' || lvl === 'W')) out[mod] = lvl
    }
  }
  return out
}

/** 角色码是否属于系统初始化角色（精确匹配，保持既有 code 大小写语义）。 */
export function isSystemRoleCode(code: unknown): boolean {
  return typeof code === 'string' && (SYSTEM_ROLE_CODES as readonly string[]).includes(code)
}

/**
 * 候选权限是否与 admin 的“全部模块 W”能力等价。
 * 统一经 parsePermissions 识别对象矩阵、旧数组与 ['*']，避免只堵一种序列化形态。
 */
export function isAdminEquivalentPermissions(raw: unknown): boolean {
  const parsed = parsePermissions(raw)
  return MODULES.every((module) => parsed[module] === 'W')
}

/** 并集合并（W 优先） */
export function mergePermissions(into: PermMap, add: PermMap): PermMap {
  for (const [mod, lvl] of Object.entries(add)) {
    if (into[mod] !== 'W') into[mod] = lvl === 'W' ? 'W' : into[mod] || 'R'
  }
  return into
}

/** effective 是否满足 module 所需 level（W 蕴含 R） */
export function hasLevel(effective: PermMap, module: string, needed: Level): boolean {
  const got = effective[module]
  if (!got) return false
  return needed === 'R' ? true : got === 'W'
}
