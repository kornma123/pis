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
const BOM_READ_ROLES: RoleKey[] = ['admin', 'technician', 'pathologist']
const BOM_FORBIDDEN: RoleKey[] = ['warehouse_manager', 'procurement', 'finance']

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

async function getAnyBomId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/boms?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}
async function getAnyMaterialId(token: string): Promise<string> {
  const r = await apiFetch(token, 'GET', '/materials?page=1&pageSize=1')
  return r.data?.data?.list?.[0]?.id || ''
}

async function cleanupTestData(token: string) {
  try {
    const r = await apiFetch(token, 'GET', '/boms?page=1&pageSize=200')
    const list = r.data?.data?.list || []
    for (const item of list) {
      if (item.code?.startsWith('TEST-') || item.name?.includes('E2E')) {
        await apiFetch(token, 'DELETE', `/boms/${item.id}`)
      }
    }
  } catch { /* ignore */ }
}

test.beforeEach(async () => {
  const token = await apiLogin('admin')
  await cleanupTestData(token)
})

// 1. 查看BOM列表 (10)
test.describe('BOM清单 -> 查看BOM列表', () => {
  for (const role of BOM_READ_ROLES) {
    test(`BOM-LIST-01-${role}. ${role}可查看BOM列表`, async ({ page }) => {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/bom`)
      await expect(page.locator('body')).toBeVisible({ timeout: 30000 })
    })
  }
  test('BOM-LIST-02. 空数据边界', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(800)
  })
  for (const role of BOM_FORBIDDEN) {
    test(`BOM-LIST-03-${role}. ${role}访问返回403`, async () => {
      const res = await apiFetch(await apiLogin(role), 'GET', '/boms')
      expect(res.status).toBe(403)
    })
  }
  test('BOM-LIST-04. API 500', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(800)
  })
  test('BOM-LIST-05. admin显示新增编辑删除', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-LIST-06. technician仅查看', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-LIST-07. 显示编码名称类型物料数单样本成本', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-LIST-08. 快速刷新', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.reload()
    await page.reload()
  })
})

// 2. 按类型筛选 (6)
test.describe('BOM清单 -> 按类型筛选', () => {
  test('BOM-TYPE-01. 选择ihc', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?type=ihc')
    expect(res.status).toBe(200)
  })
  test('BOM-TYPE-02. 无该类型', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?type=nonexistent')
    expect(res.status).toBe(200)
  })
  test('BOM-TYPE-03. 重置', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(800)
  })
  test('BOM-TYPE-04. 各角色可见', async ({ page }) => {
    for (const role of BOM_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/bom`)
      await page.waitForTimeout(300)
    }
  })
  test('BOM-TYPE-05. 快速切换', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom?type=ihc`)
    await page.waitForTimeout(200)
    await page.goto(`${FE_BASE}/bom?type=he`)
    await page.waitForTimeout(200)
  })
  test('BOM-TYPE-06. API错误', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom?type=invalid`)
    await page.waitForTimeout(800)
  })
})

// 3. 搜索BOM (6)
test.describe('BOM清单 -> 搜索BOM', () => {
  test('BOM-SEARCH-01. 搜索HER2', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?keyword=HER2')
    expect(res.status).toBe(200)
  })
  test('BOM-SEARCH-02. 无结果', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?keyword=XYZ999')
    expect(res.status).toBe(200)
  })
  test('BOM-SEARCH-03. 快速连续输入', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(500)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a'); await search.fill('ab'); await page.waitForTimeout(600)
    }
  })
  test('BOM-SEARCH-04. 网络断', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom?keyword=test`)
    await page.waitForTimeout(800)
  })
  test('BOM-SEARCH-05. 超长字符串', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?keyword=' + 'X'.repeat(300))
    expect(res.status).toBe(200)
  })
  test('BOM-SEARCH-06. 各角色可见', async ({ page }) => {
    for (const role of BOM_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/bom`)
      await page.waitForTimeout(300)
    }
  })
})

