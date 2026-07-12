import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UserFormModal } from './UserFormModal'
import type { FormData } from '../hooks/useUsersPage'

const form: FormData = {
  username: 'new-user',
  password: 'Generated-N7v!Q2m@R8x#',
  realName: '新用户',
  role: 'technician',
  roles: ['technician'],
  primaryRole: 'technician',
  department: '',
  phone: '',
  email: '',
  status: 'active',
}

describe('UserFormModal password visibility', () => {
  it('masks a generated password by default and reveals it only on explicit action', () => {
    const { container } = render(
      <UserFormModal
        open
        type="create"
        form={form}
        onClose={vi.fn()}
        onChange={vi.fn()}
        onSubmit={vi.fn()}
      />
    )

    const input = container.querySelector('input[autocomplete="new-password"]') as HTMLInputElement
    expect(input.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: '显示密码 10 秒' }))
    expect(input.type).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: '隐藏密码' }))
    expect(input.type).toBe('password')
  })
})
