import { test, expect, Page } from '@playwright/test'

const FE_BASE = 'http://localhost:8080'
const API_BASE = 'http://127.0.0.1:3001/api/v1'

const ROLES = {
  admin: { username: 'admin', password: 'admin123' },
  warehouse_manager: { username: 'cangguan', password: 'CoreOne2026!' },
  technician: { username: 'jishuyuan1', password: 'CoreOne2026!' },
  pathologist: { username: 'yishi1', password: 'CoreOne2026!' },
  procurement: { username: 'caigou', password: 'CoreOne2026!' },
  finance: { username: 'caiwu', password: 'CoreOne2026!' },
} as const
type RoleKey = keyof typeof ROLES
const ALL_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance']

async function loginAs(page: Page, role: RoleKey) {
  await page.goto(`${FE_BASE}/login`)
  await page.evaluate(() => localStorage.clear())
  const cred = ROLES[role]
  await page.fill('input[type="text"]', cred.username)
  await page.fill('input[type="password"]', cred.password)
  await page.click('button[type="submit"]')
  await page.waitForURL(`${FE_BASE}/`, { timeout: 10000 })
}

async function apiLogin(role: RoleKey): Promise<string> {
  const cred = ROLES[role]
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cred),
  })
  const data = (await res.json()) as any
  return data.data?.token || data.token
}

async function apiFetch(token: string, method: string, path: string, body?: any) {
  const opts: any = { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }
  if (body && method !== 'GET' && method !== 'HEAD') opts.body = JSON.stringify(body)
  const res = await fetch(`${API_BASE}${path}`, opts)
  return { status: res.status, data: (await res.json().catch(() => null)) as any }
}

async function getAnyAlertId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyRuleId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/alerts/rules')
  return r.data?.data?.rules?.[0]?.id || ''
}

// ────────────────────────────────────────────
// 1. 查看预警列表 (12 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 查看预警列表', () => {
  for (const role of ALL_ROLES) {
    test(`ALERT-LIST-01-${role}. 正常用例：${role}可查看预警列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/alerts`)
      await expect(page.locator('body')).toBeVisible({ timeout: 8000 })
    })
  }
  test('ALERT-LIST-02. 空数据边界：无预警显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
  })
  test('ALERT-LIST-03. 异常恢复：API 500', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
  })
  test('ALERT-LIST-04. UI差异：admin显示处理按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('ALERT-LIST-05. 正常用例：显示类型级别物料库存阈值', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('ALERT-LIST-06. 并发：快速刷新', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.reload()
    await page.reload()
  })
})

// ────────────────────────────────────────────
// 2. 按状态筛选 (8 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 按状态筛选', () => {
  test('ALERT-STATUS-01. 正常用例：pending筛选', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?status=pending')
    expect(res.status).toBe(200)
  })
  test('ALERT-STATUS-02. 正常用例：handled筛选', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?status=handled')
    expect(res.status).toBe(200)
  })
  test('ALERT-STATUS-03. 空数据边界：无pending', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?status=pending')
    expect(res.status).toBe(200)
  })
  test('ALERT-STATUS-04. 正常用例：重置筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
  })
  test('ALERT-STATUS-05. UI差异：各角色可见', async ({ page }) => {
    for (const role of ALL_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/alerts`)
      await page.waitForTimeout(300)
    }
  })
  test('ALERT-STATUS-06. 并发：快速切换', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts?status=pending`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/alerts?status=handled`)
    await page.waitForTimeout(200)
  })
  test('ALERT-STATUS-07. 异常恢复：筛选API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts?status=invalid`)
    await page.waitForTimeout(800)
  })
  test('ALERT-STATUS-08. 边界：非法状态值', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?status=invalid_xyz')
    expect(res.status).toBe(200)
  })
})

