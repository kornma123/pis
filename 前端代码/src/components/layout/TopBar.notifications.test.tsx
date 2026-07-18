import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import TopBar from './TopBar'

function renderTopBar() {
  window.localStorage.setItem('user', JSON.stringify({
    realName: '测试用户',
    username: 'tester',
    role: 'admin',
  }))

  return render(
    <MemoryRouter initialEntries={['/']}>
      <TopBar />
    </MemoryRouter>,
  )
}

function getNotificationButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector('svg.lucide-bell')?.closest('button')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('notification button not found')
  }
  return button
}

describe('TopBar notification truth contract', () => {
  it('has no unread badge or invented events when no notification source is connected', () => {
    const { container } = renderTopBar()
    const button = getNotificationButton(container)

    button.focus()
    expect(button).toHaveFocus()
    expect(button).toHaveAccessibleName('通知消息，数据源未接入')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveAttribute('aria-controls', 'topbar-notification-panel')
    expect(button.children).toHaveLength(1)

    fireEvent.click(button)

    const dialog = screen.getByRole('dialog', { name: '通知消息' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(dialog.textContent?.replace(/\s+/g, '')).toBe(
      '通知消息通知数据源未接入当前没有可用于通知角标的已验证数据。前往预警中心',
    )
    expect(within(dialog).getByRole('link', { name: '前往预警中心' })).toHaveAttribute('href', '/alerts')
    expect(dialog).not.toHaveTextContent(/分钟前|小时前|库存不足|入库提醒|系统维护/)
  })

  it('keeps the notification disclosure closable by an outside click', () => {
    const { container } = renderTopBar()
    const button = getNotificationButton(container)

    fireEvent.click(button)
    expect(screen.getByRole('dialog', { name: '通知消息' })).toBeInTheDocument()

    fireEvent.mouseDown(document.body)

    expect(screen.queryByRole('dialog', { name: '通知消息' })).toBeNull()
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })

  it('moves focus into the dialog and returns it to the trigger on Escape', () => {
    const { container } = renderTopBar()
    const button = getNotificationButton(container)

    fireEvent.click(button)
    const dialog = screen.getByRole('dialog', { name: '通知消息' })
    expect(dialog).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })

    expect(screen.queryByRole('dialog', { name: '通知消息' })).toBeNull()
    expect(button).toHaveFocus()
    expect(button).toHaveAttribute('aria-expanded', 'false')
  })
})
