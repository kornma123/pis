import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role } from '@/types'
import { RoleFormModal } from './components/RoleFormModal'
import { RoleDetailModal } from './components/RoleDetailModal'
import { RolesGrid } from './components/RolesGrid'
import {
  normalizeRolePerms,
  useRolesPage,
  type FormData,
} from './hooks/useRolesPage'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  requestPut: vi.fn(),
  setMultiple: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('@/api/request', () => ({
  default: {
    delete: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: mocks.requestPut,
  },
}))

vi.mock('@/hooks/usePagination', () => ({
  usePagination: () => ({
    data: [],
    loading: false,
    page: 1,
    pageSize: 20,
    total: 0,
    setPage: vi.fn(),
    setPageSize: vi.fn(),
    refresh: mocks.refresh,
  }),
}))

vi.mock('@/hooks/useUrlParams', () => ({
  useUrlParams: () => ({
    getNumber: (_key: string, fallback: number) => fallback,
    setMultiple: mocks.setMultiple,
  }),
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: mocks.toastSuccess,
  },
}))

const RETIRED_PERMISSION_LABELS = [
  'ABC 成本看板',
  '单片成本',
  '盈利分析',
  'ABC 配置',
  '设备管理',
  '标准工时',
]

const legacyPermissions: Record<string, 'R' | 'W'> = {
  abc_dashboard: 'W',
  slide_cost: 'W',
  profitability: 'W',
  abc_config: 'W',
  equipment: 'W',
  labor_times: 'W',
  antibody_cost: 'W',
  inventory: 'R',
}

const form: FormData = {
  code: 'ROLE-COST-REVIEW',
  name: '成本复核',
  description: '兼容存量角色',
  permissions: legacyPermissions,
  status: 'active',
  dataScope: 'dept',
}

const legacyRole: Role = {
  id: 'role-cost-review',
  code: 'cost_review',
  name: '成本复核',
  description: '兼容存量角色',
  permissions: legacyPermissions,
  status: 'active',
  createdAt: '2026-07-27T00:00:00.000Z',
}

function expectOnlyMaterialCompatibilityPermission() {
  for (const label of RETIRED_PERMISSION_LABELS) {
    expect(screen.queryByText(label)).not.toBeInTheDocument()
  }
  expect(screen.getByText('逐抗体成本')).toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requestPut.mockResolvedValue(undefined)
})

describe('retired role permission product surfaces', () => {
  it('normalizes object permissions against the current module allowlist', () => {
    expect(normalizeRolePerms(legacyPermissions)).toEqual({
      antibody_cost: 'W',
      inventory: 'R',
    })
  })

  it('scrubs retired object permissions from an edited role before PUT', async () => {
    const { result } = renderHook(() => useRolesPage())

    act(() => {
      result.current.openEdit(legacyRole)
    })
    expect(result.current.form.permissions).toEqual({
      antibody_cost: 'W',
      inventory: 'R',
    })

    act(() => {
      result.current.setForm((current) => ({
        ...current,
        name: '成本复核（已编辑）',
      }))
    })
    await act(async () => {
      await result.current.handleSubmit()
    })

    expect(mocks.requestPut).toHaveBeenCalledWith(
      `/roles/${legacyRole.id}`,
      expect.objectContaining({
        name: '成本复核（已编辑）',
        permissions: {
          antibody_cost: 'W',
          inventory: 'R',
        },
      }),
    )
  })

  it.each(['create', 'edit'] as const)(
    'keeps retired modules out of the %s form while antibody material compatibility remains assignable',
    (type) => {
      const onSetPermLevel = vi.fn()
      render(
        <RoleFormModal
          open
          type={type}
          form={form}
          onClose={vi.fn()}
          onChange={vi.fn()}
          onSubmit={vi.fn()}
          onSetPermLevel={onSetPermLevel}
        />
      )

      expectOnlyMaterialCompatibilityPermission()
      const materialRow = screen.getByText('逐抗体成本').closest('tr')
      expect(materialRow).not.toBeNull()
      fireEvent.click(within(materialRow!).getByRole('button', { name: '读写' }))
      expect(onSetPermLevel).toHaveBeenCalledWith('antibody_cost', 'W')
    }
  )

  it('filters retired legacy keys from role details without hiding antibody material compatibility', () => {
    render(<RoleDetailModal open role={legacyRole} onClose={vi.fn()} />)

    expectOnlyMaterialCompatibilityPermission()
  })

  it('filters retired legacy keys from the role grid without hiding antibody material compatibility', () => {
    render(
      <RolesGrid
        data={[legacyRole]}
        loading={false}
        onDetail={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        getDataScopeLabel={() => '本部门数据'}
      />
    )

    expectOnlyMaterialCompatibilityPermission()
  })
})
