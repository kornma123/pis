import { Outlet, useLocation, Navigate } from 'react-router-dom'
import { useMemo } from 'react'
import AppSidebar from './AppSidebar'
import TopBar from './TopBar'

const ROLE_MENU_MAP: Record<string, string[]> = {
  admin: [
    '/', '/inventory', '/inbound', '/outbound', '/stocktaking',
    '/projects', '/bom', '/reconciliation', '/cost-analysis',
    '/categories', '/materials', '/alerts',
    '/suppliers', '/locations', '/users', '/roles', '/logs',
  ],
  warehouse_manager: [
    '/', '/inventory', '/inbound', '/outbound', '/stocktaking',
    '/suppliers', '/locations', '/materials', '/alerts',
  ],
  technician: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation',
    '/cost-analysis', '/materials', '/alerts',
  ],
  procurement: [
    '/', '/inventory', '/inbound', '/materials', '/suppliers', '/alerts',
  ],
  finance: [
    '/', '/inventory', '/reconciliation', '/cost-analysis', '/alerts',
  ],
  pathologist: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation', '/cost-analysis', '/alerts',
  ],
}

function getUserRole(): string | null {
  try {
    const userStr = localStorage.getItem('user')
    if (userStr) {
      const user = JSON.parse(userStr)
      return user.role || null
    }
  } catch { /* ignore */ }
  return null
}

export default function AppLayout() {
  const location = useLocation()
  const role = getUserRole()

  const allowedPaths = useMemo(() => {
    if (!role) return []
    return ROLE_MENU_MAP[role] || ROLE_MENU_MAP.technician
  }, [role])

  // 路由守卫：无权限访问时重定向
  const hasAccess = !role || allowedPaths.includes(location.pathname)
  if (!hasAccess) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex min-h-screen bg-[#f9fafb]">
      {/* Sidebar */}
      <AppSidebar />

      {/* Main content area */}
      <div className="flex-1 flex flex-col min-w-0 min-h-screen">
        {/* TopBar */}
        <TopBar />

        {/* Page content */}
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
