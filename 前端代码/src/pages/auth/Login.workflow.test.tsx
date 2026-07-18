import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import request from '@/api/request'
import Login from './Login'

const navigate = vi.fn()

vi.mock('@/api/request', () => ({
  default: { post: vi.fn() },
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

const mockPost = request.post as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('Login fail-closed workflow', () => {
  it('renders a safe focusable summary, preserves username, and clears the rejected password', async () => {
    mockPost.mockRejectedValue({
      response: {
        status: 401,
        data: { error: { message: 'SQLITE_CONSTRAINT: internal users table detail' } },
      },
    })

    render(<MemoryRouter><Login /></MemoryRouter>)

    const username = screen.getByLabelText('用户名')
    const password = screen.getByLabelText('密码')
    fireEvent.change(username, { target: { value: 'operator' } })
    fireEvent.change(password, { target: { value: 'Secret-123!' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    const summary = await screen.findByRole('alert')
    expect(summary).toHaveTextContent('用户名或密码错误，请重新输入。')
    expect(summary).toHaveFocus()
    expect(screen.queryByText(/SQLITE_CONSTRAINT|users table/i)).not.toBeInTheDocument()
    expect(username).toHaveValue('operator')
    expect(password).toHaveValue('')
    expect(screen.getByRole('button', { name: '重新登录' })).toBeEnabled()
  })

  it('associates validation errors with fields and moves focus to the summary', async () => {
    render(<MemoryRouter><Login /></MemoryRouter>)

    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    const summary = await screen.findByRole('alert')
    expect(summary).toHaveTextContent('请修正以下问题')
    expect(summary).toHaveFocus()
    expect(screen.getByLabelText('用户名')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('密码')).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(mockPost).not.toHaveBeenCalled())
  })
})
