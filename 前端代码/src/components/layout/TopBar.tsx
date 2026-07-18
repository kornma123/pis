import { useState, useRef, useEffect } from 'react'
import { Bell, User, LogOut, Search, ChevronRight, Settings, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { useLocation } from 'react-router-dom'
import { clearAuth } from '@/api/request'

const breadcrumbMap: Record<string, string> = {
  '/': '仪表盘',
  '/inventory': '库存列表',
  '/inbound': '入库记录',
  '/outbound': '出库记录',
  '/stocktaking': '库存盘点',
  '/categories': '物料分类',
  '/materials': '耗材管理',
  '/suppliers': '供应商管理',
  '/locations': '库位管理',
  '/projects': '检测项目',
  '/bom': 'BOM清单',
  '/cost-analysis': '物料成本分析',
  '/reconciliation': '消耗对账',
  '/alerts': '预警中心',
  '/purchase-orders': '采购订单',
  '/returns': '退库管理',
  '/scraps': '报废管理',
  '/transfers': '调拨管理',
  '/users': '用户管理',
  '/roles': '角色权限',
  '/logs': '操作日志',
}

export default function TopBar() {
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const notificationRef = useRef<HTMLDivElement>(null)
  const notificationButtonRef = useRef<HTMLButtonElement>(null)
  const notificationPanelRef = useRef<HTMLDivElement>(null)
  const location = useLocation()

  function decodeBase64Url(str: string): string {
    const padding = '='.repeat((4 - (str.length % 4)) % 4)
    const base64 = str.replace(/-/g, '+').replace(/_/g, '/') + padding
    return atob(base64)
  }

  function getUserInfo() {
    try {
      const token = localStorage.getItem('token')
      if (token) {
        const payload = JSON.parse(decodeBase64Url(token.split('.')[1]))
        return {
          realName: payload.realName || payload.username || '用户',
          role: payload.role || '',
          username: payload.username || '',
        }
      }
      const userStr = localStorage.getItem('user')
      if (userStr) {
        const user = JSON.parse(userStr)
        return {
          realName: user.realName || user.username || '用户',
          role: user.role || '',
          username: user.username || '',
        }
      }
    } catch { /* ignore */ }
    return { realName: '用户', role: '', username: '' }
  }

  const roleLabels: Record<string, string> = {
    admin: '系统管理员',
    warehouse_manager: '仓库管理员',
    technician: '技术员',
    procurement: '采购员',
    finance: '财务人员',
    pathologist: '病理医生',
  }

  const userInfo = getUserInfo()
  const displayName = userInfo.realName
  const displayRole = roleLabels[userInfo.role] || userInfo.role || '用户'

  // Close dropdowns on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false)
      }
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setNotificationOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    if (notificationOpen) {
      notificationPanelRef.current?.focus()
    }
  }, [notificationOpen])

  const handleLogout = () => {
    clearAuth()
    toast.success('已退出登录')
    window.location.href = '/login'
  }

  // Generate breadcrumbs
  const generateBreadcrumbs = () => {
    const path = location.pathname
    const crumbs: { label: string; path?: string }[] = []

    if (path === '/') {
      crumbs.push({ label: '仪表盘' })
      return crumbs
    }

    crumbs.push({ label: '首页', path: '/' })

    const segments = path.split('/').filter(Boolean)
    let currentPath = ''

    segments.forEach((segment, index) => {
      currentPath += `/${segment}`
      const isLast = index === segments.length - 1
      const label = breadcrumbMap[currentPath] || segment

      if (isLast) {
        crumbs.push({ label })
      } else {
        crumbs.push({ label, path: currentPath })
      }
    })

    return crumbs
  }

  const breadcrumbs = generateBreadcrumbs()

  return (
    <header className="h-16 bg-white border-b border-[#e5e7eb] flex items-center justify-between px-6 flex-shrink-0">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1 text-sm">
        {breadcrumbs.map((crumb, index) => (
          <div key={index} className="flex items-center gap-1">
            {index > 0 && <ChevronRight className="w-4 h-4 text-gray-300" />}
            {crumb.path ? (
              <a
                href={crumb.path}
                className="text-[#6b7280] hover:text-[#3b82f6] transition-colors duration-150"
              >
                {crumb.label}
              </a>
            ) : (
              <span className="text-[#111827] font-medium">{crumb.label}</span>
            )}
          </div>
        ))}
      </nav>

      {/* Right section */}
      <div className="flex items-center gap-3">
        {/* Search */}
        <div className="relative hidden sm:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="全局搜索..."
            className="w-64 pl-10 pr-4 py-2 bg-[#f9fafb] border border-[#e5e7eb] rounded-md text-sm text-[#374151] placeholder:text-gray-400 focus:outline-none focus:border-[#3b82f6] focus:ring-3 focus:ring-[rgba(59,130,246,0.1)] transition-all duration-150"
          />
        </div>

        {/* Notifications */}
        <div className="relative" ref={notificationRef}>
          <button
            ref={notificationButtonRef}
            type="button"
            aria-label="通知消息，数据源未接入"
            aria-haspopup="dialog"
            aria-expanded={notificationOpen}
            aria-controls="topbar-notification-panel"
            onClick={() => setNotificationOpen(open => !open)}
            className="relative p-2 text-[#6b7280] hover:text-[#374151] hover:bg-gray-50 rounded-md transition-all duration-150 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/10"
          >
            <Bell className="w-5 h-5" aria-hidden="true" />
          </button>

          {notificationOpen && (
            <div
              ref={notificationPanelRef}
              id="topbar-notification-panel"
              role="dialog"
              aria-label="通知消息"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation()
                  setNotificationOpen(false)
                  notificationButtonRef.current?.focus()
                }
              }}
              className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-[#e5e7eb] py-2 z-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-blue-500/10"
            >
              <div className="px-4 py-2 border-b border-[#e5e7eb]">
                <span className="text-sm font-medium text-[#111827]">通知消息</span>
              </div>
              <div className="px-4 py-6 text-center" aria-live="polite">
                <Bell className="w-6 h-6 mx-auto text-gray-400" aria-hidden="true" />
                <p className="mt-2 text-sm font-medium text-[#111827]">通知数据源未接入</p>
                <p className="mt-1 text-xs text-[#6b7280]">当前没有可用于通知角标的已验证数据。</p>
              </div>
              <div className="px-4 py-2 border-t border-[#e5e7eb]">
                <a
                  href="/alerts"
                  onClick={() => setNotificationOpen(false)}
                  className="text-xs text-[#3b82f6] hover:underline flex items-center justify-center"
                >
                  前往预警中心
                </a>
              </div>
            </div>
          )}
        </div>

        {/* User dropdown */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 p-1.5 pr-3 text-[#374151] hover:bg-gray-50 rounded-md transition-all duration-150"
          >
            <div className="w-8 h-8 bg-[#3b82f6] rounded-full flex items-center justify-center text-white text-sm font-medium">
              <User className="w-4 h-4" />
            </div>
            <div className="hidden sm:flex flex-col items-start">
              <span className="text-sm font-medium leading-tight">{displayName}</span>
              <span className="text-xs text-[#6b7280] leading-tight">{displayRole}</span>
            </div>
          </button>

          {userMenuOpen && (
            <div className="absolute right-0 mt-2 w-52 bg-white rounded-lg shadow-lg border border-[#e5e7eb] py-1 z-50">
              <div className="px-4 py-3 border-b border-[#e5e7eb]">
                <p className="text-sm font-medium text-[#111827]">{displayName}</p>
                <p className="text-xs text-[#6b7280]">{userInfo.username || displayRole}</p>
              </div>
              <a
                href="/users"
                className="flex items-center gap-2 px-4 py-2 text-sm text-[#374151] hover:bg-gray-50 transition-colors"
                onClick={() => setUserMenuOpen(false)}
              >
                <User className="w-4 h-4 text-gray-400" />
                个人信息
              </a>
              <a
                href="/roles"
                className="flex items-center gap-2 px-4 py-2 text-sm text-[#374151] hover:bg-gray-50 transition-colors"
                onClick={() => setUserMenuOpen(false)}
              >
                <Settings className="w-4 h-4 text-gray-400" />
                系统设置
              </a>
              <a
                href="/logs"
                className="flex items-center gap-2 px-4 py-2 text-sm text-[#374151] hover:bg-gray-50 transition-colors"
                onClick={() => setUserMenuOpen(false)}
              >
                <FileText className="w-4 h-4 text-gray-400" />
                操作日志
              </a>
              <div className="border-t border-[#e5e7eb] mt-1 pt-1">
                <button
                  onClick={handleLogout}
                  className="flex items-center gap-2 w-full px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
                >
                  <LogOut className="w-4 h-4" />
                  退出登录
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
