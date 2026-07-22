import { expect, test } from '@playwright/test'
import { apiGet, apiLogin, loginThroughUi } from './fixtures'

function apiBaseUrl(): string {
  const value = process.env.E2E_API_BASE_URL
  if (!value) throw new Error('E2E_API_BASE_URL must be provided by playwright.config.ts')
  return value.replace(/\/$/, '')
}

test.describe('critical LIS correction conflict contract', () => {
  test('real 409 wire codes drive stale and same-value guidance without optimistic updates', async ({ page, request }) => {
    const token = await apiLogin(request, 'admin')
    const suffix = `${Date.now()}-${test.info().retry}`
    const caseNo = `E2E-LIS-${suffix}`
    const partnerName = `E2E LIS 医院 ${suffix}`
    const originalTime = '2026-06-20'
    const concurrentTime = '2026-06-21'
    const attemptedTime = '2026-06-22'
    const headers = { Authorization: `Bearer ${token}` }

    const imported = await request.post(`${apiBaseUrl()}/lis-cases/import`, {
      headers,
      data: {
        cases: [{
          病理号: caseNo,
          送检医院: partnerName,
          登记时间: originalTime,
          蜡块数: 1,
          HE切片数: 1,
        }],
      },
    })
    expect(imported.status()).toBe(200)
    expect((await imported.json())?.data?.imported).toBe(1)

    const listed = await apiGet(request, token, `/lis-cases?keyword=${encodeURIComponent(caseNo)}`)
    expect(listed.status()).toBe(200)
    const record = (await listed.json())?.data?.list?.find((item: { caseNo?: string }) => item.caseNo === caseNo)
    expect(record?.partnerId).toEqual(expect.any(String))

    await loginThroughUi(page, 'admin')
    await page.goto('/lis-cases')
    await page.getByPlaceholder('搜病理号').fill(caseNo)
    await page.getByText(caseNo, { exact: true }).click()

    const baseInfo = page.getByRole('region', { name: '病例基础信息' })
    const operateTimeField = baseInfo.getByText('登记时间', { exact: true }).locator('xpath=..')
    await expect(operateTimeField.getByText(originalTime, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '更正登记时间' }).click()
    const form = page.getByRole('region', { name: '登记时间更正' })

    const concurrentCorrection = await request.post(`${apiBaseUrl()}/lis-cases/correction`, {
      headers,
      data: {
        partnerId: record.partnerId,
        caseNo,
        expectedOperateTime: originalTime,
        newOperateTime: concurrentTime,
        reason: 'E2E 并发更正',
        confirm: true,
      },
    })
    expect(concurrentCorrection.status()).toBe(200)

    await form.getByLabel('新登记时间').fill(attemptedTime)
    await form.getByLabel('更正原因').fill('E2E stale 冲突核对')
    await form.getByRole('checkbox').check()
    const staleResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/lis-cases/correction') && response.request().method() === 'POST',
    )
    await form.getByRole('button', { name: '提交更正' }).click()
    const staleResponse = await staleResponsePromise
    expect(staleResponse.status()).toBe(409)
    expect((await staleResponse.json())?.error?.code).toBe('STALE_EXPECTED')
    await expect(form.getByRole('alert')).toContainText('登记时间已被修改')
    await expect(operateTimeField.getByText(originalTime, { exact: true })).toBeVisible()

    await form.getByRole('button', { name: '重新加载' }).click()
    await expect(operateTimeField.getByText(concurrentTime, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '更正登记时间' }).click()
    const sameValueForm = page.getByRole('region', { name: '登记时间更正' })
    await sameValueForm.getByLabel('新登记时间').fill(concurrentTime)
    await sameValueForm.getByLabel('更正原因').fill('E2E same-value 冲突核对')
    await sameValueForm.getByRole('checkbox').check()
    const sameValueResponsePromise = page.waitForResponse((response) =>
      response.url().endsWith('/api/v1/lis-cases/correction') && response.request().method() === 'POST',
    )
    await sameValueForm.getByRole('button', { name: '提交更正' }).click()
    const sameValueResponse = await sameValueResponsePromise
    expect(sameValueResponse.status()).toBe(409)
    expect((await sameValueResponse.json())?.error?.code).toBe('SAME_VALUE')
    await expect(sameValueForm.getByRole('alert')).toContainText('无需更正')
    await expect(sameValueForm.getByRole('button', { name: '重新加载' })).toHaveCount(0)
    await expect(operateTimeField.getByText(concurrentTime, { exact: true })).toBeVisible()
  })
})