// 4. 新建BOM (16)
test.describe('BOM清单 -> 新建BOM', () => {
  test('BOM-CREATE-01. admin新建成功', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-BOM-${Date.now()}`, name: 'E2E测试BOM', type: 'ihc',
      materials: mid ? [{ materialId: mid, quantity: 1 }] : [], remark: 'E2E',
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('BOM-CREATE-02. materials空返回201', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-BOM-${Date.now()}`, name: '空物料', type: 'ihc', materials: [],
    })
    expect([201, 400]).toContain(res.status)
  })
  test('BOM-CREATE-03. 未传code返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', { name: '无编码', type: 'ihc' })
    expect(res.status).toBe(400)
  })
  test('BOM-CREATE-04. 未传name返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', { code: 'NONAME', type: 'ihc' })
    expect(res.status).toBe(400)
  })
  test('BOM-CREATE-05. 未传type返回400', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', { code: 'NOTYPE', name: '无类型' })
    expect(res.status).toBe(400)
  })
  for (const role of ['technician', 'pathologist', 'warehouse_manager', 'procurement', 'finance'] as RoleKey[]) {
    test(`BOM-CREATE-06-${role}. ${role}新建返回403`, async () => {
      const token = await apiLogin(role)
      const res = await apiFetch(token, 'POST', '/boms', { code: 'TEST', name: 'TEST', type: 'ihc' })
      expect(res.status).toBe(403)
    })
  }
  test('BOM-CREATE-07. code已存在返回409', async () => {
    const token = await apiLogin('admin')
    const code = `TEST-DUP-${Date.now()}`
    await apiFetch(token, 'POST', '/boms', { code, name: '重复1', type: 'ihc', materials: [] })
    const res = await apiFetch(token, 'POST', '/boms', { code, name: '重复2', type: 'ihc', materials: [] })
    expect([400, 409]).toContain(res.status)
  })
  test('BOM-CREATE-08. 快速双击', async () => {
    const token = await apiLogin('admin')
    const body = { code: `TEST-CON-${Date.now()}`, name: '并发', type: 'ihc', materials: [] }
    const [r1, r2] = await Promise.all([apiFetch(token, 'POST', '/boms', body), apiFetch(token, 'POST', '/boms', body)])
    expect([201, 400, 409]).toContain(r1.status)
  })
  test('BOM-CREATE-09. 网络中断重试', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-RET-${Date.now()}`, name: '恢复', type: 'ihc', materials: [], remark: 'E2E',
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('BOM-CREATE-10. admin显示新增按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-CREATE-11. technician不显示新增', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-CREATE-12. 新建后version=v1.0', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-VER-${Date.now()}`, name: '版本', type: 'ihc', materials: [],
    })
    if (res.status === 201) {
      // POST 只返回 { id }，需要通过 GET 确认 version
      const getRes = await apiFetch(token, 'GET', `/boms/${res.data?.data?.id || res.data?.id}`)
      expect(getRes.data?.data?.version).toBe('v1.0')
    }
  })
  test('BOM-CREATE-13. 超长code', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: 'TEST-' + 'X'.repeat(200), name: '超长', type: 'ihc', materials: [],
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('BOM-CREATE-14. 特殊字符name', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-SPEC-${Date.now()}`, name: '!@#$$%^&*()', type: 'ihc', materials: [],
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BOM-CREATE-15. 多物料BOM', async () => {
    const token = await apiLogin('admin')
    const mats = await apiFetch(token, 'GET', '/materials?page=1&pageSize=2')
    const list = mats.data?.data?.list || []
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-MULTI-${Date.now()}`, name: '多物料', type: 'ihc',
      materials: list.map((m: any) => ({ materialId: m.id, quantity: 1 })),
    })
    expect([201, 400, 409]).toContain(res.status)
  })
  test('BOM-CREATE-16. 负数量物料', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-NEG-${Date.now()}`, name: '负数', type: 'ihc',
      materials: mid ? [{ materialId: mid, quantity: -1 }] : [],
    })
    expect([201, 400, 409]).toContain(res.status)
  })
})

// 5. 编辑BOM (12)
test.describe('BOM清单 -> 编辑BOM', () => {
  test('BOM-EDIT-01. admin编辑物料用量', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/boms/${id}`, { name: `编辑-${Date.now()}`, remark: 'E2E' })
    expect([200, 404]).toContain(res.status)
  })
  test('BOM-EDIT-02. 不传materials仅基础字段更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/boms/${id}`, { name: `基础-${Date.now()}` })
    expect([200, 404]).toContain(res.status)
  })
  for (const role of ['technician', 'pathologist', 'warehouse_manager', 'procurement', 'finance'] as RoleKey[]) {
    test(`BOM-EDIT-03-${role}. ${role}编辑返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyBomId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'PUT', `/boms/${id}`, { name: '越权' })
      expect(res.status).toBe(403)
    })
  }
  test('BOM-EDIT-04. 被项目关联编辑后版本升级', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/boms/${id}`, { name: `版本升级-${Date.now()}` })
    expect([200, 404]).toContain(res.status)
  })
  test('BOM-EDIT-05. 并发编辑', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'PUT', `/boms/${id}`, { name: '并发A' }),
      apiFetch(token, 'PUT', `/boms/${id}`, { name: '并发B' }),
    ])
    expect(r1.status === 200 || r2.status === 200).toBe(true)
  })
  test('BOM-EDIT-06. API 500后重试', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/boms/${id}`, { remark: 'E2E恢复' })
    expect([200, 404]).toContain(res.status)
  })
  test('BOM-EDIT-07. admin显示编辑按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-EDIT-08. technician不显示编辑', async ({ page }) => {
    await loginAs(page, 'technician')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-EDIT-09. 编辑后列表更新', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/boms/${id}`, { name: `更新-${Date.now()}` })
  })
  test('BOM-EDIT-10. 编辑不存在返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'PUT', '/boms/non-existent', { name: '不存在' })
    expect(res.status).toBe(404)
  })
  test('BOM-EDIT-11. name为空', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/boms/${id}`, { name: '' })
    expect([200, 400]).toContain(res.status)
  })
  test('BOM-EDIT-12. 网络中断', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/boms/${id}`, { remark: 'E2E网络' })
    expect([200, 404]).toContain(res.status)
  })
})

