import { Outlet, useLocation, Navigate } from 'react-router-dom'
import { useMemo } from 'react'
import AppSidebar from './AppSidebar'
import TopBar from './TopBar'
import { getUserRole, getAccessiblePaths } from '@/lib/permissions'

export default function AppLayout() {
  const location = useLocation()
  const role = getUserRole()
  // 访问令牌是真正的凭证：缺失（登出/被清除/未登录）即视为未认证，即便 user 对象仍残留。
  // 仅用 user/role 判断会导致「只删 token、user 还在」时仍能停留在受保护页（AUTH-LOGOUT-05）。
  const hasToken = typeof localStorage !== 'undefined' && !!localStorage.getItem('token')

  // 能力驱动：可访问路径由 capabilities 推出（capabilities 缺失时退回旧角色映射）
  const allowedPaths = useMemo(() => {
    if (!role) return []
    return getAccessiblePaths()
  }, [role, location.pathname])

  // 路由守卫：未登录（无令牌或无角色）重定向到登录页，无权限重定向到首页
  if (!hasToken || !role) {
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
