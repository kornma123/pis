'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const mockupDir = __dirname
const repoRoot = path.resolve(mockupDir, '..', '..', '..')
const frontendDir = path.join(repoRoot, '前端代码')
const indexPath = path.join(mockupDir, 'index.html')
const readmePath = path.join(mockupDir, 'README.md')
const baselinePath = path.join(repoRoot, 'docs', 'mockups', 'hospital-cm-readiness-closure', 'index.html')

assert.ok(
  fs.existsSync(indexPath),
  '[RED] 缺少 docs/mockups/hospital-cm-month-delta/index.html；月份选择器与四帧尚未实现。',
)
assert.ok(fs.existsSync(baselinePath), '已批准 hospital-cm mockup 基线不存在。')

const html = fs.readFileSync(indexPath, 'utf8')
const readme = fs.readFileSync(readmePath, 'utf8')
assert.match(html, /id=["']month-select["'][^>]*type=["']month["']|type=["']month["'][^>]*id=["']month-select["']/, '[RED] 缺少原生月份选择器 #month-select[type=month]。')
assert.match(html, /data-testid=["']approval-banner["']/, '缺少全页 E0 APPROVED 声明。')
const approvalArtifacts = [
  ['页面', html, /本批准不是 readiness、golden、业务验收或生产解锁证据/],
  ['README', readme, /本批准只冻结四项月份 delta 交互合同[\s\S]*不替代 readiness、golden、业务验收或生产解锁证据/],
]
for (const [artifact, content, boundaryPattern] of approvalArtifacts) {
  assert.match(content, /E0 APPROVED/, `${artifact} 未明确标记 E0 APPROVED。`)
  assert.match(content, /PM 已批准的四项 E0 交互合同/, `${artifact} 未列明 PM 已批准的四项 E0 交互合同。`)
  assert.match(content, /不授权启动 E1/, `${artifact} 未声明 E0 批准不授权启动 E1。`)
  assert.match(content, boundaryPattern, `${artifact} 未以明确否定语义声明批准边界。`)
  assert.doesNotMatch(content, /DRAFT|请 PM|PM 只需判断/, `${artifact} 仍残留待决状态文案。`)
}
assert.match(html, /data-frame-target=["']F0["']/, '缺少 F0 演示控制。')
assert.match(html, /data-frame-target=["']F1["']/, '缺少 F1 演示控制。')
assert.match(html, /data-frame-target=["']F2["']/, '缺少 F2 演示控制。')
assert.match(html, /data-frame-target=["']F3["']/, '缺少 F3 演示控制。')
assert.match(html, /prefers-reduced-motion\s*:\s*reduce/, '缺少 prefers-reduced-motion 降级。')
assert.match(html, /forced-colors\s*:\s*active/, '缺少 forced-colors 系统焦点样式。')
assert.doesNotMatch(html, /\bfetch\s*\(|XMLHttpRequest|<script[^>]+src\s*=|<link[^>]+href\s*=|https?:\/\//i, '原型必须自包含，不能加载外链或调用网络。')

const dependencyRoots = [frontendDir]
if (process.env.COREONE_FRONTEND_NODE_MODULES) {
  const configuredRoot = path.resolve(process.env.COREONE_FRONTEND_NODE_MODULES)
  dependencyRoots.push(path.basename(configuredRoot).toLowerCase() === 'node_modules' ? path.dirname(configuredRoot) : configuredRoot)
}

let playwrightEntry
let playwright
const dependencyErrors = []
for (const dependencyRoot of [...new Set(dependencyRoots)]) {
  try {
    playwrightEntry = require.resolve('playwright', { paths: [dependencyRoot] })
    playwright = require(playwrightEntry)
    break
  } catch (error) {
    dependencyErrors.push(`${dependencyRoot}: ${error.code || error.name} ${error.message}`)
    playwrightEntry = undefined
    playwright = undefined
  }
}
assert.ok(
  playwrightEntry && playwright,
  `无法从前端依赖根加载 playwright：${dependencyRoots.join(', ')}。请先恢复当前 worktree 依赖，或用 COREONE_FRONTEND_NODE_MODULES 指向外部前端 node_modules。尝试结果：${dependencyErrors.join(' | ')}`,
)
const { chromium } = playwright

const fileUrl = pathToFileURL(indexPath).href
const expectedFullCounts = { F0: 0, F1: 1, F2: 0, F3: 0 }
const frameContracts = {
  F0: { month: '', readiness: 'not-checked', pool: 'not-checked', fullBoundary: 'locked' },
  F1: { month: '2026-10', readiness: 'ready', pool: 'ratified', fullBoundary: 'ready' },
  F2: { month: '2026-11', readiness: 'checking', pool: 'checking', fullBoundary: 'checking' },
  F3: { month: '2026-11', readiness: 'not-ready', pool: 'unratified', fullBoundary: 'locked' },
}

function parseCssColor(value) {
  const match = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i)
  assert.ok(match, `无法解析 CSS 颜色：${value}`)
  return {
    red: Number(match[1]),
    green: Number(match[2]),
    blue: Number(match[3]),
    alpha: match[4] === undefined ? 1 : Number(match[4]),
  }
}

function relativeLuminance(color) {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(foregroundValue, backgroundValue) {
  const foreground = parseCssColor(foregroundValue)
  const background = parseCssColor(backgroundValue)
  assert.equal(background.alpha, 1, `对比度背景必须不透明：${backgroundValue}`)
  const composited = foreground.alpha === 1
    ? foreground
    : {
        red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
        green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
        blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
        alpha: 1,
      }
  const lighter = Math.max(relativeLuminance(composited), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(composited), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function isOutsideRepo(targetPath) {
  const relative = path.relative(repoRoot, targetPath)
  return relative.startsWith('..') || path.isAbsolute(relative)
}

function attachDiagnostics(page) {
  const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], externalRequests: [] }
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message))
  page.on('requestfailed', (request) => diagnostics.failedRequests.push(`${request.method()} ${request.url()}`))
  page.on('request', (request) => {
    if (!request.url().startsWith('file:')) diagnostics.externalRequests.push(request.url())
  })
  return diagnostics
}

async function selectFrame(page, frame) {
  await page.locator(`[data-frame-target="${frame}"]`).click()
  await assertFrame(page, frame)
}

async function assertInitialState(page) {
  await assertFrame(page, 'F0')
}

async function assertTextContrast(page, selector, label) {
  const colors = await page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element)
    return { foreground: style.color, background: style.backgroundColor }
  })
  const ratio = contrastRatio(colors.foreground, colors.background)
  assert.ok(ratio >= 4.5, `${label} 对比度 ${ratio.toFixed(2)}:1，低于 WCAG AA 4.5:1。`)
}

async function assertControlBoundaryContrast(page, selector, label) {
  const colors = await page.locator(selector).first().evaluate((element) => {
    let ancestor = element.parentElement
    let adjacent = 'rgb(255, 255, 255)'
    while (ancestor) {
      const candidate = getComputedStyle(ancestor).backgroundColor
      if (!/^rgba\(0, 0, 0, 0\)$|^transparent$/i.test(candidate)) {
        adjacent = candidate
        break
      }
      ancestor = ancestor.parentElement
    }
    return {
      boundary: getComputedStyle(element).borderTopColor,
      adjacent,
    }
  })
  const ratio = contrastRatio(colors.boundary, colors.adjacent)
  assert.ok(ratio >= 3, `${label} 边界对比度 ${ratio.toFixed(2)}:1，低于 WCAG 2.2 AA 3:1。`)
}

async function assertControlBoundaryContrasts(page) {
  await page.waitForTimeout(20)
  await assertControlBoundaryContrast(page, '.scenario-button[aria-pressed="false"]', '未按下演示按钮')
  await assertControlBoundaryContrast(page, '.scenario-button[aria-pressed="true"]', '当前帧演示按钮')
  await assertControlBoundaryContrast(page, '#month-select', '月份输入')
}

async function captureM1NodeHandles(page) {
  const handles = {}
  try {
    handles.fullExam = await page.locator('[data-testid="full-physical-exam"]').elementHandle()
    handles.evidence = await page.locator('[data-evidence-month="M1"]').elementHandle()
    handles.readiness = await page.locator('[data-testid="readiness-status"]').elementHandle()
    handles.pool = await page.locator('[data-testid="fixed-pool-status"]').elementHandle()
    for (const [label, handle] of Object.entries(handles)) {
      assert.ok(handle, `F1 缺少待跟踪的旧 M1 ${label} 节点。`)
    }
    return handles
  } catch (error) {
    await disposeNodeHandles(handles)
    throw error
  }
}

async function disposeNodeHandles(handles) {
  await Promise.allSettled(Object.values(handles).filter(Boolean).map((handle) => handle.dispose()))
}

async function assertM1NodeHandlesDisconnected(handles, transitionLabel) {
  for (const [label, handle] of Object.entries(handles)) {
    assert.equal(
      await handle.evaluate((node) => node.isConnected),
      false,
      `${transitionLabel} 后旧 M1 ${label} 节点仍连接在 DOM。`,
    )
  }
}

async function assertDemoSwitchDisconnectsM1(page) {
  await selectFrame(page, 'F1')
  const oldM1Nodes = await captureM1NodeHandles(page)
  try {
    await page.locator('[data-frame-target="F2"]').click()
    await assertFrame(page, 'F2')
    await assertM1NodeHandlesDisconnected(oldM1Nodes, 'F1→F2')
  } finally {
    await disposeNodeHandles(oldM1Nodes)
  }
}

async function assertFrame(page, frame) {
  const stateRoot = page.locator('#state-root')
  await stateRoot.waitFor()
  assert.equal(await stateRoot.getAttribute('data-current-frame'), frame, `${frame} 未成为当前帧。`)
  const contract = frameContracts[frame]

  for (const candidate of Object.keys(expectedFullCounts)) {
    const pressed = await page.locator(`[data-frame-target="${candidate}"]`).getAttribute('aria-pressed')
    assert.equal(pressed, String(candidate === frame), `${candidate} 的 aria-pressed 与当前帧不一致。`)
  }

  assert.equal(
    await page.locator('[data-testid="full-physical-exam"]').count(),
    expectedFullCounts[frame],
    `${frame} 的完整体检 DOM 数量错误。`,
  )

  const month = await page.locator('#month-select').inputValue()
  const readiness = page.locator('[data-testid="readiness-status"]')
  const pool = page.locator('[data-testid="fixed-pool-status"]')
  const fullBoundary = page.locator('[data-testid="full-boundary"]')
  assert.equal(await readiness.count(), 1, `${frame} 必须恰有一个 readiness 状态节点。`)
  assert.equal(await pool.count(), 1, `${frame} 必须恰有一个固定成本池状态节点。`)
  assert.equal(await fullBoundary.count(), 1, `${frame} 必须恰有一个完整体检边界节点。`)
  assert.equal(month, contract.month, `${frame} 的月份输入不符合合同。`)
  assert.equal(await readiness.getAttribute('data-status'), contract.readiness, `${frame} 的 readiness 状态不符合合同。`)
  assert.equal(await pool.getAttribute('data-status'), contract.pool, `${frame} 的固定成本池状态不符合合同。`)
  assert.equal(await fullBoundary.getAttribute('data-status'), contract.fullBoundary, `${frame} 的完整体检边界状态不符合合同。`)
  assert.equal(await readiness.getAttribute('data-service-month'), month, `${frame} readiness 月份与输入月份不一致。`)
  assert.equal(await pool.getAttribute('data-service-month'), month, `${frame} 固定成本池月份与输入月份不一致。`)
  assert.equal(await fullBoundary.getAttribute('data-service-month'), month, `${frame} 完整体检边界月份与输入月份不一致。`)

  if (frame === 'F1') {
    const fullExam = page.locator('[data-testid="full-physical-exam"]')
    assert.equal(await fullExam.getAttribute('data-status'), 'ready', 'F1 完整体检状态必须为 ready。')
    assert.equal(await fullExam.getAttribute('data-service-month'), month, 'F1 完整体检月份必须与输入月份一致。')
    assert.equal(await pool.getAttribute('data-status'), 'ratified', 'F1 固定成本池必须为 ratified。')
  }

  const bodyText = await page.locator('body').innerText()
  const m1EvidenceCount = await page.locator('[data-evidence-month="M1"]').count()
  if (frame === 'F1') {
    assert.match(bodyText, /DEMO-M1-READY/, 'F1 缺少 M1 示例证据标识。')
    assert.match(bodyText, /DEMO-M1-POOL-V3/, 'F1 缺少 M1 固定成本池示例证据标识。')
    assert.ok(m1EvidenceCount > 0, 'F1 缺少结构化 M1 示例证据。')
  } else {
    assert.doesNotMatch(bodyText, /DEMO-M1-READY/, `${frame} 仍显示 DEMO-M1-READY。`)
    assert.doesNotMatch(bodyText, /DEMO-M1-POOL-V3/, `${frame} 仍显示 DEMO-M1-POOL-V3。`)
    assert.equal(m1EvidenceCount, 0, `${frame} 仍保留 M1 证据节点。`)
  }

  const isBusy = await page.locator('#month-context').getAttribute('aria-busy')
  assert.equal(isBusy, String(frame === 'F2'), `${frame} 的 aria-busy 不正确。`)

  if (frame === 'F2') {
    await page.waitForTimeout(150)
    assert.equal(await stateRoot.getAttribute('data-current-frame'), 'F2', 'F2 不能停帧审阅。')
  }
}

async function assertKeyboardAndAria(page) {
  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN', '页面语言必须为 zh-CN。')
  assert.equal(await page.locator('h1').count(), 1, '页面必须只有一个 h1。')
  await assert.doesNotReject(() => page.getByLabel('查看月份').waitFor(), '月份输入缺少可见 label。')
  assert.equal(await page.locator('#month-select').getAttribute('type'), 'month', '月份输入必须使用原生 type=month。')
  assert.equal(await page.locator('#state-announcement').getAttribute('role'), 'status', '状态播报缺少 role=status。')
  assert.equal(await page.locator('#state-announcement').getAttribute('aria-live'), 'polite', '状态播报缺少 aria-live=polite。')
  assert.ok(await page.locator('nav[aria-label="月份 delta 演示控制"]').count(), '演示控制缺少可访问名称。')

  const assertVisibleFocus = async (control, label) => {
    const focusStyle = await control.evaluate((element) => {
      const style = getComputedStyle(element)
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, boxShadow: style.boxShadow }
    })
    assert.notEqual(focusStyle.outlineStyle, 'none', `${label} 缺少 outline。`)
    assert.ok(Number.parseFloat(focusStyle.outlineWidth) >= 2, `${label} outline 宽度不足 2px。`)
    assert.notEqual(focusStyle.boxShadow, 'none', `${label} 缺少 focus ring。`)
  }

  await page.locator('body').click({ position: { x: 2, y: 2 } })
  const scenarioButtons = page.locator('.scenario-button')
  for (let i = 0; i < await scenarioButtons.count(); i += 1) {
    await page.keyboard.press('Tab')
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-frame-target')),
      `F${i}`,
      `Tab 顺序未到达 F${i} 演示按钮。`,
    )
    await assertVisibleFocus(scenarioButtons.nth(i), `F${i} 演示按钮`)
  }

  let reachedMonthInput = false
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab')
    if (await page.evaluate(() => document.activeElement?.id === 'month-select')) {
      reachedMonthInput = true
      break
    }
  }
  assert.ok(reachedMonthInput, '键盘 Tab 无法到达月份输入。')
  await assertVisibleFocus(page.locator('#month-select'), '月份输入')

  let reachedBaselineLink = false
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab')
    if (await page.evaluate(() => document.activeElement?.classList.contains('baseline-link'))) {
      reachedBaselineLink = true
      break
    }
  }
  assert.ok(reachedBaselineLink, '键盘 Tab 无法离开月份输入并到达基线链接。')
  await assertVisibleFocus(page.locator('.baseline-link'), '基线链接')

  await page.locator('[data-frame-target="F1"]').focus()
  await page.keyboard.press('Enter')
  await assertFrame(page, 'F1')
  await page.locator('[data-frame-target="F2"]').focus()
  await page.keyboard.press('Space')
  await assertFrame(page, 'F2')

  const touchTargets = page.locator('.scenario-button, #month-select')
  for (let i = 0; i < await touchTargets.count(); i += 1) {
    const box = await touchTargets.nth(i).boundingBox()
    assert.ok(box && box.height >= 44, `第 ${i + 1} 个交互目标高度不足 44px。`)
  }

  await page.locator('#month-select').fill('2026-10')
  await page.locator('#month-select').dispatchEvent('change')
  await assertFrame(page, 'F1')
  const oldM1Nodes = await captureM1NodeHandles(page)
  try {
    await page.locator('#month-select').fill('2026-11')
    await page.locator('#month-select').dispatchEvent('change')
    await assertFrame(page, 'F3')
    await assertM1NodeHandlesDisconnected(oldM1Nodes, '原生月份输入 F1→F3')
  } finally {
    await disposeNodeHandles(oldM1Nodes)
  }
  await page.locator('#month-select').fill('')
  await page.locator('#month-select').dispatchEvent('change')
  await assertFrame(page, 'F0')
}

async function assertForcedColorsFocus(browser) {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    forcedColors: 'active',
  })
  const diagnostics = attachDiagnostics(page)
  await page.goto(fileUrl, { waitUntil: 'load' })
  await assertInitialState(page)
  const controls = page.locator('.scenario-button, #month-select, .baseline-link')
  for (let i = 0; i < await controls.count(); i += 1) {
    const control = controls.nth(i)
    await control.focus()
    const outline = await control.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        color: style.outlineColor,
        style: style.outlineStyle,
        width: style.outlineWidth,
      }
    })
    assert.notEqual(outline.style, 'none', `forced-colors 下第 ${i + 1} 个交互控件缺少系统 outline。`)
    assert.ok(Number.parseFloat(outline.width) >= 2, `forced-colors 下第 ${i + 1} 个交互控件 outline 宽度不足 2px。`)
    assert.doesNotMatch(outline.color, /rgba\(0, 0, 0, 0\)|transparent/i, `forced-colors 下第 ${i + 1} 个交互控件 outline 不可见。`)
  }
  assertDiagnostics(diagnostics, 'forced-colors')
  await page.close()
}