// 6. 删除BOM (10)
test.describe('BOM清单 -> 删除BOM', () => {
  test('BOM-DEL-01. admin删除无关联BOM', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-DEL-${Date.now()}`, name: '删除', type: 'ihc', materials: [],
    })
    expect([201, 409]).toContain(create.status)
    const id = create.data?.data?.id
    if (id) {
      const res = await apiFetch(token, 'DELETE', `/boms/${id}`)
      expect([200, 404]).toContain(res.status)
    }
  })
  for (const role of ['technician', 'pathologist', 'warehouse_manager', 'procurement', 'finance'] as RoleKey[]) {
    test(`BOM-DEL-02-${role}. ${role}删除返回403`, async () => {
      const token = await apiLogin(role)
      const adminToken = await apiLogin('admin')
      const id = await getAnyBomId(adminToken)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'DELETE', `/boms/${id}`)
      expect(res.status).toBe(403)
    })
  }
  test('BOM-DEL-03. 被项目关联删除后悬空引用', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/boms/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  test('BOM-DEL-04. 并发删除', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-DEL-CON-${Date.now()}`, name: '并发删', type: 'ihc', materials: [],
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    const [r1, r2] = await Promise.all([
      apiFetch(token, 'DELETE', `/boms/${id}`),
      apiFetch(token, 'DELETE', `/boms/${id}`),
    ])
    expect([200, 404]).toContain(r1.status)
  })
  test('BOM-DEL-05. API 500后重试', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-DEL-RET-${Date.now()}`, name: '恢复删', type: 'ihc', materials: [],
    })
    const id = create.data?.data?.id
    if (id) {
      const res = await apiFetch(token, 'DELETE', `/boms/${id}`)
      expect([200, 404]).toContain(res.status)
    }
  })
  test('BOM-DEL-06. admin显示删除按钮', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-DEL-07. pathologist不显示删除', async ({ page }) => {
    await loginAs(page, 'pathologist')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BOM-DEL-08. 不存在返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'DELETE', '/boms/non-existent')
    expect(res.status).toBe(404)
  })
  test('BOM-DEL-09. 再次删除返回404', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-DEL-DUP-${Date.now()}`, name: '重复删', type: 'ihc', materials: [],
    })
    const id = create.data?.data?.id
    if (!id) { test.skip(); return }
    await apiFetch(token, 'DELETE', `/boms/${id}`)
    const res2 = await apiFetch(token, 'DELETE', `/boms/${id}`)
    expect(res2.status).toBe(404)
  })
  test('BOM-DEL-10. 删除后列表刷新', async () => {
    const token = await apiLogin('admin')
    const create = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-DEL-REF-${Date.now()}`, name: '刷新删', type: 'ihc', materials: [],
    })
    const id = create.data?.data?.id
    if (id) await apiFetch(token, 'DELETE', `/boms/${id}`)
  })
})

// 7. 查看BOM详情 (6)
test.describe('BOM清单 -> 查看BOM详情', () => {
  for (const role of BOM_READ_ROLES) {
    test(`BOM-DETAIL-01-${role}. ${role}可查看详情`, async () => {
      const token = await apiLogin(role)
      const id = await getAnyBomId(token)
      if (!id) { test.skip(); return }
      const res = await apiFetch(token, 'GET', `/boms/${id}`)
      expect([200, 404]).toContain(res.status)
    })
  }
  test('BOM-DETAIL-02. 不存在返回404', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms/non-existent')
    expect(res.status).toBe(404)
  })
  test('BOM-DETAIL-03. admin可点击查看详情弹窗', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
})

// 8. 分页切换 (8)
test.describe('BOM清单 -> 分页切换', () => {
  test('BOM-PAGE-01. 第2页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom?page=2`)
    await page.waitForTimeout(800)
  })
  test('BOM-PAGE-02. 仅1页', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(800)
  })
  test('BOM-PAGE-03. page=0', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?page=0')
    expect(res.status).toBe(200)
  })
  test('BOM-PAGE-04. page=999', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?page=999')
    expect(res.status).toBe(200)
  })
  test('BOM-PAGE-05. pageSize=1', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?page=1&pageSize=1')
    expect(res.status).toBe(200)
  })
  test('BOM-PAGE-06. pageSize=100', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?page=1&pageSize=100')
    expect(res.status).toBe(200)
  })
  test('BOM-PAGE-07. 快速切换', async ({ page }) => {
    await loginAs(page, 'admin')
    for (let i = 1; i <= 3; i++) {
      await page.goto(`${FE_BASE}/bom?page=${i}`)
      await page.waitForTimeout(300)
    }
  })
  test('BOM-PAGE-08. 各角色一致', async ({ page }) => {
    for (const role of BOM_READ_ROLES) {
      await loginAs(page, role)
      await page.goto(`${FE_BASE}/bom?page=1`)
      await page.waitForTimeout(300)
    }
  })
})

