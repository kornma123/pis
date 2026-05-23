import { useState, useEffect, useMemo } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
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
  ChevronLeft,
  ChevronRight,
  PanelLeft,
  PanelRight,
  ShoppingCart,
  Undo2,
  Trash2,
  ArrowRightLeft,
} from 'lucide-react'

interface MenuItem {
  label: string
  path: string
  icon: React.ElementType
}

const ALL_MAIN_MENU: MenuItem[] = [
  { label: '仪表盘', path: '/', icon: LayoutDashboard },
  { label: '库存列表', path: '/inventory', icon: Package },
  { label: '入库记录', path: '/inbound', icon: ArrowDownToLine },
  { label: '出库记录', path: '/outbound', icon: ArrowUpFromLine },
  { label: '退库管理', path: '/returns', icon: Undo2 },
  { label: '报废管理', path: '/scraps', icon: Trash2 },
  { label: '调拨管理', path: '/transfers', icon: ArrowRightLeft },
  { label: '库存盘点', path: '/stocktaking', icon: ClipboardCheck },
  { label: '检测项目', path: '/projects', icon: FlaskConical },
  { label: 'BOM清单', path: '/bom', icon: ClipboardList },
  { label: '消耗对账', path: '/reconciliation', icon: Activity },
  { label: '物料成本分析', path: '/cost-analysis', icon: BarChart3 },
  { label: '物料分类', path: '/categories', icon: FolderTree },
  { label: '耗材管理', path: '/materials', icon: Boxes },
  { label: '预警中心', path: '/alerts', icon: Bell },
]

const ALL_SYSTEM_MENU: MenuItem[] = [
  { label: '采购订单', path: '/purchase-orders', icon: ShoppingCart },
  { label: '供应商管理', path: '/suppliers', icon: Truck },
  { label: '库位管理', path: '/locations', icon: MapPin },
  { label: '用户管理', path: '/users', icon: Users },
  { label: '角色权限', path: '/roles', icon: Shield },
  { label: '操作日志', path: '/logs', icon: FileText },
]

// 角色-菜单权限映射（与后端 E2E 权限矩阵保持一致）
const ROLE_MENU_MAP: Record<string, string[]> = {
  admin: [
    '/', '/inventory', '/inbound', '/outbound', '/returns', '/scraps', '/transfers', '/stocktaking',
    '/projects', '/bom', '/reconciliation', '/cost-analysis',
    '/categories', '/materials', '/alerts',
    '/purchase-orders', '/suppliers', '/locations', '/users', '/roles', '/logs',
  ],
  warehouse_manager: [
    '/', '/inventory', '/inbound', '/outbound', '/returns', '/scraps', '/transfers', '/stocktaking',
    '/suppliers', '/locations', '/materials', '/alerts',
  ],
  technician: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation',
    '/cost-analysis', '/materials',
  ],
  procurement: [
    '/', '/inventory', '/inbound', '/materials', '/suppliers', '/purchase-orders',
  ],
  finance: [
    '/', '/inventory', '/reconciliation', '/cost-analysis',
  ],
  pathologist: [
    '/', '/inventory', '/projects', '/bom', '/reconciliation', '/cost-analysis',
  ],
}

function decodeBase64Url(str: string): string {
  const padding = '='.repeat((4 - (str.length % 4)) % 4)
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + padding
  return atob(base64)
}

function getUserRole(): string | null {
  try {
    const token = localStorage.getItem('token')
    if (token) {
      const payload = JSON.parse(decodeBase64Url(token.split('.')[1]))
      if (payload.role) return payload.role
    }
    const userStr = localStorage.getItem('user')
    if (userStr) {
      const user = JSON.parse(userStr)
      return user.role || null
    }
  } catch { /* ignore */ }
  return null
}

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
    if (!role) return ALL_MAIN_MENU.map(m => m.path).concat(ALL_SYSTEM_MENU.map(m => m.path))
    return ROLE_MENU_MAP[role] || ROLE_MENU_MAP.technician
  }, [role])

  const mainMenuItems = useMemo(() =>
    ALL_MAIN_MENU.filter(item => allowedPaths.includes(item.path)),
  [allowedPaths])

  const systemMenuItems = useMemo(() =>
    ALL_SYSTEM_MENU.filter(item => allowedPaths.includes(item.path)),
  [allowedPaths])

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
        className="fixed top-4 left-4 z-50 lg:hidden w-10 h-10 bg-white rounded-lg shadow-md flex items-center justify-center text-gray-600 hover:text-[#3b82f6] transition-colors"
      >
        {mobileOpen ? <PanelRight className="w-5 h-5" /> : <PanelLeft className="w-5 h-5" />}
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
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            {!collapsed && <span>收起侧边栏</span>}
          </button>
        </div>
      </aside>
    </>
  )
}