async function assertNoHorizontalOverflow(page, label) {
  const sizes = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    outside: Array.from(document.body.querySelectorAll('*'))
      .filter((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      })
      .filter((element) => {
        const rect = element.getBoundingClientRect()
        return rect.left < -0.5 || rect.right > document.documentElement.clientWidth + 0.5
      })
      .slice(0, 5)
      .map((element) => ({ tag: element.tagName, id: element.id, className: element.className })),
  }))
  assert.ok(sizes.scrollWidth <= sizes.clientWidth, `${label} 出现页面级横向滚动：${JSON.stringify(sizes)}`)
  assert.ok(sizes.bodyScrollWidth <= sizes.clientWidth, `${label} body 出现横向滚动：${JSON.stringify(sizes)}`)
  assert.deepEqual(sizes.outside, [], `${label} 存在被 overflow-x 隐藏的越界元素：${JSON.stringify(sizes.outside)}`)
}

function assertDiagnostics(diagnostics, label) {
  assert.deepEqual(diagnostics.consoleErrors, [], `${label} 存在 console error。`)
  assert.deepEqual(diagnostics.pageErrors, [], `${label} 存在 pageerror。`)
  assert.deepEqual(diagnostics.failedRequests, [], `${label} 存在 requestfailed。`)
  assert.deepEqual(diagnostics.externalRequests, [], `${label} 发起了仓库外请求。`)
}

