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

// 角色-菜单权限映射（与 PRD-v1.0-FINAL 权限矩阵保持一致）
export const ROLE_MENU_MAP: Record<string, string[]> = {
  admin: [
    '/', '/inventory', '/inbound', '/outbound', '/returns', '/supplier-returns', '/scraps', '/transfers', '/stocktaking',
    '/projects', '/bom', '/reconciliation', '/cost-analysis',
    '/categories', '/materials', '/alerts',
    '/purchase-orders', '/suppliers', '/locations', '/users', '/roles', '/logs',
    // ABC 成本核算（移植）
    '/abc/dashboard', '/abc/slide-cost', '/abc/profitability', '/abc/activity-centers', '/equipment', '/labor-times', '/indirect-costs',
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
    '/', '/inventory', '/reconciliation', '/cost-analysis', '/categories', '/alerts',
    // ABC 成本核算（移植）
    '/abc/dashboard', '/abc/slide-cost', '/abc/profitability', '/abc/activity-centers', '/equipment', '/labor-times', '/indirect-costs',
  ],
  pathologist: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation', '/cost-analysis',
    // ABC 成本核算（移植，只读看板）
    '/abc/dashboard', '/abc/slide-cost', '/abc/profitability',
  ],
}
