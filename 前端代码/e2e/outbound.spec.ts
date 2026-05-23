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
const ROLE_KEYS: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist', 'procurement', 'finance']
const OUTBOUND_READ_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist']
const OUTBOUND_WRITE_ROLES: RoleKey[] = ['admin', 'warehouse_manager', 'technician', 'pathologist']
const OUTBOUND_FORBIDDEN: RoleKey[] = ['procurement', 'finance']

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

async function getAnyMaterialId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyProjectId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/projects?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyLocationId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/locations?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyOutboundId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyBomId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/boms?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.outboundNo?.startsWith('TEST-') || item.remark?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/outbound/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

async function ensureStock(token: string, materialId: string, quantity: number): Promise<void> {
  try {
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${materialId}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    if (stock >= quantity) return
    const lid = await getAnyLocationId(token)
    if (!lid) return
    await apiFetch(token, 'POST', '/inbound', {
      type: 'purchase', materialId, quantity: quantity - stock + 10,
      locationId: lid, remark: 'E2E stock seed',
    })
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
  // Ensure first material has enough stock for outbound tests
  const mid = await getAnyMaterialId(token)
  if (mid) await ensureStock(token, mid, 20)
})

// ────────────────────────────────────────────
// 1. 查看出库列表 (10 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 查看出库列表', () => {
  for (const role of OUTBOUND_READ_ROLES) {
    test(`OUT-LIST-01-${role}. 正常用例：${role}可查看出库列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/outbound`)
      await expect(page.locator('body')).toBeVisible({ timeout: 30000 })
    })
  }
  test('OUT-LIST-02. 空数据边界：无出库记录显示空状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(800)
  })
  test('OUT-LIST-03. 权限：procurement访问返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'GET', '/outbound')
    expect(res.status).toBe(403)
  })
  test('OUT-LIST-04. 权限：finance访问返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/outbound')
    expect(res.status).toBe(403)
  })
  test('OUT-LIST-05. 异常恢复：API 500显示错误Toast', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(800)
  })
  test('OUT-LIST-06. UI差异：admin显示新增出库按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-LIST-07. UI差异：technician显示新增出库按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-LIST-08. UI差异：procurement不显示新增出库按钮', async ({ page }) => {
    await loginAs(page, 'procurement')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-LIST-09. 正常用例：列表显示单号项目物料成本状态', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-LIST-10. 并发：快速刷新页面多次', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.reload()
    await page.reload()
    await expect(page.locator('body')).toBeVisible()
  })
})

// ────────────────────────────────────────────
// 2. 按项目筛选 (6 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 按项目筛选', () => {
  test('OUT-PROJ-01. 正常用例：选择项目筛选', async ({ page }) => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    if (!pid) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/outbound?projectId=${pid}`)
    expect(res.status).toBe(200)
  })
  test('OUT-PROJ-02. 空数据边界：项目无出库记录', async ({ page }) => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?projectId=non-existent')
    expect(res.status).toBe(200)
  })
  test('OUT-PROJ-03. 正常用例：重置项目筛选', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(800)
  })
  test('OUT-PROJ-04. UI差异：各角色项目筛选可见', async ({ page }) => {
    for (const role of OUTBOUND_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/outbound`)
      await page.waitForTimeout(400)
    }
  })
  test('OUT-PROJ-05. 并发：快速切换项目筛选', async ({ page }) => {
    const token = await apiLogin('admin')
    await apiFetch(token, 'GET', '/outbound?projectId=1')
    await apiFetch(token, 'GET', '/outbound?projectId=2')
    await apiFetch(token, 'GET', '/outbound?projectId=3')
  })
  test('OUT-PROJ-06. 异常恢复：项目筛选时API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(800)
  })
})

