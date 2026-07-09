import { useState, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { getUserRole, getAccessiblePaths } from '@/lib/permissions'
import { deriveSidebarMenu, allActivePaths, type MenuItem } from '@/lib/route-registry'
import {
  Users,
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  PanelRight,
} from 'lucide-react'

// 菜单从路由注册表（@/lib/route-registry）派生——不再各处手写 MenuItem。
// 顺序/文案/图标/分区均由注册表声明顺序决定，与迁移前 ALL_MAIN_MENU + ALL_SYSTEM_MENU
// 逐字节一致（route-registry.test.ts 快照锁死·零行为变更）。

function getRoleLabel(role: string | null): string {
  const labels: Record<string, string> = {
    admin: '系统管理员',
    warehouse_manager: '仓库管理员',
    technician: '技术员',
    procurement: '采购员',
    finance: '财务人员',
    pathologist: '病理医生',
  }
  return labels[role || ''] || '用户'
}

export default function AppSidebar() {
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  const role = useMemo(() => getUserRole(), [location.pathname])
  const allowedPaths = useMemo(() => {
    // 未登录：显示全部 active 项（与迁移前 ALL_MAIN_MENU+ALL_SYSTEM_MENU 全集一致）。
    if (!role) return allActivePaths()
    return getAccessiblePaths()
  }, [role, location.pathname])

  // 从注册表派生（active 项·按声明顺序·分主菜单/系统菜单区·按 allowedPaths 过滤）。
  const { main: mainMenuItems, system: systemMenuItems } = useMemo(
    () => deriveSidebarMenu(allowedPaths),
    [allowedPaths]
  )

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false)
  }, [location.pathname])

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/'
    }
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }

  const Logo = () => (
    <div className="flex items-center gap-3 px-4">
      <div className="w-8 h-8 rounded-lg bg-[#3b82f6] flex items-center justify-center flex-shrink-0">
        <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 16L14 10L20 16L14 22L8 16Z" fill="white"/>
          <path d="M14 16L20 10L26 16L20 22L14 16Z" fill="white" opacity="0.6"/>
        </svg>
      </div>
      {!collapsed && (
        <div className="flex flex-col">
          <span className="text-base font-bold text-[#111827] leading-tight tracking-tight">COREONE</span>
          <span className="text-[11px] text-gray-400 leading-tight">病理实验室耗材管理</span>
        </div>
      )}
    </div>
  )

  const NavItem = ({ item }: { item: MenuItem }) => {
    const Icon = item.icon
    const active = isActive(item.path)

    return (
      <Link
        to={item.path}
        className={cn(
          'flex items-center gap-3 px-4 py-2.5 mx-2 rounded-md transition-all duration-150 ease-out',
          active
            ? 'bg-[#eff6ff] text-[#3b82f6]'
            : 'text-[#6b7280] hover:bg-gray-50 hover:text-[#374151]',
          collapsed && 'justify-center px-2 mx-1'
        )}
        title={collapsed ? item.label : undefined}
      >
        <Icon className={cn('w-5 h-5 flex-shrink-0', active && 'text-[#3b82f6]')} />
        {!collapsed && (
          <span className="text-sm font-medium truncate">{item.label}</span>
        )}
      </Link>
    )
  }

  const NavDivider = () => (
    <div className="mx-4 my-2 h-px bg-[#e5e7eb]" />
  )

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile toggle button */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        aria-label={mobileOpen ? '关闭导航菜单' : '打开导航菜单'}
        aria-expanded={mobileOpen}
        className="fixed top-4 left-4 z-50 lg:hidden w-10 h-10 bg-white rounded-lg shadow-md flex items-center justify-center text-gray-600 hover:text-[#3b82f6] transition-colors"
      >
        {mobileOpen ? <PanelRight className="w-5 h-5" aria-hidden="true" /> : <PanelLeft className="w-5 h-5" aria-hidden="true" />}
      </button>

      {/* Sidebar */}
      <aside
        className={cn(
          'bg-white border-r border-[#e5e7eb] flex flex-col transition-all duration-300 ease-out z-40',
          'fixed lg:static inset-y-0 left-0',
          collapsed ? 'w-[72px]' : 'w-64',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Logo area */}
        <div className="h-16 flex items-center border-b border-[#e5e7eb] flex-shrink-0">
          <Logo />
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3 space-y-0.5">
          {mainMenuItems.map(item => (
            <NavItem key={item.path} item={item} />
          ))}

          {systemMenuItems.length > 0 && <NavDivider />}

          {systemMenuItems.map(item => (
            <NavItem key={item.path} item={item} />
          ))}
        </nav>

        {/* Bottom user info */}
        <div className="p-3 border-t border-[#e5e7eb] flex-shrink-0">
          <div
            className={cn(
              'flex items-center gap-3 rounded-lg p-2 transition-all duration-150',
              !collapsed && 'hover:bg-gray-50'
            )}
          >
            <div className="w-8 h-8 rounded-full bg-[#3b82f6]/10 flex items-center justify-center flex-shrink-0">
              <Users className="w-4 h-4 text-[#3b82f6]" />
            </div>
            {!collapsed && (
              <div className="flex flex-col min-w-0">
                <span className="text-sm font-medium text-[#111827] truncate">{getRoleLabel(role)}</span>
                <span className="text-xs text-[#6b7280] truncate">{role || '用户'}</span>
              </div>
            )}
          </div>

          {/* Collapse toggle */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              'mt-2 flex items-center gap-2 w-full p-2 rounded-md text-[#6b7280] hover:bg-gray-50 hover:text-[#374151] transition-all duration-150 text-sm',
              collapsed && 'justify-center'
            )}
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            aria-expanded={!collapsed}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" aria-hidden="true" /> : <ChevronLeft className="w-4 h-4" aria-hidden="true" />}
            {!collapsed && <span>收起侧边栏</span>}
          </button>
        </div>
      </aside>
    </>
  )
}
