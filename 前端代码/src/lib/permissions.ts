export function decodeBase64Url(str: string): string {
  const padding = '='.repeat((4 - (str.length % 4)) % 4)
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + padding
  return atob(base64)
}

export function getUserRole(): string | null {
  try {
    // Prefer user object (no JWT decode needed)
    const userStr = localStorage.getItem('user')
    if (userStr) {
      const user = JSON.parse(userStr)
      if (user.role) return user.role
    }
    // Fallback to JWT token payload
    const token = localStorage.getItem('token')
    if (token) {
      const parts = token.split('.')
      if (parts.length >= 2) {
        const payload = JSON.parse(decodeBase64Url(parts[1]))
        if (payload.role) return payload.role
      }
    }
  } catch (e) {
    console.warn('getUserRole error:', e)
  }
  return null
}

// ABC 移植：读取当前用户权限码列表（ABC 页面/hook 按权限显隐操作）
export function getUserPermissions(): string[] {
  try {
    const userStr = localStorage.getItem('user')
    if (!userStr) return []
    const user = JSON.parse(userStr)
    return Array.isArray(user.permissions) ? user.permissions : []
  } catch {
    return []
  }
}

// ============================================================================
// 数据驱动多角色 RBAC（能力并集）—— 登录响应 user.capabilities/roles/canSeeCost
// 为单一来源；nav/守卫/仪表盘统一读它。capabilities 缺失时退回旧 ROLE_MENU_MAP。
// ============================================================================
export type CapLevel = 'R' | 'W'

export function getCapabilities(): Record<string, CapLevel> | null {
  try {
    const userStr = localStorage.getItem('user')
    if (!userStr) return null
    const user = JSON.parse(userStr)
    if (user.capabilities && typeof user.capabilities === 'object') return user.capabilities
    return null
  } catch {
    return null
  }
}

export function getRoles(): string[] {
  try {
    const userStr = localStorage.getItem('user')
    if (!userStr) return []
    const user = JSON.parse(userStr)
    if (Array.isArray(user.roles)) return user.roles
    return user.role ? [user.role] : []
  } catch {
    return []
  }
}

/** 当前用户对 module 是否具备 level 权限（W 蕴含 R）。capabilities 缺失→放行（退回旧逻辑，由 getAccessiblePaths 兜底 nav）。 */
export function canAccess(module: string, level: CapLevel = 'R'): boolean {
  const caps = getCapabilities()
  if (!caps) return true
  const got = caps[module]
  if (!got) return false
  return level === 'R' ? true : got === 'W'
}

/** 成本/利润可见性（后端 app_settings.cost_visibility_roles 计算后随登录下发）。 */
export function canSeeCost(): boolean {
  try {
    const userStr = localStorage.getItem('user')
    if (userStr) {
      const user = JSON.parse(userStr)
      if (typeof user.canSeeCost === 'boolean') return user.canSeeCost
    }
  } catch {
    /* ignore */
  }
  const caps = getCapabilities()
  if (caps) return ['cost_analysis', 'abc_dashboard', 'slide_cost', 'profitability'].some((m) => caps[m])
  return false
}

/** nav 路径 → 模块码（能力驱动菜单/守卫的映射） */
export const NAV_PATH_MODULE: Record<string, string> = {
  '/inventory': 'inventory', '/inbound': 'inbound', '/outbound': 'outbound', '/returns': 'returns',
  '/supplier-returns': 'supplier_returns', '/scraps': 'scraps', '/transfers': 'transfers', '/stocktaking': 'stocktaking',
  '/projects': 'projects', '/bom': 'bom', '/reconciliation': 'reconciliation', '/cost-analysis': 'cost_analysis',
  '/account-reconcile': 'account_reconcile',
  '/categories': 'categories', '/materials': 'materials', '/alerts': 'alerts',
  '/purchase-orders': 'purchase_orders', '/suppliers': 'suppliers', '/locations': 'locations',
  '/users': 'users', '/roles': 'roles', '/logs': 'logs',
  '/hospital-pnl': 'cost_analysis',
  // 注：/partner-config、/import-console、/import-wizard 不走模块能力（财务无 partners 等模块能力），
  //   改为按角色(finance/admin)放行——见 getAccessiblePaths，口径与后端 requireAnyRole('finance') 一致。

  '/abc/dashboard': 'abc_dashboard', '/abc/slide-cost': 'slide_cost', '/abc/profitability': 'profitability',
  '/abc/activity-centers': 'abc_config', '/equipment': 'equipment', '/labor-times': 'labor_times', '/indirect-costs': 'abc_config',
  // ABC 配置类孤儿路由补导航（I-1）：写操作后端均走 requireCostWrite=abc_config:W、读走 abc_dashboard:R，
  //   映射到 abc_config 与 /abc/activity-centers 一致。持 abc_config 的角色(lab_director/finance/admin)必同时持
  //   abc_dashboard:R（见 rbac-matrix SEED_MATRIX），故读端点不会 403。季度调整读 /cost-adjustments 需 cost_analysis:R，
  //   同批角色亦均持 cost_analysis:R，映 abc_config 仍读安全（写需 cost_analysis:W，lab_director 只读降级不报错）。
  '/abc/cost-drivers': 'abc_config', '/abc/cost-pools': 'abc_config', '/abc/fee-mappings': 'abc_config',
  '/abc/budgets': 'abc_config', '/abc/quality-costs': 'abc_config', '/abc/quarterly-adjustment': 'abc_config',
  // 成本异常台账读 /abc/exceptions、成本操作审计读 /abc/audit-logs 均走 abc_dashboard:R，映 abc_dashboard 口径对齐。
  '/abc/alerts': 'abc_dashboard', '/abc/audit': 'abc_dashboard',
}

