/**
 * 数据驱动 RBAC —— 纯矩阵逻辑（无 DB / 无 express 依赖，可被 DatabaseManager 与 permissions 共享，避免环）。
 */
export type Level = 'R' | 'W'
export type PermMap = Record<string, Level>

/** 27 个业务模块（权限码） */
export const MODULES = [
  'inventory', 'inbound', 'outbound', 'transfers', 'stocktaking', 'returns', 'scraps',
  'materials', 'categories', 'locations',
  'bom', 'projects',
  'suppliers', 'purchase_orders', 'supplier_returns',
  'reconciliation',
  'cost_analysis', 'abc_dashboard', 'slide_cost', 'profitability', 'abc_config',
  'equipment', 'labor_times',
  'alerts', 'users', 'roles', 'logs',
] as const

/** 成本/利润类模块（成本可见性开关作用域） */
export const COST_MODULES = ['cost_analysis', 'abc_dashboard', 'slide_cost', 'profitability', 'abc_config'] as const

export const NON_ADMIN_ROLES = [
  'lab_director', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance',
] as const

/** 初始种子矩阵（admin 单独处理为全 W；未列模块=无权限）。RBAC 文档 §8.2，用户逐行确认。 */
export const SEED_MATRIX: Record<string, PermMap> = {
  lab_director: {
    inventory: 'R', inbound: 'R', outbound: 'R', transfers: 'W', stocktaking: 'R', returns: 'R', scraps: 'W',
    materials: 'R', categories: 'R', locations: 'R',
    bom: 'W', projects: 'W',
    suppliers: 'R', purchase_orders: 'R', supplier_returns: 'R',
    reconciliation: 'W',
    cost_analysis: 'R', abc_dashboard: 'R', slide_cost: 'R', profitability: 'R', abc_config: 'W',
    equipment: 'W', labor_times: 'R',
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
    equipment: 'W', labor_times: 'W',
    alerts: 'R', logs: 'R',
  },
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
