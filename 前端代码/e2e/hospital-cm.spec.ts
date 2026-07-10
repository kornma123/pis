/**
 * 院级贡献毛利看板 · 两层框架红线 E2E（DEC-7 + 公理二 · 专家终裁 §六.6）。
 *
 * 真浏览器 + 真后端端到端守住两条红线（两层都要）：
 *   ① **数据层**：就绪谓词为假 ⇒ `/full-health` 后端 **403 + 降级载荷**（完整数值绝不出门·防绕页直打 API）。
 *   ② **DOM 层**：就绪谓词为假 ⇒ 完整体检态组件**不在 DOM**（非隐藏）；无 URL 参数能强制唤出。
 * 附：旧 /hospital-pnl 深链重定向到 /hospital-cm（退役旧视图·不留死链）+ 校准态诚实元素在场。
 *
 * 现实（签入 dev DB 三件套表空 → ready=false）→ 本 spec 走校准态·确定性。
 * ⚠️ 非 PR 门 required spec（e2e.yml 只跑 auth+supplier-returns）；纳入夜间全量回归网 + 本地保绿。
 */
import { test, expect, Page } from '@playwright/test'

const FE_BASE = 'http://localhost:8080'
const API_BASE = 'http://localhost:3001/api/v1'

async function loginAdmin(page: Page) {
  await page.goto(`${FE_BASE}/login`)
  await page.waitForTimeout(100)
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear() })
  await page.goto(`${FE_BASE}/login`)
  await page.fill('input[type="text"]', 'admin')
  await page.fill('input[type="password"]', 'admin123')
  await page.click('button[type="submit"]')
  await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
}

test.describe('院级贡献毛利看板 · 两层框架红线', () => {
  test('校准态渲染 + 🔒DOM 红线：谓词假 ⇒ 完整体检态组件不在 DOM', async ({ page }) => {
    await loginAdmin(page)
    await page.goto(`${FE_BASE}/hospital-cm`)
    // 校准态内容在场（第 1 层趋势-only 体检 + 校准就绪清单 + 未认账水印）
    await expect(page.getByTestId('calibration-view')).toBeVisible()
    await expect(page.getByTestId('portfolio-hero')).toBeVisible()
    await expect(page.getByTestId('split-caliber-watermark')).toBeVisible()
    // ⑥ 固定池未配置 → "未配置" 而非 0
    await expect(page.getByTestId('coverage-not-configured')).toContainText('未配置')
    // ⑦ 就绪清单四条
    for (const k of ['foundation', 'denominator', 'history', 'first_period']) {
      await expect(page.getByTestId(`readiness-condition-${k}`)).toBeVisible()
    }
    // 🔒 DOM 红线：完整体检态组件**不在 DOM**（非隐藏）
    await expect(page.getByTestId('full-physical-exam')).toHaveCount(0)
  })

  test('🔒数据层红线：谓词假 ⇒ /full-health 403（无完整数据泄漏）；/readiness 200 ready=false', async ({ page }) => {
    await loginAdmin(page)
    const result = await page.evaluate(async (apiBase) => {
      const token = localStorage.getItem('token')
      const h = { Authorization: `Bearer ${token}` } as Record<string, string>
      const full = await fetch(`${apiBase}/hospital-pnl/full-health`, { headers: h })
      const fullBody = await full.text()
      const rd = await fetch(`${apiBase}/hospital-pnl/readiness`, { headers: h })
      const rdJson = await rd.json()
      return { fullStatus: full.status, fullBody, ready: rdJson?.data?.ready, checklistLen: rdJson?.data?.checklist?.length }
    }, API_BASE)
    // 完整态数据端点 403（URL 后门焊到数据层）
    expect(result.fullStatus).toBe(403)
    expect(result.fullBody).toContain('READINESS_NOT_MET')
    // 降级载荷**不含**任何完整体检数值
    expect(result.fullBody).not.toContain('"totalCm"')
    expect(result.fullBody).not.toContain('"coverageMultiple"')
    // 就绪谓词诚实=false·四条清单
    expect(result.ready).toBe(false)
    expect(result.checklistLen).toBe(4)
  })

  test('🔒URL 后门：?mode=full 之类深链不能强制唤出完整体检态', async ({ page }) => {
    await loginAdmin(page)
    await page.goto(`${FE_BASE}/hospital-cm?mode=full`)
    await expect(page.getByTestId('calibration-view')).toBeVisible()
    await expect(page.getByTestId('full-physical-exam')).toHaveCount(0)
  })

  test('旧 /hospital-pnl 深链重定向到 /hospital-cm（退役旧视图·不留死链）', async ({ page }) => {
    await loginAdmin(page)
    await page.goto(`${FE_BASE}/hospital-pnl`)
    await expect(page).toHaveURL(/\/hospital-cm/)
    await expect(page.getByRole('heading', { name: '院级贡献毛利看板' })).toBeVisible()
  })
})