/** 当前用户可访问的 nav 路径集合（能力驱动；capabilities 缺失→退回旧 ROLE_MENU_MAP）。 */
export function getAccessiblePaths(): string[] {
  const caps = getCapabilities()
  if (caps) {
    const paths = ['/']
    for (const [p, mod] of Object.entries(NAV_PATH_MODULE)) {
      if (canAccess(mod, 'R')) paths.push(p)
    }
    // 配置驱动导入器三页：后端按角色(finance/admin)守卫；财务无对应模块能力，故按角色补（口径一致）。
    const roles = getRoles()
    if (roles.includes('admin') || roles.includes('finance')) {
      paths.push('/partner-config', '/import-console', '/import-wizard')
    }
    // LIS 病例（列表+导入）：口径/工作量数据源，管理员+财务（后端 requireAnyRole('admin','finance') 守卫，见 lis-cases 路由）
    if (roles.includes('admin') || roles.includes('finance')) paths.push('/lis-cases')
    return paths
  }
  const role = getUserRole()
  if (role && ROLE_MENU_MAP[role]) return ROLE_MENU_MAP[role]
  return ROLE_MENU_MAP.technician
}

// 角色-菜单权限映射（legacy 兜底；capabilities 缺失时回退使用）
export const ROLE_MENU_MAP: Record<string, string[]> = {
  admin: [
    '/', '/inventory', '/inbound', '/outbound', '/returns', '/supplier-returns', '/scraps', '/transfers', '/stocktaking',
    '/projects', '/bom', '/reconciliation', '/account-reconcile', '/cost-analysis',
    '/categories', '/materials', '/alerts',
    '/purchase-orders', '/suppliers', '/locations', '/users', '/roles', '/logs', '/partner-config', '/lis-cases', '/import-console', '/import-wizard',
    // ABC 成本核算（移植）
    '/abc/dashboard', '/abc/slide-cost', '/abc/profitability', '/abc/activity-centers', '/equipment', '/labor-times', '/indirect-costs',
    // ABC 配置类孤儿路由补导航（I-1）
    '/abc/alerts', '/abc/audit', '/abc/cost-drivers', '/abc/cost-pools', '/abc/fee-mappings', '/abc/budgets', '/abc/quality-costs', '/abc/quarterly-adjustment',
  ],
  warehouse_manager: [
    '/', '/inventory', '/inbound', '/outbound', '/returns', '/supplier-returns', '/scraps', '/transfers', '/stocktaking',
    '/suppliers', '/locations', '/materials', '/categories', '/alerts',
  ],
  technician: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation',
    '/cost-analysis', '/materials', '/categories', '/alerts',
    // ABC 成本核算（移植，只读看板）
    '/abc/dashboard', '/abc/slide-cost', '/equipment', '/labor-times',
  ],
  procurement: [
    '/', '/inventory', '/inbound', '/materials', '/suppliers', '/purchase-orders', '/supplier-returns', '/categories', '/alerts',
  ],
  finance: [
    '/', '/inventory', '/supplier-returns', '/reconciliation', '/account-reconcile', '/cost-analysis', '/categories', '/alerts', '/partner-config', '/lis-cases', '/import-console', '/import-wizard',
    // ABC 成本核算（移植）
    '/abc/dashboard', '/abc/slide-cost', '/abc/profitability', '/abc/activity-centers', '/equipment', '/labor-times', '/indirect-costs',
    // ABC 配置类孤儿路由补导航（I-1）
    '/abc/alerts', '/abc/audit', '/abc/cost-drivers', '/abc/cost-pools', '/abc/fee-mappings', '/abc/budgets', '/abc/quality-costs', '/abc/quarterly-adjustment',
  ],
  pathologist: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation', '/cost-analysis',
    // ABC 成本核算（移植，只读看板）
    '/abc/dashboard', '/abc/slide-cost', '/abc/profitability',
  ],
}
