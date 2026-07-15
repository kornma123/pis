'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const mockupDir = __dirname
const repoRoot = path.resolve(mockupDir, '..', '..', '..')
const frontendDir = path.join(repoRoot, '前端代码')
const indexPath = path.join(mockupDir, 'index.html')
const baselinePath = path.join(repoRoot, 'docs', 'mockups', 'hospital-cm-readiness-closure', 'index.html')

assert.ok(
  fs.existsSync(indexPath),
  '[RED] 缺少 docs/mockups/hospital-cm-month-delta/index.html；月份选择器与四帧尚未实现。',
)
assert.ok(fs.existsSync(baselinePath), '已批准 hospital-cm mockup 基线不存在。')

const html = fs.readFileSync(indexPath, 'utf8')
assert.match(html, /id=["']month-select["'][^>]*type=["']month["']|type=["']month["'][^>]*id=["']month-select["']/, '[RED] 缺少原生月份选择器 #month-select[type=month]。')
assert.match(html, /data-testid=["']draft-banner["']/, '缺少全页 DRAFT 声明。')
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
  assert.equal(await page.locator('#state-root').getAttribute('data-current-frame'), 'F0', '首次渲染必须直接进入 F0。')
  assert.equal(await page.locator('#month-select').inputValue(), '', '首次渲染月份输入必须为空。')
  assert.equal(await page.locator('[data-testid="full-physical-exam"]').count(), 0, '首次渲染完整体检 DOM 必须为 0。')
}

async function assertTextContrast(page, selector, label) {
  const colors = await page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element)
    return { foreground: style.color, background: style.backgroundColor }
  })
  const ratio = contrastRatio(colors.foreground, colors.background)
  assert.ok(ratio >= 4.5, `${label} 对比度 ${ratio.toFixed(2)}:1，低于 WCAG AA 4.5:1。`)
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
    assert.ok(m1EvidenceCount > 0, 'F1 缺少结构化 M1 示例证据。')
  } else {
    assert.doesNotMatch(bodyText, /DEMO-M1-READY/, `${frame} 仍显示 DEMO-M1-READY。`)
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

  await page.locator('body').click({ position: { x: 2, y: 2 } })
  let reachedMonthInput = false
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab')
    if (await page.evaluate(() => document.activeElement?.id === 'month-select')) {
      reachedMonthInput = true
      break
    }
  }
  assert.ok(reachedMonthInput, '键盘 Tab 无法到达月份输入。')
  const focusShadow = await page.locator('#month-select').evaluate((element) => getComputedStyle(element).boxShadow)
  assert.notEqual(focusShadow, 'none', '月份输入缺少可见 focus ring。')
  const focusOutline = await page.locator('#month-select').evaluate((element) => {
    const style = getComputedStyle(element)
    return { style: style.outlineStyle, width: style.outlineWidth }
  })
  assert.notEqual(focusOutline.style, 'none', '月份输入焦点不得只依赖 box-shadow。')
  assert.ok(Number.parseFloat(focusOutline.width) >= 2, '月份输入焦点 outline 宽度不足 2px。')

  const touchTargets = page.locator('.scenario-button, #month-select')
  for (let i = 0; i < await touchTargets.count(); i += 1) {
    const box = await touchTargets.nth(i).boundingBox()
    assert.ok(box && box.height >= 44, `第 ${i + 1} 个交互目标高度不足 44px。`)
  }

  await page.locator('#month-select').fill('2026-10')
  await page.locator('#month-select').dispatchEvent('change')
  await assertFrame(page, 'F1')
  await page.locator('#month-select').fill('2026-11')
  await page.locator('#month-select').dispatchEvent('change')
  await assertFrame(page, 'F3')
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
  await page.locator('#month-select').focus()
  const outline = await page.locator('#month-select').evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      color: style.outlineColor,
      style: style.outlineStyle,
      width: style.outlineWidth,
    }
  })
  assert.notEqual(outline.style, 'none', 'forced-colors 下月份输入缺少系统 outline。')
  assert.ok(Number.parseFloat(outline.width) >= 2, 'forced-colors 下系统 outline 宽度不足 2px。')
  assert.doesNotMatch(outline.color, /rgba\(0, 0, 0, 0\)|transparent/i, 'forced-colors 下系统 outline 不可见。')
  assertDiagnostics(diagnostics, 'forced-colors')
  await page.close()
}

async function assertNoHorizontalOverflow(page, width) {
  const sizes = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  assert.ok(sizes.scrollWidth <= sizes.clientWidth, `${width}px 出现页面级横向滚动：${JSON.stringify(sizes)}`)
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
      for (const frame of Object.keys(expectedFullCounts)) await selectFrame(page, frame)
      if (viewport.width === 1280) await assertKeyboardAndAria(page)
      await assertNoHorizontalOverflow(page, viewport.width)
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
