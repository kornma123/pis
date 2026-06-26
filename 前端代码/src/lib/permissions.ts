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

// 角色-菜单权限映射（与 PRD-v1.0-FINAL 权限矩阵保持一致）
export const ROLE_MENU_MAP: Record<string, string[]> = {
  admin: [
    '/', '/inventory', '/inbound', '/outbound', '/returns', '/supplier-returns', '/scraps', '/transfers', '/stocktaking',
    '/projects', '/bom', '/reconciliation', '/cost-analysis',
    '/categories', '/materials', '/alerts',
    '/purchase-orders', '/suppliers', '/locations', '/users', '/roles', '/logs',
  ],
  warehouse_manager: [
    '/', '/inventory', '/inbound', '/outbound', '/returns', '/supplier-returns', '/scraps', '/transfers', '/stocktaking',
    '/suppliers', '/locations', '/materials', '/categories', '/alerts',
  ],
  technician: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation',
    '/cost-analysis', '/materials', '/categories', '/alerts',
  ],
  procurement: [
    '/', '/inventory', '/inbound', '/materials', '/suppliers', '/purchase-orders', '/supplier-returns', '/categories', '/alerts',
  ],
  finance: [
    '/', '/inventory', '/supplier-returns', '/reconciliation', '/cost-analysis', '/categories', '/alerts',
  ],
  pathologist: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation', '/cost-analysis',
  ],
}