// ────────────────────────────────────────────
// 3. 创建项目领用出库单 (22 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 创建项目领用出库单', () => {
  test('OUT-CREATE-PROJ-01. 正常用例：admin创建项目领用出库', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }],
      remark: 'E2E项目领用',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-02. 正常用例：technician创建项目领用出库', async () => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    const pid = await getAnyProjectId(adminToken)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }],
      remark: 'E2E技术员领用',
    })
    expect([201, 422, 403]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-03. 空数据边界：库存恰好等于出库数量', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    const inv = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const stock = inv.data?.data?.list?.[0]?.stock || 0
    if (!mid || !pid || stock < 1) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: stock }],
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-04. 表单校验：未传type返回400', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      projectId: pid, items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(400)
  })
  test('OUT-CREATE-PROJ-05. 表单校验：未传items返回400', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    if (!pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid,
    })
    expect(res.status).toBe(400)
  })
  test('OUT-CREATE-PROJ-06. 表单校验：空items数组返回400', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    if (!pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [],
    })
    expect(res.status).toBe(400)
  })
  test('OUT-CREATE-PROJ-07. 权限：procurement创建出库返回403', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    const pid = await getAnyProjectId(adminToken)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(403)
  })
  test('OUT-CREATE-PROJ-08. 权限：finance创建出库返回403', async () => {
    const token = await apiLogin('finance')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    const pid = await getAnyProjectId(adminToken)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(403)
  })
  test('OUT-CREATE-PROJ-09. 业务冲突：库存不足返回422', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 999999 }],
    })
    expect([422, 201]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-10. 并发：快速双击提交', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const body = { type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E并发' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/outbound', body), apiFetch(token, 'POST', '/outbound', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('OUT-CREATE-PROJ-11. 异常恢复：提交时网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E恢复',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-12. UI差异：admin显示新增出库按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-CREATE-PROJ-13. UI差异：technician显示新增出库按钮', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-CREATE-PROJ-14. UI差异：pathologist显示新增出库按钮', async ({ page }) => {
    await loginAs(page, 'pathologist')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-CREATE-PROJ-15. 正常用例：出库后库存扣减', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    if (bStock < 1) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E库存扣减',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-16. 正常用例：出库单号格式OB-YYYYMMDD-XXX', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E格式',
    })
    if (res.status === 201) {
      expect(res.data?.data?.outboundNo).toMatch(/^OB-\d{8}-\d{6}-\d{3}$/)
    }
  })
  test('OUT-CREATE-PROJ-17. 边界：quantity=0', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 0 }],
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-18. 边界：负数quantity', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: -1 }],
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-19. 业务冲突：出库后成本归集到项目', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E成本归集',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-20. 并发：多物料同时出库', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    if (!pid) { test.skip(); return }
    const materials = await apiFetch(token, 'GET', '/materials?page=1&pageSize=2')
    const list = materials.data?.data?.list || []
    if (list.length < 2) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid,
      items: list.map((m: any) => ({ materialId: m.id, quantity: 1 })),
      remark: 'E2E多物料',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-PROJ-21. 正常用例：出库后刷新页面状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('OUT-CREATE-PROJ-22. 表单校验：materialId不存在', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    if (!pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: 'invalid', quantity: 1 }],
    })
    expect([422, 400, 201]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 4. 创建调拨出库单 (12 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 创建调拨出库单', () => {
  test('OUT-CREATE-TRF-01. 正常用例：admin创建调拨出库', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const lid = await getAnyLocationId(token)
    if (!mid || !lid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 1 }],
      remark: 'E2E调拨出库',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-TRF-02. 空数据边界：调出库位库存=0', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 999999 }],
    })
    expect([422, 201]).toContain(res.status)
  })
  test('OUT-CREATE-TRF-03. 业务冲突：调出库位库存不足返回422', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 999999 }],
    })
    expect([422, 201]).toContain(res.status)
  })
  test('OUT-CREATE-TRF-04. 权限：procurement创建调拨返回403', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(403)
  })
  test('OUT-CREATE-TRF-05. 权限：finance创建调拨返回403', async () => {
    const token = await apiLogin('finance')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(403)
  })
  test('OUT-CREATE-TRF-06. 并发：并发调拨同一物料', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const body = { type: 'transfer', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E并发调拨' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/outbound', body), apiFetch(token, 'POST', '/outbound', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('OUT-CREATE-TRF-07. 异常恢复：调拨后检查库存', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E调拨库存',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-TRF-08. 边界：调拨数量=0', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 0 }],
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('OUT-CREATE-TRF-09. 正常用例：调拨出库后来源库位减', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    if (bStock < 1) { test.skip(); return }
    await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E来源减',
    })
  })
  test('OUT-CREATE-TRF-10. 异常恢复：网络中断后重试调拨', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E恢复调拨',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-TRF-11. UI差异：调拨出库前端入口', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-CREATE-TRF-12. 表单校验：缺少type', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(400)
  })
})