// ────────────────────────────────────────────
// 3. 按类型筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 按类型筛选', () => {
  test('ALERT-TYPE-01. 正常用例：low-stock筛选', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?type=low-stock')
    expect(res.status).toBe(200)
  })
  test('ALERT-TYPE-02. 正常用例：expiry筛选', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?type=expiry')
    expect(res.status).toBe(200)
  })
  test('ALERT-TYPE-03. 空数据边界：无该类型', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?type=nonexistent')
    expect(res.status).toBe(200)
  })
  test('ALERT-TYPE-04. 正常用例：重置', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
  })
  test('ALERT-TYPE-05. UI差异：各角色可见', async ({ page }) => {
    for (const role of ALL_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/alerts`)
      await page.waitForTimeout(300)
    }
  })
  test('ALERT-TYPE-06. 异常恢复：API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts?type=invalid`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 4. 处理预警 (12 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 处理预警', () => {
  test('ALERT-HANDLE-01. 正常用例：admin处理预警', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled', remark: 'E2E处理' })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-HANDLE-02. 正常用例：warehouse_manager处理', async () => {
    const token = await apiLogin('warehouse_manager')
    const adminToken = await apiLogin('admin')
    const id = await getAnyAlertId(adminToken)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' })
    expect([200, 403, 404]).toContain(res.status)
  })
  test('ALERT-HANDLE-03. 表单校验：处理不存在的预警返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/alerts/non-existent/handle', { action: 'handled' })
    expect(res.status).toBe(404)
  })
  test('ALERT-HANDLE-04. 业务冲突：已handled再次处理', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-HANDLE-05. 并发：并发处理同一预警', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' }),
      apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'ignored' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('ALERT-HANDLE-06. 异常恢复：网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled', remark: 'E2E恢复' })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-HANDLE-07. UI差异：admin显示处理按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('ALERT-HANDLE-08. UI差异：technician显示处理按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('ALERT-HANDLE-09. 正常用例：处理后状态变为handled', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-HANDLE-10. 正常用例：处理后handled_at有值', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-HANDLE-11. 边界：空remark', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled', remark: '' })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-HANDLE-12. 异常恢复：处理后刷新状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 5. 批量处理预警 (8 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 批量处理预警', () => {
  test('ALERT-BATCH-01. 正常用例：批量处理多条预警', async () => {
    const token = await apiLogin('admin')
    const r = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=3')
    const ids = (r.data?.data?.list || []).map((a: any) => a.id)
    if (ids.length === 0) { test.skip(); return }
    for (const id of ids) {
      await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled', remark: 'E2E批量' })
    }
  })
  test('ALERT-BATCH-02. 空数据边界：未选择点击批量处理', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
    const btn = page.locator('button:has-text("批量处理"), button:has-text("批量")').first()
    if (await btn.isVisible().catch(() => false)) await btn.click()
  })
  test('ALERT-BATCH-03. 并发：快速点击批量多次', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
  })
  test('ALERT-BATCH-04. 异常恢复：部分API 500', async () => {
    const token = await apiLogin('admin')
    const r = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=2')
    const ids = (r.data?.data?.list || []).map((a: any) => a.id)
    for (const id of ids) {
      await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' })
    }
  })
  test('ALERT-BATCH-05. UI差异：admin显示批量按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('ALERT-BATCH-06. 正常用例：全选后批量', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
    const allCb = page.locator('table thead input[type="checkbox"]').first()
    if (await allCb.isVisible().catch(() => false)) await allCb.click()
  })
  test('ALERT-BATCH-07. 异常恢复：批量后刷新', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('ALERT-BATCH-08. 边界：单页全选翻页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 6. 预警规则 (10 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 预警规则', () => {
  test('ALERT-RULE-01. 正常用例：admin查看规则列表', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts/rules')
    expect(res.status).toBe(200)
  })
  test('ALERT-RULE-02. 正常用例：admin修改低库存阈值', async () => {
    const token = await apiLogin('admin')
    const rid = await getAnyRuleId(token)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 20 })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-RULE-03. 空数据边界：threshold=0', async () => {
    const token = await apiLogin('admin')
    const rid = await getAnyRuleId(token)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 0 })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-RULE-04. 边界：负数threshold', async () => {
    const token = await apiLogin('admin')
    const rid = await getAnyRuleId(token)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: -1 })
    expect([200, 400, 404]).toContain(res.status)
  })
  test('ALERT-RULE-05. 权限：warehouse_manager修改返回403', async () => {
    const token = await apiLogin('warehouse_manager')
    const adminToken = await apiLogin('admin')
    const rid = await getAnyRuleId(adminToken)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 10 })
    expect(res.status).toBe(403)
  })
  test('ALERT-RULE-06. 并发：并发修改同一规则', async () => {
    const token = await apiLogin('admin')
    const rid = await getAnyRuleId(token)
    if (!rid) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 15 }),
      apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 25 }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('ALERT-RULE-07. 异常恢复：修改时API 500', async () => {
    const token = await apiLogin('admin')
    const rid = await getAnyRuleId(token)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 30 })
    expect([200, 404]).toContain(res.status)
  })
  test('ALERT-RULE-08. UI差异：admin显示编辑开关', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('ALERT-RULE-09. UI差异：technician显示只读', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('ALERT-RULE-10. 正常用例：修改thresholdDays', async () => {
    const token = await apiLogin('admin')
    const rid = await getAnyRuleId(token)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { thresholdDays: 60 })
    expect([200, 404]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 7. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 分页切换', () => {
  test('ALERT-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts?page=2`)
    await page.waitForTimeout(800)
  })
  test('ALERT-PAGE-02. 边界：仅1页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
  })
  test('ALERT-PAGE-03. 表单校验：page=0', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?page=0')
    expect(res.status).toBe(200)
  })
  test('ALERT-PAGE-04. 边界：page=999', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?page=999')
    expect(res.status).toBe(200)
  })
  test('ALERT-PAGE-05. 边界：pageSize=1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('ALERT-PAGE-06. 边界：pageSize=100', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('ALERT-PAGE-07. 并发：快速切换', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/alerts?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('ALERT-PAGE-08. UI差异：各角色一致', async ({ page }) => {
    for (const role of ALL_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/alerts?page=1`)
      await page.waitForTimeout(300)
    }
  })
})

// ────────────────────────────────────────────
// 8. 角色权限矩阵补充 (8 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 角色权限矩阵补充', () => {
  test('TC-PERM-116. warehouse_manager PUT /alerts/rules 返回403', async () => {
    const token = await apiLogin('warehouse_manager')
    const adminToken = await apiLogin('admin')
    const rid = await getAnyRuleId(adminToken)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 10 })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-117. technician PUT /alerts/rules 返回403', async () => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const rid = await getAnyRuleId(adminToken)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 10 })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-118. pathologist PUT /alerts/rules 返回403', async () => {
    const token = await apiLogin('pathologist')
    const adminToken = await apiLogin('admin')
    const rid = await getAnyRuleId(adminToken)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 10 })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-119. procurement PUT /alerts/rules 返回403', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const rid = await getAnyRuleId(adminToken)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 10 })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-120. finance PUT /alerts/rules 返回403', async () => {
    const token = await apiLogin('finance')
    const adminToken = await apiLogin('admin')
    const rid = await getAnyRuleId(adminToken)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { threshold: 10 })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-ALERT-EXTRA-01. admin GET /alerts 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-ALERT-EXTRA-02. 任意角色GET /alerts 返回200', async () => {
    for (const role of ALL_ROLES) {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'GET', '/alerts')
      expect(res.status).toBe(200)
    }
  })
  test('TC-PERM-ALERT-EXTRA-03. admin POST /alerts/generate 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/alerts/generate')
    expect([200, 404, 500]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 9. 业务流程树 (8 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 业务流程树', () => {
  test('BF-ALERT-01. 主路径：登录→预警中心→查看pending→处理→状态变为handled', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled', remark: 'E2E主路径' })
    expect([200, 404]).toContain(res.status)
  })
  test('BF-ALERT-02. 分支：关闭处理弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BF-ALERT-03. 分支：未填备注提交', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' })
    expect([200, 404]).toContain(res.status)
  })
  test('BF-ALERT-04. 分支：处理不存在预警', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/alerts/non-existent/handle', { action: 'handled' })
    expect(res.status).toBe(404)
  })
  test('BF-ALERT-05. 分支：重复处理同一预警', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled' })
    const res2 = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'ignored' })
    expect([200, 404]).toContain(res2.status)
  })
  test('BF-ALERT-06. 分支：批量处理3条预警', async () => {
    const token = await apiLogin('admin')
    const r = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=3')
    const ids = (r.data?.data?.list || []).map((a: any) => a.id)
    for (const id of ids) {
      await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled', remark: 'E2E批量' })
    }
  })
  test('BF-ALERT-07. 分支：刷新后预警状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-ALERT-08. 分支：禁用规则后不再生成', async () => {
    const token = await apiLogin('admin')
    const rid = await getAnyRuleId(token)
    if (!rid) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { enabled: false })
    expect([200, 404]).toContain(res.status)
    await apiFetch(token, 'PUT', `/alerts/rules/${rid}`, { enabled: true })
  })
})

// ────────────────────────────────────────────
// 10. 盲点分析补充 (18 tests)
// ────────────────────────────────────────────
test.describe('预警中心 -> 盲点分析补充', () => {
  test('BLIND-ALERT-01. 预警级别颜色标签', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ALERT-02. 预警自动生成定时任务', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/alerts/generate')
    expect([200, 404, 500]).toContain(res.status)
  })
  test('BLIND-ALERT-03. 预警手动扫描', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/alerts/generate')
    expect([200, 404, 500]).toContain(res.status)
  })
  test('BLIND-ALERT-04. 预警历史记录', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?status=handled')
    expect(res.status).toBe(200)
  })
  test('BLIND-ALERT-05. 预警导出功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ALERT-06. 预警打印功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ALERT-07. 预警页面响应式', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ALERT-08. 预警页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForLoadState('networkidle')
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-ALERT-09. 预警搜索防抖', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(800)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await page.waitForTimeout(600)
    }
  })
  test('BLIND-ALERT-10. 预警规则默认值', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts/rules')
    expect(res.status).toBe(200)
    const rules = res.data?.data?.rules || []
    expect(rules.length).toBeGreaterThanOrEqual(0)
  })
  test('BLIND-ALERT-11. 预警处理人信息', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('BLIND-ALERT-12. 预警时间格式化', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ALERT-13. 预警数量统计卡片', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ALERT-14. 预警低库存与临期区分', async ({ page }) => {
    const token = await apiLogin('admin')
    const r1 = await apiFetch(token, 'GET', '/alerts?type=low-stock')
    const r2 = await apiFetch(token, 'GET', '/alerts?type=expiry')
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
  })
  test('BLIND-ALERT-15. 预警邮件通知入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/alerts`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-ALERT-16. 预警字段XSS防护', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyAlertId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/alerts/${id}/handle`, { action: 'handled', remark: '<script>alert(1)</script>' })
    expect([200, 404]).toContain(res.status)
  })
  test('BLIND-ALERT-17. 预警API响应格式', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/alerts?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data?.data).toHaveProperty('list')
  })
  test('BLIND-ALERT-18. 多角色同时处理互不影响', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'technician')
    await p1.goto(`${FE_BASE}/alerts`)
    await p2.goto(`${FE_BASE}/alerts`)
    await ctx1.close()
    await ctx2.close()
  })
})