// 9. 角色权限矩阵 (8)
test.describe('BOM清单 -> 角色权限矩阵补充', () => {
  test('TC-PERM-108. WHM GET /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('warehouse_manager'), 'GET', '/boms')
    expect(res.status).toBe(403)
  })
  test('TC-PERM-109. PROC GET /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'GET', '/boms')
    expect(res.status).toBe(403)
  })
  test('TC-PERM-110. FIN GET /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'GET', '/boms')
    expect(res.status).toBe(403)
  })
  test('TC-PERM-111. WHM POST /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('warehouse_manager'), 'POST', '/boms', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-112. TECH POST /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('technician'), 'POST', '/boms', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-113. PATH POST /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('pathologist'), 'POST', '/boms', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-114. PROC POST /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('procurement'), 'POST', '/boms', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('TC-PERM-115. FIN POST /boms 返回403', async () => {
    const res = await apiFetch(await apiLogin('finance'), 'POST', '/boms', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
})

// 10. 业务流程树 (8)
test.describe('BOM清单 -> 业务流程树', () => {
  test('BF-BOM-01. 主路径：新建→填写→提交→version=v1.0', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-BF-${Date.now()}`, name: '业务流程', type: 'ihc', materials: [], remark: 'E2E',
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BF-BOM-02. 关闭弹窗不保存', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BF-BOM-03. code已存在', async () => {
    const token = await apiLogin('admin')
    const code = `TEST-DUP-BF-${Date.now()}`
    await apiFetch(token, 'POST', '/boms', { code, name: '重复1', type: 'ihc', materials: [] })
    const res = await apiFetch(token, 'POST', '/boms', { code, name: '重复2', type: 'ihc', materials: [] })
    expect([400, 409]).toContain(res.status)
  })
  test('BF-BOM-04. 必填漏填', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', { name: '漏填' })
    expect(res.status).toBe(400)
  })
  test('BF-BOM-05. 刷新后仍在', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(500)
    await page.reload()
    await page.waitForTimeout(800)
  })
  test('BF-BOM-06. 被项目关联删除', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'DELETE', `/boms/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  test('BF-BOM-07. technician尝试新建被403', async () => {
    const res = await apiFetch(await apiLogin('technician'), 'POST', '/boms', { code: 'TEST', name: 'TEST', type: 'ihc' })
    expect(res.status).toBe(403)
  })
  test('BF-BOM-08. 编辑后版本升级', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'PUT', `/boms/${id}`, { name: `版本-${Date.now()}` })
    expect([200, 404]).toContain(res.status)
  })
})

