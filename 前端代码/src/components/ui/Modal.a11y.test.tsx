import React, { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from './Modal'

function StatefulModal() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开编辑窗口</button>
      {open && (
        <Modal title="编辑资料" description="修改后保存资料。" onClose={() => setOpen(false)}>
          <button type="button">保存资料</button>
        </Modal>
      )}
    </>
  )
}

function AutoFocusModal() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>打开姓名窗口</button>
      {open && (
        <Modal title="编辑姓名" onClose={() => setOpen(false)}>
          <input autoFocus aria-label="姓名" />
        </Modal>
      )}
    </>
  )
}

function RerenderingModal() {
  const [version, setVersion] = useState(0)

  return (
    <Modal title="重渲染测试" onClose={() => undefined}>
      <input aria-label="保持焦点" />
      <button type="button" onClick={() => setVersion((current) => current + 1)}>
        更新 {version}
      </button>
    </Modal>
  )
}

function StackedModals() {
  const [layers, setLayers] = useState(0)

  return (
    <>
      <button type="button" onClick={() => setLayers(2)}>打开堆叠窗口</button>
      {layers >= 1 && (
        <Modal title="底层窗口" onClose={() => setLayers(0)}>
          <button type="button">底层操作</button>
        </Modal>
      )}
      {layers >= 2 && (
        <Modal title="顶层窗口" onClose={() => setLayers(1)}>
          <button type="button">顶层操作</button>
        </Modal>
      )}
    </>
  )
}

describe('Modal accessibility contract', () => {
  it('moves initial focus into the dialog and gives the close button a name', () => {
    render(<StatefulModal />)
    const opener = screen.getByRole('button', { name: '打开编辑窗口' })

    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: '编辑资料' })
    const close = within(dialog).getByRole('button', { name: '关闭编辑资料' })
    expect(close).toHaveClass('a11y-focus-ring')
    expect(close).toHaveFocus()
  })

  it('traps Tab and Shift+Tab on the visible enabled controls', () => {
    render(
      <Modal title="键盘测试" onClose={vi.fn()}>
        <button type="button">保存</button>
        <button type="button" style={{ display: 'none' }}>隐藏操作</button>
        <button type="button" disabled>禁用操作</button>
        <fieldset disabled><button type="button">字段组禁用操作</button></fieldset>
        <div aria-hidden="true"><button type="button">读屏隐藏操作</button></div>
        <button type="button" tabIndex={-1}>跳过操作</button>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: '键盘测试' })
    const close = within(dialog).getByRole('button', { name: '关闭键盘测试' })
    const save = within(dialog).getByRole('button', { name: '保存' })

    save.focus()
    fireEvent.keyDown(save, { key: 'Tab' })
    expect(close).toHaveFocus()

    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(save).toHaveFocus()
  })

  it('preserves a child autoFocus target and still restores the true opener', () => {
    render(<AutoFocusModal />)
    const opener = screen.getByRole('button', { name: '打开姓名窗口' })

    opener.focus()
    fireEvent.click(opener)
    const input = screen.getByRole('textbox', { name: '姓名' })
    expect(input).toHaveFocus()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(opener).toHaveFocus()
  })

  it('does not reset focus when an inline onClose callback changes identity', () => {
    render(<RerenderingModal />)
    const input = screen.getByRole('textbox', { name: '保持焦点' })

    input.focus()
    fireEvent.click(screen.getByRole('button', { name: '更新 0' }))

    expect(screen.getByRole('button', { name: '更新 1' })).toBeInTheDocument()
    expect(input).toHaveFocus()
  })

  it('closes on Escape and restores focus to the opener', () => {
    render(<StatefulModal />)
    const opener = screen.getByRole('button', { name: '打开编辑窗口' })

    opener.focus()
    fireEvent.click(opener)
    screen.getByRole('button', { name: '保存资料' }).focus()
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('returns focus to the remaining dialog before restoring the background opener', () => {
    render(<StackedModals />)
    const opener = screen.getByRole('button', { name: '打开堆叠窗口' })

    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByRole('button', { name: '关闭顶层窗口' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '顶层窗口' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭底层窗口' })).toHaveFocus()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('uses unique visible title and description associations for every instance', () => {
    render(
      <>
        <Modal title="第一窗口" description="第一段说明" onClose={vi.fn()}>
          <span>第一段内容</span>
        </Modal>
        <Modal title="第二窗口" description="第二段说明" onClose={vi.fn()}>
          <span>第二段内容</span>
        </Modal>
      </>,
    )

    const first = screen.getByRole('dialog', { name: '第一窗口' })
    const second = screen.getByRole('dialog', { name: '第二窗口' })
    const firstTitleId = first.getAttribute('aria-labelledby')
    const secondTitleId = second.getAttribute('aria-labelledby')
    const firstDescriptionId = first.getAttribute('aria-describedby')
    const secondDescriptionId = second.getAttribute('aria-describedby')

    expect(first).toHaveAccessibleDescription('第一段说明')
    expect(second).toHaveAccessibleDescription('第二段说明')
    expect(firstTitleId).toBeTruthy()
    expect(secondTitleId).toBeTruthy()
    expect(firstDescriptionId).toBeTruthy()
    expect(secondDescriptionId).toBeTruthy()
    expect(firstTitleId).not.toBe(secondTitleId)
    expect(firstDescriptionId).not.toBe(secondDescriptionId)
    expect(document.getElementById(firstTitleId!)).toHaveTextContent('第一窗口')
    expect(document.getElementById(secondTitleId!)).toHaveTextContent('第二窗口')
  })

  it('keeps the panel within a narrow reflow viewport contract', () => {
    render(<Modal title="窄屏窗口" onClose={vi.fn()}>正文</Modal>)

    expect(screen.getByRole('dialog', { name: '窄屏窗口' })).toHaveClass(
      'w-[calc(100%-2rem)]',
      'min-w-0',
    )
  })

  it('does not emit a dangling description reference when none is supplied', () => {
    render(<Modal title="无描述窗口" onClose={vi.fn()}>正文</Modal>)

    expect(screen.getByRole('dialog', { name: '无描述窗口' })).not.toHaveAttribute('aria-describedby')
  })

  it('keeps focus on the dialog when no tabbable control remains', () => {
    render(<Modal title="无控件窗口" onClose={vi.fn()}>纯文本</Modal>)
    const dialog = screen.getByRole('dialog', { name: '无控件窗口' })
    const close = within(dialog).getByRole('button', { name: '关闭无控件窗口' })

    close.hidden = true
    dialog.focus()
    fireEvent.keyDown(dialog, { key: 'Tab' })

    expect(dialog).toHaveFocus()
    expect(dialog).toHaveAttribute('tabindex', '-1')
  })
})
