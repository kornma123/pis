import { fireEvent, render, screen } from '@testing-library/react'
import { BrowserRouter, Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppLayout from './AppLayout'
import { isRoutePathAccessible } from '@/lib/route-registry'

vi.mock('./AppSidebar', () => ({
  default: () => <aside aria-label="侧边导航" />,
}))

vi.mock('./TopBar', () => ({
  default: () => <header>顶部栏</header>,
}))

type TestUser = {
  role: string
  roles?: string[]
  capabilities?: Record<string, 'R' | 'W'>
}

function seedSession(user: TestUser, token = 'test-token') {
  localStorage.setItem('token', token)
  localStorage.setItem('user', JSON.stringify(user))
}

function LocationProbe() {
  const location = useLocation()
  return (
    <output aria-label="当前地址">
      {location.pathname}{location.search}{location.hash}
    </output>
  )
}

function EquipmentHome() {
  return (
    <>
      <h1>设备管理内容</h1>
      <Link to="/equipment/types">设备类型</Link>
    </>
  )
}

function AccessRoutes() {
  return (
    <>
      <LocationProbe />
      <Routes>
        <Route path="/login" element={<h1>登录页</h1>} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<h1>仪表盘内容</h1>} />
          <Route path="/inventory" element={<h1>库存内容</h1>} />
          <Route path="/users" element={<h1>用户管理内容</h1>} />
          <Route path="/equipment" element={<EquipmentHome />} />
          <Route path="/equipment/types" element={<h1>设备类型内容</h1>} />
          <Route path="/equipment/depreciation" element={<h1>折旧统计内容</h1>} />
        </Route>
        <Route path="*" element={<h1>404 页面</h1>} />
      </Routes>
    </>
  )
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AccessRoutes />
    </MemoryRouter>
  )
}

function renderBrowserAt(path?: string) {
  if (path) window.history.replaceState({}, '', path)
  return render(
    <BrowserRouter>
      <AccessRoutes />
    </BrowserRouter>
  )
}

afterEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