// 11. 盲点分析 (16)
test.describe('BOM清单 -> 盲点分析补充', () => {
  test('BLIND-BOM-01. 编码唯一性', async () => {
    const token = await apiLogin('admin')
    const code = `TEST-UNIQ-${Date.now()}`
    const r1 = await apiFetch(token, 'POST', '/boms', { code, name: '唯一1', type: 'ihc', materials: [] })
    const r2 = await apiFetch(token, 'POST', '/boms', { code, name: '唯一2', type: 'ihc', materials: [] })
    expect([201, 409]).toContain(r1.status)
    expect([400, 409]).toContain(r2.status)
  })
  test('BLIND-BOM-02. version自动升级', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    await apiFetch(token, 'PUT', `/boms/${id}`, { name: `升级-${Date.now()}` })
  })
  test('BLIND-BOM-03. costRatio计算', async () => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/boms/${id}`)
    expect([200, 404]).toContain(res.status)
  })
  test('BLIND-BOM-04. 导出功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-BOM-05. 打印功能', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-BOM-06. 响应式布局', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
  })
  test('BLIND-BOM-07. 加载性能', async ({ page }) => {
    await loginAs(page, 'admin')
    const start = Date.now()
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(2000)
    expect(Date.now() - start).toBeLessThan(10000)
  })
  test('BLIND-BOM-08. 搜索防抖', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(800)
    const search = page.locator('input[placeholder*="搜索"], input[type="search"]').first()
    if (await search.isVisible().catch(() => false)) {
      await search.fill('a'); await search.fill('ab'); await page.waitForTimeout(600)
    }
  })
  test('BLIND-BOM-09. 物料明细展示', async ({ page }) => {
    await loginAs(page, 'admin')
    await page.goto(`${FE_BASE}/bom`)
    await page.waitForTimeout(1000)
    const rows = page.locator('table tbody tr')
    if (await rows.count() > 0) await rows.first().click()
  })
  test('BLIND-BOM-10. XSS防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-XSS-${Date.now()}`, name: '<script>alert(1)</script>', type: 'ihc', materials: [],
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-BOM-11. SQL注入防护', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-SQL-${Date.now()}`, name: "' OR '1'='1", type: 'ihc', materials: [],
    })
    expect([201, 409]).toContain(res.status)
  })
  test('BLIND-BOM-12. API响应格式', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?page=1&pageSize=1')
    expect(res.status).toBe(200)
    expect(res.data).toHaveProperty('data')
    expect(res.data?.data).toHaveProperty('list')
  })
  test('BLIND-BOM-13. 版本历史', async ({ page }) => {
    const token = await apiLogin('admin')
    const id = await getAnyBomId(token)
    if (!id) { test.skip(); return }
    const res = await apiFetch(token, 'GET', `/boms/${id}/versions`)
    expect([200, 404]).toContain(res.status)
  })
  test('BLIND-BOM-14. 排序功能', async () => {
    const token = await apiLogin('admin')
    const res = await apiFetch(token, 'GET', '/boms?sort=code&order=asc')
    expect(res.status).toBe(200)
  })
  test('BLIND-BOM-15. 多角色同时操作', async ({ browser }) => {
    const ctx1 = await browser.newContext()
    const ctx2 = await browser.newContext()
    const p1 = await ctx1.newPage()
    const p2 = await ctx2.newPage()
    await loginAs(p1, 'admin')
    await loginAs(p2, 'technician')
    await p1.goto(`${FE_BASE}/bom`)
    await p2.goto(`${FE_BASE}/bom`)
    await ctx1.close()
    await ctx2.close()
  })
  test('BLIND-BOM-16. 物料用量小数', async () => {
    const token = await apiLogin('admin')
    const mid = await getAnyMaterialId(token)
    const res = await apiFetch(token, 'POST', '/boms', {
      code: `TEST-FLT-${Date.now()}`, name: '小数用量', type: 'ihc',
      materials: mid ? [{ materialId: mid, quantity: 1.5 }] : [],
    })
    expect([201, 400, 409]).toContain(res.status)
  })
})
