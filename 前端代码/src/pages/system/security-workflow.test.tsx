import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import request from '@/api/request'
import type { Role, User } from '@/types'
import { useUsersPage } from './hooks/useUsersPage'
import { useRolesPage } from './hooks/useRolesPage'
import { UsersTable } from './components/UsersTable'
import { RolesGrid } from './components/RolesGrid'
import { RoleDetailModal } from './components/RoleDetailModal'
import { RoleDeleteModal } from './components/RoleDeleteModal'
import { UserDetailModal } from './components/UserDetailModal'
import { UserFormModal } from './components/UserFormModal'

vi.mock('@/api/request', () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

const mockGet = request.get as unknown as ReturnType<typeof vi.fn>
const mockPut = request.put as unknown as ReturnType<typeof vi.fn>

const user: User = {
  id: 'U-1', username: 'reader', realName: '只读用户', role: 'operator',
  permissions: [], status: 'active', createdAt: '2026-07-18T00:00:00.000Z',
}

const role: Role = {
  id: 'R-1', code: 'admin', name: '名称恰为管理员', description: '测试角色',
  permissions: { inventory: 'R' }, status: 'active', createdAt: '2026-07-18T00:00:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/users')
  localStorage.setItem('user', JSON.stringify({
    role: 'operator',
    capabilities: { users: 'R', roles: 'R' },
  }))
  mockGet.mockImplementation(async (url: string) => {
    if (url === '/users') return { list: [user], pagination: { total: 1, page: 1, pageSize: 20 } }
    if (url === '/roles') return { list: [role], pagination: { total: 1, page: 1, pageSize: 20 } }
    return { list: [], pagination: { total: 0, page: 1, pageSize: 20 } }
  })
})

describe('system management capability boundary', () => {
  it('keeps users:R sessions read-only in both handlers and table actions', async () => {
    const { result } = renderHook(() => useUsersPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.canWrite).toBe(false)
    act(() => result.current.openCreate())
    expect(result.current.modalType).toBeNull()
    await act(async () => { await result.current.handleToggleStatus(user) })
    expect(mockPut).not.toHaveBeenCalled()

    render(
      <UsersTable
        data={[user]} loading={false} total={1} page={1} pageSize={20}
        keyword="" roles={[]} canWrite={false}
        onKeywordChange={vi.fn()} onSearch={vi.fn()} onReset={vi.fn()}
        onPageChange={vi.fn()} onPageSizeChange={vi.fn()}
        onOpenDetail={vi.fn()} onOpenEdit={vi.fn()} onToggleStatus={vi.fn()} onDelete={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '详情' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '停用' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()
  })

  it('keeps roles:R sessions read-only without literal-admin authorization logic', async () => {
    const { result } = renderHook(() => useRolesPage())
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.canWrite).toBe(false)
    act(() => result.current.openCreate())
    expect(result.current.modalType).toBeNull()

    render(
      <RolesGrid
        data={[role]} loading={false} canWrite={false}
        onDetail={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()}
      />
    )
    expect(screen.getByRole('button', { name: '查看详情' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除' })).not.toBeInTheDocument()
  })
})

describe('system management unknown-data truth', () => {
  it('derives permission display from returned permissions, not the literal admin code', () => {
    render(<RoleDetailModal open role={role} onClose={vi.fn()} />)
    expect(screen.queryByText('全部权限')).not.toBeInTheDocument()
    expect(screen.queryByText('拥有系统全部权限')).not.toBeInTheDocument()
    expect(screen.getByText(/库存/)).toBeInTheDocument()
    expect(screen.getAllByText('接口未提供').length).toBeGreaterThanOrEqual(1)
  })

  it('does not turn missing role-user counts or user capabilities into zero/empty facts', () => {
    const { unmount } = render(<RoleDeleteModal open role={role} onClose={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByText(/关联用户数量.*接口未提供/)).toBeInTheDocument()
    expect(screen.queryByText(/0 人/)).not.toBeInTheDocument()
    unmount()

    render(<UserDetailModal open user={user} canWrite={false} onClose={vi.fn()} onEdit={vi.fn()} />)
    expect(screen.getByText(/接口未返回用户能力信息/)).toBeInTheDocument()
    expect(screen.queryByText(/数据范围[:：]\s*本部门数据/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '编辑' })).not.toBeInTheDocument()
  })

  it('focuses the form error summary and supports Escape through the shared dialog contract', () => {
    const onClose = vi.fn()
    render(
      <UserFormModal
        open
        type="create"
        form={{ username: '', password: '', realName: '', role: '', roles: [], primaryRole: '', department: '', phone: '', email: '', status: 'active' }}
        roles={[]}
        error="请填写用户名和姓名。"
        onClose={onClose}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )
    expect(screen.getByRole('dialog', { name: '新建用户' })).toBeInTheDocument()
    expect(screen.getByText('请填写用户名和姓名。')).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
