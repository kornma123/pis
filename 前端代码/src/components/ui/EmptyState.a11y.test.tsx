import React from 'react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'

const globalStyles = readFileSync(path.resolve(process.cwd(), 'src/styles/global.css'), 'utf8')

function TestIcon(props: React.SVGProps<SVGSVGElement>) {
  return <svg data-testid="empty-icon" {...props} />
}

describe('EmptyState accessibility contract', () => {
  it('exposes a named semantic region, heading, description, and decorative icon', () => {
    render(
      <EmptyState
        icon={TestIcon}
        title="暂无库存"
        description="先创建一条入库记录。"
        action={{ label: '创建入库', onClick: vi.fn() }}
      />,
    )

    const region = screen.getByRole('region', { name: '暂无库存' })
    expect(within(region).getByRole('heading', { name: '暂无库存' })).toBeInTheDocument()
    expect(region).toHaveAccessibleDescription('先创建一条入库记录。')
    expect(screen.getByTestId('empty-icon')).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByTestId('empty-icon')).toHaveAttribute('focusable', 'false')
    expect(within(region).getByText('先创建一条入库记录。')).toHaveClass('text-gray-500', 'break-words')
    const action = within(region).getByRole('button', { name: '创建入库' })
    expect(action).toHaveAttribute('type', 'button')
    expect(action).toHaveClass('a11y-focus-ring')
  })

  it('does not announce by default and supports an opt-in polite live region', async () => {
    const { rerender } = render(<EmptyState title="暂无数据" description="请稍后重试。" />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    rerender(
      <EmptyState
        title="暂无数据"
        description="请稍后重试。"
        liveRegion="polite"
        action={{ label: '重试', onClick: vi.fn() }}
      />,
    )

    const status = await screen.findByRole('status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).toHaveTextContent('暂无数据')
    expect(status).toHaveTextContent('请稍后重试。')
    expect(status).not.toContainElement(screen.getByRole('button', { name: '重试' }))
  })

  it('supports an assertive live region for urgent empty/error states', async () => {
    render(<EmptyState title="加载失败" liveRegion="assertive" />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveAttribute('aria-live', 'assertive')
    expect(alert).toHaveTextContent('加载失败')
  })

  it('uses unique title and description ids across instances', () => {
    render(
      <>
        <EmptyState title="第一空态" description="第一段说明" />
        <EmptyState title="第二空态" description="第二段说明" />
      </>,
    )

    const first = screen.getByRole('region', { name: '第一空态' })
    const second = screen.getByRole('region', { name: '第二空态' })
    expect(first.getAttribute('aria-labelledby')).not.toBe(second.getAttribute('aria-labelledby'))
    expect(first.getAttribute('aria-describedby')).not.toBe(second.getAttribute('aria-describedby'))
  })

  it('allows callers to preserve the surrounding heading hierarchy', () => {
    render(<EmptyState title="三级空态" headingLevel={3} />)

    expect(screen.getByRole('heading', { name: '三级空态', level: 3 })).toBeInTheDocument()
  })

  it('carries the 320px and 200% zoom reflow contract without horizontal spill', () => {
    render(
      <EmptyState
        title="这是一个需要在窄屏完整换行的空状态标题"
        description="https://example.test/a-very-long-unbroken-accessibility-description"
      />,
    )

    const region = screen.getByRole('region')
    expect(region).toHaveClass('w-full', 'max-w-full', 'min-w-0', '[overflow-wrap:anywhere]')
    expect(within(region).getByRole('heading')).toHaveClass('break-words')
    expect(region).toHaveTextContent('a-very-long-unbroken-accessibility-description')
  })
})

describe('shared focus appearance contract', () => {
  it('provides a clear focus-visible outline and a forced-colors fallback', () => {
    expect(globalStyles).toMatch(
      /\.a11y-focus-ring:focus-visible\s*{[^}]*outline:\s*2px\s+solid[^}]*outline-offset:\s*2px/s,
    )
    expect(globalStyles).toMatch(
      /@media\s*\(forced-colors:\s*active\)\s*{\s*\.a11y-focus-ring:focus-visible\s*{[^}]*outline-color:\s*CanvasText/s,
    )
  })
})