async function takeOptionalScreenshots(browser) {
  if (!process.env.MOCKUP_SCREENSHOT_DIR) return
  const screenshotDir = path.resolve(process.env.MOCKUP_SCREENSHOT_DIR)
  assert.ok(isOutsideRepo(screenshotDir), 'MOCKUP_SCREENSHOT_DIR 必须位于仓库外。')
  fs.mkdirSync(screenshotDir, { recursive: true })

  for (const [label, viewport] of [
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 375, height: 812 }],
  ]) {
    const page = await browser.newPage({ viewport })
    await page.goto(fileUrl, { waitUntil: 'load' })
    for (const frame of Object.keys(expectedFullCounts)) {
      await selectFrame(page, frame)
      await page.screenshot({
        path: path.join(screenshotDir, `${frame}-${label}.png`),
        fullPage: true,
      })
    }
    await page.close()
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  try {
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 768, height: 900 },
      { width: 1280, height: 900 },
    ]) {
      const page = await browser.newPage({ viewport })
      const diagnostics = attachDiagnostics(page)
      await page.goto(fileUrl, { waitUntil: 'load' })
      await assertInitialState(page)
      await assertTextContrast(page, '.month-rule', '月份规则说明')
      await assertTextContrast(page, '.badge.gray', '灰色状态徽章')
      await assertControlBoundaryContrasts(page)
      for (const frame of Object.keys(expectedFullCounts)) {
        await selectFrame(page, frame)
        await assertNoHorizontalOverflow(page, `${viewport.width}px ${frame}`)
      }
      await assertDemoSwitchDisconnectsM1(page)
      if (viewport.width === 1280) await assertKeyboardAndAria(page)
      assertDiagnostics(diagnostics, `${viewport.width}px`)
      await page.close()
    }
    await assertForcedColorsFocus(browser)
    await takeOptionalScreenshots(browser)
  } finally {
    await browser.close()
  }

  console.log('[PASS] #185 E0 month delta mockup: F0-F3, DOM/stale-state, keyboard/ARIA, diagnostics, and responsive checks passed.')
}

main().catch((error) => {
  console.error(`[FAIL] ${error.stack || error.message}`)
  process.exitCode = 1
})