describe('AppLayout 路由可达性', () => {
  it.each([
    ['/equipment', '设备管理内容'],
    ['/equipment/types', '设备类型内容'],
    ['/equipment/depreciation', '折旧统计内容'],
  ])('equipment:R 可直接进入合法设备路由 %s', (path, heading) => {
    seedSession({
      role: 'technician',
      roles: ['technician'],
      capabilities: { equipment: 'R' },
    })

    renderAt(path)

    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent(path)
  })

  it('带查询参数和尾斜杠的设备深链在重新挂载后仍可达', () => {
    const deepLink = '/equipment/types/?keyword=EQT-DEEP-001'
    seedSession({
      role: 'finance',
      roles: ['finance'],
      capabilities: { equipment: 'W' },
    })

    const firstBoot = renderAt(deepLink)
    expect(screen.getByRole('heading', { name: '设备类型内容' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent(deepLink)

    firstBoot.unmount()
    renderAt(deepLink)

    expect(screen.getByRole('heading', { name: '设备类型内容' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent(deepLink)
  })

  it('BrowserRouter 使用真实 history 深链，刷新式重挂载后仍保持设备子路由', () => {
    const deepLink = '/equipment/types/?keyword=EQT-BROWSER-001'
    seedSession({
      role: 'finance',
      roles: ['finance'],
      capabilities: { equipment: 'W' },
    })

    const firstBoot = renderBrowserAt(deepLink)
    expect(screen.getByRole('heading', { name: '设备类型内容' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent(deepLink)

    firstBoot.unmount()
    renderBrowserAt()

    expect(screen.getByRole('heading', { name: '设备类型内容' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent(deepLink)
  })

  it('键盘方式激活父页链接与直接深链使用同一访问判定', () => {
    seedSession({
      role: 'lab_director',
      roles: ['lab_director'],
      capabilities: { equipment: 'W' },
    })
    renderAt('/equipment')

    const link = screen.getByRole('link', { name: '设备类型' })
    link.focus()
    expect(link).toHaveFocus()
    fireEvent.click(link, { detail: 0 })

    expect(screen.getByRole('heading', { name: '设备类型内容' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/equipment/types')
  })

  it.each([
    ['/users', { inventory: 'R' as const }],
    ['/equipment/types', { inventory: 'R' as const }],
    ['/equipment/depreciation', {}],
  ])('已登录但无页面权限时在原地址显示明确 403：%s', (path, capabilities) => {
    seedSession({ role: 'procurement', roles: ['procurement'], capabilities })

    renderAt(path)

    expect(screen.getByRole('heading', { name: '无权访问此页面' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent(path)
    expect(screen.queryByRole('heading', { name: '仪表盘内容' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /内容$/ })).not.toBeInTheDocument()
  })

  it('403 提供可聚焦的返回入口，只有用户激活后才回仪表盘', () => {
    seedSession({ role: 'pathologist', roles: ['pathologist'], capabilities: {} })
    renderAt('/users')

    expect(screen.getByRole('heading', { name: '无权访问此页面' })).toHaveFocus()
    const returnLink = screen.getByRole('link', { name: '返回仪表盘' })
    returnLink.focus()
    expect(returnLink).toHaveFocus()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/users')

    fireEvent.click(returnLink, { detail: 0 })

    expect(screen.getByRole('heading', { name: '仪表盘内容' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/')
  })

  it.each(['external_auditor', 'constructor'])(
    '未知旧角色 %s 缺少 capabilities 时，BrowserRouter 深链保持原地址并显示 403',
    (role) => {
      const deniedPath = '/equipment/types?from=legacy-bookmark'
      seedSession({ role, roles: [role] })

      renderBrowserAt(deniedPath)

      expect(screen.getByRole('heading', { name: '无权访问此页面' })).toHaveFocus()
      expect(screen.getByLabelText('当前地址')).toHaveTextContent(deniedPath)
      expect(screen.queryByRole('heading', { name: '设备类型内容' })).not.toBeInTheDocument()
    }
  )

  it('未登记的设备伪子路由保持 404，不从 /equipment 扩权', () => {
    seedSession({
      role: 'technician',
      roles: ['technician'],
      capabilities: { equipment: 'R' },
    })

    renderAt('/equipment/private')

    expect(screen.getByRole('heading', { name: '404 页面' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '无权访问此页面' })).not.toBeInTheDocument()
  })

  it('无 token 时仍由认证守卫跳转登录页', () => {
    localStorage.setItem('user', JSON.stringify({
      role: 'technician',
      roles: ['technician'],
      capabilities: { equipment: 'R' },
    }))

    renderAt('/equipment/types')

    expect(screen.getByRole('heading', { name: '登录页' })).toBeInTheDocument()
    expect(screen.getByLabelText('当前地址')).toHaveTextContent('/login')
  })
})

describe('注册表约束的子路由继承', () => {
  const equipmentPaths = ['/', '/equipment']

  it.each(['/equipment/types', '/equipment/depreciation', '/equipment/types/'])(
    '只让已登记且同模块的设备子路由继承父页：%s',
    (path) => {
      expect(isRoutePathAccessible(path, equipmentPaths)).toBe(true)
    }
  )

  it.each([
    '/equipment/private',
    '/equipment-evil',
    '/abc/fee-comparison',
  ])('不让未登记、伪前缀或其他模块路由借 /equipment 扩权：%s', (path) => {
    expect(isRoutePathAccessible(path, equipmentPaths)).toBe(false)
  })

  it('没有 equipment 父页权限时，合法子路由也保持拒绝', () => {
    expect(isRoutePathAccessible('/equipment/types', ['/', '/inventory'])).toBe(false)
  })
})

describe('AppSidebar 角色标签', () => {
  it('对象原型键不会被当成角色标签渲染', async () => {
    const { getRoleLabel } = await vi.importActual<typeof import('./AppSidebar')>('./AppSidebar')
    expect(getRoleLabel('constructor')).toBe('用户')
  })
})