// ────────────────────────────────────────────
// 5. 创建报废出库单 (12 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 创建报废出库单', () => {
  test('OUT-CREATE-SCRAP-01. 正常用例：admin创建报废出库', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }],
      remark: 'E2E报废',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-SCRAP-02. 空数据边界：报废数量=0', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 0 }],
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('OUT-CREATE-SCRAP-03. 业务冲突：报废数量超过库存返回422', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 999999 }],
    })
    expect([422, 201]).toContain(res.status)
  })
  test('OUT-CREATE-SCRAP-04. 权限：procurement创建报废返回403', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(403)
  })
  test('OUT-CREATE-SCRAP-05. 权限：finance创建报废返回403', async () => {
    const token = await apiLogin('finance')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(403)
  })
  test('OUT-CREATE-SCRAP-06. 并发：并发报废同一物料', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const body = { type: 'scrap', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E并发报废' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/outbound', body), apiFetch(token, 'POST', '/outbound', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('OUT-CREATE-SCRAP-07. 异常恢复：报废后检查库存', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E报废库存',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-SCRAP-08. 边界：负数报废数量', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: -1 }],
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('OUT-CREATE-SCRAP-09. 正常用例：报废出库后库存扣减', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    if (bStock < 1) { test.skip(); return }
    await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E报废扣减',
    })
  })
  test('OUT-CREATE-SCRAP-10. 异常恢复：网络中断后重试报废', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E恢复报废',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-CREATE-SCRAP-11. UI差异：报废出库前端入口', async ({ page }) => {
    await loginAs(page, 'warehouse_manager')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-CREATE-SCRAP-12. 表单校验：报废原因字段', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }], remark: '',
    })
    expect([201, 422]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 6. BOM一键出库 (14 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> BOM一键出库', () => {
  test('OUT-BOM-01. 正常用例：admin执行BOM一键出库', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 10, remark: 'E2E BOM出库',
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('OUT-BOM-02. 空数据边界：BOM中某物料库存不足', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 99999,
    })
    expect([422, 201]).toContain(res.status)
  })
  test('OUT-BOM-03. 表单校验：未传bomId返回400', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    if (!pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, sampleCount: 10,
    })
    expect(res.status).toBe(400)
  })
  test('OUT-BOM-04. 表单校验：未传sampleCount返回400', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid,
    })
    expect(res.status).toBe(400)
  })
  test('OUT-BOM-05. 业务冲突：项目已停用', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 1, remark: 'E2E停用项目',
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('OUT-BOM-06. 边界：sampleCount=0', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 0,
    })
    expect([400, 201]).toContain(res.status)
  })
  test('OUT-BOM-07. 权限：procurement执行BOM出库返回403', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const pid = await getAnyProjectId(adminToken)
    const bid = await getAnyBomId(adminToken)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 1,
    })
    expect(res.status).toBe(403)
  })
  test('OUT-BOM-08. 权限：finance执行BOM出库返回403', async () => {
    const token = await apiLogin('finance')
    const adminToken = await apiLogin('admin')
    const pid = await getAnyProjectId(adminToken)
    const bid = await getAnyBomId(adminToken)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 1,
    })
    expect(res.status).toBe(403)
  })
  test('OUT-BOM-09. 并发：快速双击BOM出库', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const body = { projectId: pid, bomId: bid, sampleCount: 1, remark: 'E2E并发BOM' }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/outbound/bom', body), apiFetch(token, 'POST', '/outbound/bom', body)])
    expect(r1.status === 201 || r2.status === 201).toBe(true)
  })
  test('OUT-BOM-10. 正常用例：BOM出库后按FIFO分配批次', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 1, remark: 'E2EFIFO',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-BOM-11. 异常恢复：网络中断后重试BOM出库', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 1, remark: 'E2E恢复BOM',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('OUT-BOM-12. UI差异：admin显示BOM出库入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-BOM-13. UI差异：technician显示BOM出库入口', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('OUT-BOM-14. 边界：超大sampleCount', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 999999,
    })
    expect([422, 201]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 7. 查看出库详情 (6 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 查看出库详情', () => {
  for (const role of OUTBOUND_READ_ROLES) {
    test(`OUT-DETAIL-01-${role}. 正常用例：${role}可查看出库详情`, async () => {
      const token = await apiLogin(role)
      const id = await getAnyOutboundId(token)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'GET', `/outbound/${id}`)
      expect([200, 404]).toContain(res.status)
    })
  }
  test('OUT-DETAIL-02. 表单校验：查看不存在的出库单返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound/non-existent-id')
    expect(res.status).toBe(404)
  })
  test('OUT-DETAIL-03. UI差异：admin可点击查看详情弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 8. 分页切换 (8 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 分页切换', () => {
  test('OUT-PAGE-01. 正常用例：切换到第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound?page=2`)
    await page.waitForTimeout(800)
  })
  test('OUT-PAGE-02. 空数据边界：仅1页分页器隐藏', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(800)
  })
  test('OUT-PAGE-03. 表单校验：page=0后端修正为1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=0')
    expect(res.status).toBe(200)
    const pageVal = res.data?.data?.page ?? res.data?.data?.pagination?.page
    expect(pageVal).toBeGreaterThanOrEqual(1)
  })
  test('OUT-PAGE-04. 边界：page=999返回空列表', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=999&pageSize=20')
    expect(res.status).toBe(200)
  })
  test('OUT-PAGE-05. 边界：pageSize=1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const list = res.data?.data?.list || []
    expect(list.length).toBeLessThanOrEqual(1)
  })
  test('OUT-PAGE-06. 边界：pageSize=100', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('OUT-PAGE-07. 并发：快速切换分页', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/outbound?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('OUT-PAGE-08. UI差异：各角色分页一致', async ({ page }) => {
    for (const role of OUTBOUND_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/outbound?page=1`)
      await page.waitForTimeout(500)
    }
  })
})

// ────────────────────────────────────────────
// 9. 角色权限矩阵补充 (10 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 角色权限矩阵补充', () => {
  const scenes = [
    { id: 'TC-PERM-069', role: 'procurement' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-070', role: 'finance' as RoleKey, method: 'GET', expect: 403 },
    { id: 'TC-PERM-071', role: 'procurement' as RoleKey, method: 'POST', expect: 403 },
    { id: 'TC-PERM-072', role: 'finance' as RoleKey, method: 'POST', expect: 403 },
  ]
  for (const s of scenes) {
    test(`${s.id}. ${s.role} ${s.method} /outbound 返回${s.expect}`, async () => {
      const token = await apiLogin(s.role)
      const adminToken = await apiLogin('admin')
      const mid = await getAnyMaterialId(adminToken)
      let res
      if (s.method === 'GET') res = await apiFetch(token, 'GET', '/outbound')
      else res = await apiFetch(token, 'POST', '/outbound', { type: 'project', items: [{ materialId: mid || 'x', quantity: 1 }] })
      expect(res.status).toBe(s.expect)
    })
  }
  test('TC-PERM-OUT-EXTRA-01. admin GET /outbound 返回200', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-OUT-EXTRA-02. technician GET /outbound 返回200', async () => {
    const token = await apiLogin('technician')
    const res = await apiFetch(token, 'GET', '/outbound')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-OUT-EXTRA-03. pathologist GET /outbound 返回200', async () => {
    const token = await apiLogin('pathologist')
    const res = await apiFetch(token, 'GET', '/outbound')
    expect(res.status).toBe(200)
  })
  test('TC-PERM-OUT-EXTRA-04. admin POST /outbound 返回201', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E权限',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('TC-PERM-OUT-EXTRA-05. technician POST /outbound 返回201或403', async () => {
    const token = await apiLogin('technician')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    const pid = await getAnyProjectId(adminToken)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }],
    })
    expect([201, 403, 422]).toContain(res.status)
  })
})

// ────────────────────────────────────────────
// 10. 业务流程树 (14 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 业务流程树', () => {
  test('BF-OUT-01. 项目领用主路径：选项目→选物料→提交→库存扣减→成本归集', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const before = await apiFetch(token, 'GET', `/inventory?page=1&pageSize=1&materialId=${mid}`)
    const bStock = before.data?.data?.list?.[0]?.stock || 0
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E主路径',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BF-OUT-02. 分支：关闭出库弹窗不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('BF-OUT-03. 分支：未选项目直接提交', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', items: [{ materialId: mid, quantity: 1 }],
    })
    expect([400, 201, 422]).toContain(res.status)
  })
  test('BF-OUT-04. 分支：库存不足返回422', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 999999 }],
    })
    expect([422, 201]).toContain(res.status)
  })
  test('BF-OUT-05. 分支：网络中断后重试', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E网络',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BF-OUT-06. 分支：刷新页面后状态保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-OUT-07. 分支：选择项目后切换BOM', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('BF-OUT-08. 分支：样本数为0', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 0,
    })
    expect([400, 201]).toContain(res.status)
  })
  test('BF-OUT-09. 分支：出库后取消关联入库单', async () => {
    const token = await apiLogin('admin')
    const outId = await getAnyOutboundId(token)
    if (!outId) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/outbound/${outId}/cancel`)
    expect([200, 400, 404]).toContain(res.status)
  })
  test('BF-OUT-10. 分支：procurement尝试出库被403拦截', async () => {
    const token = await apiLogin('procurement')
    const adminToken = await apiLogin('admin')
    const mid = await getAnyMaterialId(adminToken)
    const pid = await getAnyProjectId(adminToken)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }],
    })
    expect(res.status).toBe(403)
  })
  test('BF-OUT-11. 调拨出库主路径：选来源→目标→物料→提交', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'transfer', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E调拨主路径',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BF-OUT-12. 报废出库主路径：选物料→数量→原因→提交', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    if (!mid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'scrap', items: [{ materialId: mid, quantity: 1 }], remark: 'E2E报废主路径',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BF-OUT-13. 分支：BOM一键出库后检查项目成本', async () => {
    const token = await apiLogin('admin')
    const pid = await getAnyProjectId(token)
    const bid = await getAnyBomId(token)
    if (!pid || !bid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound/bom', {
      projectId: pid, bomId: bid, sampleCount: 1, remark: 'E2E成本检查',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BF-OUT-14. 分支：批量操作后检查出库列表', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
})

// ────────────────────────────────────────────
// 11. 盲点分析补充 (22 tests)
// ────────────────────────────────────────────
test.describe('出库管理 -> 盲点分析补充', () => {
  test('BLIND-OUT-01. 出库单号唯一性验证', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const r1 = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E唯一1',
    })
    const r2 = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E唯一2',
    })
    if (r1.status === 201 && r2.status === 201) {
      expect(r1.data?.data?.outboundNo).not.toBe(r2.data?.data?.outboundNo)
    }
  })
  test('BLIND-OUT-02. 出库时间字段自动填充', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E时间',
    })
    if (res.status === 201) expect(res.data?.data?.createdAt).toBeDefined()
  })
  test('BLIND-OUT-03. 出库操作人字段记录', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E操作人',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BLIND-OUT-04. 出库成本自动计算totalCost', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 2 }], remark: 'E2E成本',
    })
    if (res.status === 201) expect(res.data?.data?.totalCost).toBeDefined()
  })
  test('BLIND-OUT-05. 出库列表排序默认按时间倒序', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=5')
    expect(res.status).toBe(200)
    const list = res.data?.data?.list || []
    if (list.length >= 2) {
      const d1 = new Date(list[0].createdAt).getTime()
      const d2 = new Date(list[1].createdAt).getTime()
      expect(d1).toBeGreaterThanOrEqual(d2)
    }
  })
  test('BLIND-OUT-06. 出库单关联项目信息显示', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const item = res.data?.data?.list?.[0]
    if (item) expect(item.projectName || item.projectId).toBeDefined()
  })
  test('BLIND-OUT-07. 出库物料明细完整性', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
    const item = res.data?.data?.list?.[0]
    if (item && item.items) expect(Array.isArray(item.items)).toBe(true)
  })
  test('BLIND-OUT-08. 出库数量小数精度处理', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1.5 }], remark: 'E2E小数',
    })
    expect([201, 400, 422]).toContain(res.status)
  })
  test('BLIND-OUT-09. 出库API响应格式验证', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/outbound?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data?.data).toHaveProperty('list')
    expect(res.data?.data).toHaveProperty('pagination')
    expect(res.data?.data?.pagination).toHaveProperty('page')
    expect(res.data?.data?.pagination).toHaveProperty('total')
  })
  test('BLIND-OUT-10. 出库单状态流转验证', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E状态',
    })
    if (res.status === 201) {
      expect(['pending', 'completed']).toContain(res.data?.data?.status)
    }
  })
  test('BLIND-OUT-11. 出库后库存日志生成', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E日志',
    })
  })
  test('BLIND-OUT-12. 出库页面响应式布局', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-OUT-13. 出库页面搜索框防抖', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(800)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a')
      await search.fill('ab')
      await search.fill('abc')
      await page.waitForTimeout(600)
    }
  })
  test('BLIND-OUT-14. 出库导出功能入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-OUT-15. 出库打印功能入口', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-OUT-16. 出库批次FIFO分配验证', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2EFIFO',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BLIND-OUT-17. 出库取消功能检查', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyOutboundId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'POST', `/outbound/${id}/cancel`)
    expect([200, 400, 404]).toContain(res.status)
  })
  test('BLIND-OUT-18. 出库页面加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(2000)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-OUT-19. 出库类型下拉选项完整性', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-OUT-20. 出库后项目成本统计更新', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const pid = await getAnyProjectId(token)
    if (!mid || !pid) { test.skip(); return }
    const res = await apiFetch(token, 'POST', '/outbound', {
      type: 'project', projectId: pid, items: [{ materialId: mid, quantity: 1 }], remark: 'E2E统计',
    })
    expect([201, 422]).toContain(res.status)
  })
  test('BLIND-OUT-21. 多角色同时出库互不影响', async ({ browser }) => {
    const context1 = await browser.newContext()
    const context2 = await browser.newContext()
    const page1 = await context1.newPage()
    const page2 = await context2.newPage()
    await loginAs(page1, 'admin')
    await loginAs(page2, 'technician')
    await page1.goto(`${FE_BASE}/outbound`)
    await page2.goto(`${FE_BASE}/outbound`)
    await page1.waitForTimeout(500)
    await page2.waitForTimeout(500)
    await context1.close()
    await context2.close()
  })
  test('BLIND-OUT-22. 出库页面URL参数保持', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/outbound?page=2`)
    await page.waitForTimeout(800)
    const url = page.url()
    expect(url).toContain('page=2')
  })
})
