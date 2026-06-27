import { Outlet, useLocation, Navigate } from 'react-router-dom'
import { useMemo } from 'react'
import AppSidebar from './AppSidebar'
import TopBar from './TopBar'
import { getUserRole, getAccessiblePaths } from '@/lib/permissions'

export default function AppLayout() {
  const location = useLocation()
  const role = getUserRole()

  // 能力驱动：可访问路径由 capabilities 推出（capabilities 缺失时退回旧角色映射）
  const allowedPaths = useMemo(() => {
    if (!role) return []
    return getAccessiblePaths()
  }, [role, location.pathname])

  // 路由守卫：未登录重定向到登录页，无权限重定向到首页
  if (!role) {
    return <Navigate to="/login" replace />
  }
  const hasAccess = allowedPaths.includes(location.pathname)
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
